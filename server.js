// server.js - Trợ lý ảo nội bộ Intimex Đắk Mil
// 4 phần: (1) Giới thiệu, (2) Nhân sự, (3) Quy trình, (4) Số liệu & phân tích

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const OpenAI = require("openai");

// ===== KIỂM TRA API KEY ==================================================

if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is missing.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== CẤU HÌNH GIỚI HẠN & RETRY OPENAI =================================

// Giới hạn số request gửi đồng thời tới OpenAI
const OPENAI_MAX_CONCURRENT = 2;
let openaiCurrentRunning = 0;

// Hỗ trợ giới hạn concurrency
async function withOpenAIConcurrencyLimit(fn) {
  while (openaiCurrentRunning >= OPENAI_MAX_CONCURRENT) {
    // chờ 150ms rồi kiểm tra lại
    await new Promise((r) => setTimeout(r, 150));
  }
  openaiCurrentRunning++;
  try {
    return await fn();
  } finally {
    openaiCurrentRunning--;
  }
}

// Gọi OpenAI kèm retry + exponential backoff nếu gặp 429
async function callOpenAIWithRetry(payload, retries = 3, delayMs = 1000) {
  try {
    return await client.responses.create(payload);
  } catch (err) {
    if (
      (err.status === 429 || err.code === "rate_limit_exceeded") &&
      retries > 0
    ) {
      console.warn(`OpenAI 429, retry sau ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      return callOpenAIWithRetry(payload, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

// ===== APP CƠ BẢN =======================================================

const app = express();
app.use(cors());
app.use(express.json());

// ===== THƯ MỤC LƯU FILE DOWNLOAD ========================================

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// Tạo thư mục downloads nếu chưa có
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Cho phép tải file tĩnh trong thư mục /downloads
app.use("/downloads", express.static(DOWNLOAD_DIR));

// ===== LOAD assistant.yaml ==============================================

const ASSISTANT_CONFIG_PATH = path.join(__dirname, "config", "assistant.yaml");

let assistantConfig = {};
try {
  assistantConfig = yaml.load(fs.readFileSync(ASSISTANT_CONFIG_PATH, "utf8"));
  console.log("Đã load assistant config từ", ASSISTANT_CONFIG_PATH);
} catch (e) {
  console.warn(
    "Không đọc được config/assistant.yaml, dùng cấu hình mặc định. Lỗi:",
    e.message
  );
  assistantConfig = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_output_tokens: 900,
    system_prompt:
      "Bạn là trợ lý ảo nội bộ Intimex Đắk Mil, hỗ trợ công ty, nhân sự, quy trình, số liệu.",
  };
}

// ===== CSV GIỚI THIỆU CÔNG TY (PHẦN 1) ================================

const COMPANY_INTRO_CSV_URL =
  "https://intimexdakmil.com/public_html/data/gioithieu.csv";

let introCache = { rows: [], loadedAt: 0 };
const INTRO_TTL_MS = 10 * 60 * 1000; // 10 phút

async function getCompanyIntroRows() {
  const now = Date.now();

  if (introCache.rows.length && now - introCache.loadedAt < INTRO_TTL_MS) {
    return introCache.rows;
  }

  console.log("Đang tải CSV giới thiệu công ty từ:", COMPANY_INTRO_CSV_URL);

  const res = await axios.get(COMPANY_INTRO_CSV_URL, {
    responseType: "text",
    timeout: 8000,
  });

  const records = parse(res.data, {
    columns: true,
    skip_empty_lines: true,
  });

  introCache = {
    rows: records,
    loadedAt: now,
  };

  console.log("Đã nạp CSV giới thiệu công ty:", records.length, "dòng");
  return records;
}

// ===== CSV NHÂN SỰ (PHẦN 2) ============================================

const HR_CSV_URL =
  "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.csv";

let hrCache = { rows: [], loadedAt: 0 };
const HR_TTL_MS = 10 * 60 * 1000; // 10 phút

async function getHrRows() {
  const now = Date.now();

  if (hrCache.rows.length && now - hrCache.loadedAt < HR_TTL_MS) {
    return hrCache.rows;
  }

  console.log("Đang tải CSV nhân sự từ:", HR_CSV_URL);

  const res = await axios.get(HR_CSV_URL, {
    responseType: "text",
    timeout: 8000,
  });

  const records = parse(res.data, {
    columns: true,
    skip_empty_lines: true,
  });

  hrCache = {
    rows: records,
    loadedAt: now,
  };

  console.log("Đã nạp CSV nhân sự:", records.length, "dòng");
  return records;
}

// ===== HÀM TÌM KIẾM & RÚT GỌN CONTEXT ============================

function searchRows(question, rows) {
  const q = (question || "").toLowerCase();
  const keys = q.split(/\s+/).filter((w) => w.length > 1);

  let results = [];

  for (const row of rows) {
    const text = Object.values(row).join(" ").toLowerCase();
    if (keys.some((k) => text.includes(k))) {
      results.push(row);
      if (results.length >= 500) break; // cho phép tối đa 500 dòng
    }
  }

  if (results.length === 0) return rows.slice(0, 20);
  return results;
}

function createContext(rows) {
  const MAX_CONTEXT_CHARS = 6500; // giảm nhẹ so với 7000 để an toàn token
  const json = JSON.stringify(rows.slice(0, 40), null, 2);
  return json.length > MAX_CONTEXT_CHARS
    ? json.substring(0, MAX_CONTEXT_CHARS) + "...(rút gọn)"
    : json;
}

// ===== HÀM TẠO FILE CSV NHÂN SỰ ĐỂ DOWNLOAD ======================

function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const lines = [];

  // dòng tiêu đề
  lines.push(headers.join(","));

  // từng dòng dữ liệu
  for (const row of rows) {
    const line = headers
      .map((h) => {
        const value = (row[h] ?? "").toString();
        // escape dấu "
        const safe = value.replace(/"/g, '""');
        return `"${safe}"`;
      })
      .join(",");
    lines.push(line);
  }

  return lines.join("\n");
}

// Tạo file CSV trong thư mục downloads và trả về đường dẫn để frontend tải
function createHrDownloadFile(rows) {
  if (!rows || rows.length === 0) {
    // Nếu không có dòng nào, vẫn tạo file trống với header
    rows = [{}];
  }

  const csv = rowsToCsv(rows);
  const timestamp = Date.now();
  const filename = `nhan-su-${timestamp}.csv`;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  fs.writeFileSync(filePath, csv, "utf8");

  // Trả đường dẫn cho client (relative URL, cùng domain với server)
  const downloadUrl = `/downloads/${filename}`;
  return downloadUrl;
}

// ===== HÀM BỎ DẤU + PHÂN LOẠI CÂU HỎI 4 PHẦN ===========================

// Bỏ dấu tiếng Việt để so khóa
function removeVietnameseTones(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// Từ khóa cho từng phần
const KEYWORDS = {
  1: [
    // Giới thiệu công ty
    "gioi thieu cong ty",
    "intimex dak mil",
    "intimex dakmil",
    "lich su cong ty",
    "tam nhin",
    "su menh",
    "gia tri cot loi",
    "linh vuc hoat dong",
    "thong tin cong ty",
    "dia chi cong ty",
  ],
  2: [
    // Nhân sự
    "nhan su",
    "nhan vien",
    "can bo",
    "ma nv",
    "ma nhan vien",
    "phong ban",
    "bo phan",
    "phong ke toan",
    "phong kinh doanh",
    "phong hanh chinh",
    "chuc vu",
    "tuyen dung",
    "ho so nhan su",
    "so luong nhan vien",
    "nghi viec",
    "dang lam viec",
  ],
  3: [
    // Quy trình
    "quy trinh",
    "sop",
    "huong dan",
    "quy che",
    "quy trinh lam viec",
    "quy trinh mua hang",
    "quy trinh ban hang",
    "quy trinh tuyen dung",
    "quy trinh nghi phep",
    "quy trinh thanh toan",
    "phe duyet",
    "luong duyet",
    "form bieu",
    "mau bieu",
  ],
  4: [
    // Số liệu / phân tích
    "doanh thu",
    "chi phi",
    "loi nhuan",
    "ton kho",
    "bao cao kinh doanh",
    "bao cao tai chinh",
    "kpi",
    "chi so",
    "thong ke",
    "phan tich",
    "so lieu",
    "doanh so",
    "san luong",
    "thang",
    "quy",
    "nam",
  ],
};

// Trả về 1 | 2 | 3 | 4
function classifyQuestion(message) {
  if (!message || !message.trim()) return 1;

  const text = removeVietnameseTones(message.toLowerCase());

  // Ưu tiên nhân sự nếu có từ khóa rõ
  if (text.includes("nhan su") || text.includes("nhan vien")) {
    return 2;
  }

  const scores = { 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const section of [1, 2, 3, 4]) {
    for (const kw of KEYWORDS[section]) {
      if (text.includes(kw)) {
        scores[section] += 1;
      }
    }
  }

  const maxScore = Math.max(scores[1], scores[2], scores[3], scores[4]);

  if (maxScore === 0) {
    // Đoán sơ: nếu có vẻ gọi tên người -> HR
    if (/anh\s+\w+|chi\s+\w+|ong\s+\w+|ba\s+\w+/.test(text)) {
      return 2;
    }
    // Mặc định: giới thiệu / chung chung
    return 1;
  }

  let bestSection = 1;
  for (const s of [1, 2, 3, 4]) {
    if (scores[s] === maxScore) {
      bestSection = s;
      break;
    }
  }
  return bestSection;
}

// ===== NHẬN DIỆN CÂU HỎI "TOÀN BỘ DANH SÁCH NHÂN SỰ" ====================

function isAllEmployeesQuery(message) {
  const text = removeVietnameseTones((message || "").toLowerCase());

  // Các kiểu câu hỏi mang nghĩa "tất cả nhân sự"
  if (
    text.includes("toan bo nhan su") ||
    text.includes("toan bo nhan vien") ||
    text.includes("tat ca nhan su") ||
    text.includes("tat ca nhan vien") ||
    text.includes("tong danh sach nhan su") ||
    text.includes("tong danh sach nhan vien")
  ) {
    return true;
  }

  // Nếu chỉ nói chung chung "danh sach nhan su"/"danh sach nhan vien"
  // mà KHÔNG kèm điều kiện (trưởng phòng / phòng / đang làm việc / ...)
  if (
    (text.includes("danh sach nhan su") ||
      text.includes("danh sach nhan vien")) &&
    !text.includes("truong phong") &&
    !text.includes("phong ") &&
    !text.includes("dang lam viec") &&
    !text.includes("da nghi") &&
    !text.includes("nghi viec")
  ) {
    return true;
  }

  return false;
}

// ===== ROUTES ===========================================================

app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    model: assistantConfig.model,
    hr_csv_url: HR_CSV_URL,
    company_intro_csv_url: COMPANY_INTRO_CSV_URL,
  });
});

// Route chính chatbot
app.post("/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "Thiếu 'message' trong body." });
  }

  // 1) Phân loại câu hỏi
  const section = classifyQuestion(message); // 1|2|3|4
  let sectionLabel = "";
  let dataContext = "";
  let downloadUrl = null; // URL file tải (nếu có)

  try {
    if (section === 2) {
      // ===== PHẦN 2: NHÂN SỰ – dùng CSV =====
      sectionLabel = "PHAN_2_NHAN_SU";
      try {
        const hrRows = await getHrRows();
        const totalEmployees = hrRows.length;

        // Lọc theo câu hỏi (tên, phòng ban, v.v.) để trả lời trong chat
        const related = searchRows(message, hrRows);
        const relatedJson = createContext(related);

        // Quyết định xuất file full hay file đã lọc
        try {
          const rowsForFile = isAllEmployeesQuery(message) ? hrRows : related;
          downloadUrl = createHrDownloadFile(rowsForFile);
        } catch (e) {
          console.error("Lỗi tạo file CSV nhân sự:", e.message);
        }

        // Ghép context: vừa có tổng số, vừa có JSON chi tiết (rút gọn)
        dataContext = `
TONG_SO_NHAN_SU: ${totalEmployees}
/* Dong tren cho biet tong so nhan su theo du lieu CSV hien co. */

DU_LIEU_NHAN_SU_CHI_TIET_JSON:
${relatedJson}
        `.trim();
      } catch (e) {
        console.error("Lỗi đọc CSV nhân sự:", e.message);
        dataContext =
          "Không đọc được dữ liệu nhân sự từ CSV. Khong the tinh TONG_SO_NHAN_SU.";
      }
    } else if (section === 3) {
      // ===== PHẦN 3: QUY TRÌNH – TODO: nối vào tài liệu quy trình =====
      sectionLabel = "PHAN_3_QUY_TRINH";
      dataContext =
        "Du lieu quy trinh noi bo chua duoc ket noi. Backend can bo sung tai lieu quy trinh lien quan.";
    } else if (section === 4) {
      // ===== PHẦN 4: SỐ LIỆU – TODO: nối vào DB/số liệu =====
      sectionLabel = "PHAN_4_SO_LIEU";
      dataContext =
        "So lieu kinh doanh/tai chinh/KPI chua duoc ket noi. Backend can bo sung query du lieu phu hop.";
    } else {
      // ===== PHẦN 1: GIỚI THIỆU CÔNG TY =====
      sectionLabel = "PHAN_1_GIOI_THIEU";
      try {
        const introRows = await getCompanyIntroRows();

        // Dùng searchRows để chỉ lấy những dòng liên quan (nếu có),
        // tránh gửi toàn bộ CSV quá dài
        const relatedIntro = searchRows(message, introRows);
        const introJson = createContext(relatedIntro);

        dataContext = `
DU_LIEU_GIOI_THIEU_CONG_TY_CSV:
${introJson}
        `.trim();
      } catch (e) {
        console.error("Lỗi đọc CSV giới thiệu công ty:", e.message);
        dataContext =
          "Khong doc duoc du lieu gioi thieu cong ty tu CSV (gioithieu.csv).";
      }
    }

    // 2) Ghép instructions từ assistant.yaml + nhấn mạnh section
    const baseSystemPrompt =
      assistantConfig.system_prompt ||
      "Bạn là Trợ lý nội bộ Intimex Đắk Mil, hỗ trợ công ty, nhân sự, quy trình, số liệu.";

    const instructions = `
${baseSystemPrompt}

Loại câu hỏi hiện tại: ${sectionLabel}.
- Nếu là PHAN_2_NHAN_SU: chỉ được dựa trên dữ liệu nhân sự trong context (JSON) để trả lời, không bịa thêm.
- Nếu là PHAN_3_QUY_TRINH: chỉ được mô tả quy trình dựa trên dữ liệu context, nếu thiếu thì nói rõ chưa đủ thông tin.
- Nếu là PHAN_4_SO_LIEU: chỉ được phân tích số liệu dựa trên bảng/context được cung cấp, không tự nghĩ ra con số.
- Nếu là PHAN_1_GIOI_THIEU: chỉ được mô tả công ty dựa trên thông tin context, nếu thiếu thì nói rõ.

Luôn trả lời bằng tiếng Việt, xưng Em, gọi Anh/Chị.
    `.trim();

    // 3) Gọi OpenAI qua lớp concurrency + retry
    let openaiResponse;
    try {
      openaiResponse = await withOpenAIConcurrencyLimit(() =>
        callOpenAIWithRetry({
          model: assistantConfig.model || "gpt-4o-mini",
          temperature: assistantConfig.temperature ?? 0.2,
          max_output_tokens: assistantConfig.max_output_tokens || 900,
          instructions,
          input: [
            {
              role: "user",
              content: `
Câu hỏi của người dùng:

"${message}"

Dữ liệu nội bộ liên quan (JSON / văn bản rút gọn):

${dataContext}
              `.trim(),
            },
          ],
        })
      );
    } catch (err) {
      // Xử lý rate limit 429 (sau khi đã retry)
      if (err.status === 429 || err.code === "rate_limit_exceeded") {
        console.error("OpenAI rate limit (sau khi retry):", err.message);
        return res.status(429).json({
          error:
            "Hệ thống đang gửi quá nhiều yêu cầu đến máy chủ AI. Anh/Chị vui lòng thử lại sau ít phút.",
        });
      }

      console.error("Lỗi OpenAI:", err.message);
      return res.status(500).json({
        error: "Có lỗi khi kết nối tới máy chủ AI.",
      });
    }

    // 4) Lấy text trả lời
    let replyText = "Em chưa tạo được câu trả lời phù hợp.";
    try {
      const firstOutput = openaiResponse.output?.[0];
      const firstContent = firstOutput?.content?.[0];
      if (firstContent?.text) {
        replyText =
          typeof firstContent.text === "string"
            ? firstContent.text
            : firstContent.text.value || replyText;
      }
    } catch (e) {
      console.error("Lỗi trích xuất text từ OpenAI:", e.message);
    }

    // 5) Trả về cho frontend
    return res.json({
      reply: replyText,
      section,
      section_label: sectionLabel,
      download_url: downloadUrl, // nếu là nhân sự & tạo file thành công thì sẽ có URL
    });
  } catch (outerErr) {
    console.error("Lỗi không mong muốn ở /chat:", outerErr.message);
    return res.status(500).json({
      error: "Có lỗi không mong muốn xảy ra ở máy chủ.",
    });
  }
});

// ===== START SERVER =====================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server trợ lý nội bộ Intimex đang chạy trên port", PORT);
});
