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

// ===== KIỂM TRA API KEY (GROQ) ===========================================

const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;

if (!GROQ_API_KEY) {
  console.error("⛔ ERROR: GROQ_API_KEY (hoặc OPENAI_API_KEY) is missing.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: GROQ_API_KEY,
  // Groq dùng OpenAI-compatible endpoint
  baseURL: "https://api.groq.com/openai/v1",
});

// ===== CẤU HÌNH GIỚI HẠN & RETRY GROQ ===================================

const GROQ_MAX_CONCURRENT = 2;
let groqCurrentRunning = 0;

async function withGroqConcurrencyLimit(fn) {
  while (groqCurrentRunning >= GROQ_MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 150));
  }
  groqCurrentRunning++;
  try {
    return await fn();
  } finally {
    groqCurrentRunning--;
  }
}

async function callGroqWithRetry(payload, retries = 3, delayMs = 1000) {
  try {
    // Dùng chat.completions thay vì responses.create
    return await client.chat.completions.create(payload);
  } catch (err) {
    if ((err.status === 429 || err.code === "rate_limit_exceeded") && retries > 0) {
      console.warn(`⚠️ Groq 429, retry sau ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      return callGroqWithRetry(payload, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// phục vụ file tĩnh trong thư mục ./public
app.use(express.static(path.join(__dirname, "public")));

// ===== THƯ MỤC LƯU FILE DOWNLOAD ========================================

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use("/downloads", express.static(DOWNLOAD_DIR));

// ===== LOAD assistant.yaml ==============================================

const CONFIG_PATH = path.join(__dirname, "config", "assistant.yaml");

let assistantConfig = {};
try {
  assistantConfig = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.warn("⚠️ Không tìm thấy assistant.yaml – dùng config mặc định.");
  assistantConfig = {
    model: "llama-3.1-8b-instant", // model Groq mặc định gợi ý
    temperature: 0.2,
    max_output_tokens: 900,
    system_prompt: "Bạn là trợ lý nội bộ Intimex Đắk Mil.",
  };
}

// ===== CSV URLs =========================================================

const INTRO_CSV_URL = "https://intimexdakmil.com/public_html/data/gioithieu.txt";
const HR_CSV_URL =
  "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.txt";

let introCache = { rows: [], loadedAt: 0 };
let hrCache = { rows: [], loadedAt: 0 };
const CACHE_TTL = 10 * 60 * 1000;

// ===== HÀM ĐỌC CSV AN TOÀN ==============================================

async function getCompanyIntroRows() {
  const now = Date.now();
  if (introCache.rows.length && now - introCache.loadedAt < CACHE_TTL) {
    return introCache.rows;
  }

  try {
    const res = await axios.get(INTRO_CSV_URL, { responseType: "text" });
    const records = parse(res.data, { columns: true, skip_empty_lines: true });
    introCache = { rows: records, loadedAt: now };
    return records;
  } catch (e) {
    console.error("Lỗi tải CSV giới thiệu:", {
      url: INTRO_CSV_URL,
      status: e.response?.status,
      message: e.message,
    });
    return introCache.rows.length ? introCache.rows : [];
  }
}

async function getHrRows() {
  const now = Date.now();
  if (hrCache.rows.length && now - hrCache.loadedAt < CACHE_TTL) {
    return hrCache.rows;
  }

  try {
    const res = await axios.get(HR_CSV_URL, { responseType: "text" });
    const records = parse(res.data, { columns: true, skip_empty_lines: true });
    hrCache = { rows: records, loadedAt: now };
    return records;
  } catch (e) {
    console.error("Lỗi tải CSV nhân sự:", {
      url: HR_CSV_URL,
      status: e.response?.status,
      message: e.message,
    });
    return hrCache.rows.length ? hrCache.rows : [];
  }
}

// ===== TIỆN ÍCH XỬ LÝ CHUỖI ============================================

function removeVietnameseTones(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// ===== HÀM LỌC NHÂN SỰ THÔNG MINH ======================================

function searchRows(question, rows) {
  const qRaw = (question || "").toLowerCase();
  const q = removeVietnameseTones(qRaw);

  // 1. Hỏi trưởng phòng / lãnh đạo
  if (q.includes("truong phong") || q.includes("truong") || q.includes("giam doc")) {
    return rows.filter((row) => {
      const title =
        removeVietnameseTones(
          (row["Chức vụ"] ||
            row["Chuc vu"] ||
            row["Ch?c v?"] || // đề phòng file chưa sửa header
            ""
          ).toLowerCase()
        );
      return (
        title.includes("truong") ||
        title.includes("giam doc") ||
        title.includes("pho giam doc") ||
        title.includes("truong bp")
      );
    });
  }

  // 2. Hỏi theo phòng ban (phòng kinh doanh, phòng kế toán,...)
  if (q.includes("phong ")) {
    const words = q.split(/\s+/);
    const idx = words.indexOf("phong");
    if (idx !== -1 && words[idx + 1]) {
      const pbKeyword = words[idx + 1]; // ví dụ "kinh", "ke", ...
      return rows.filter((row) => {
        const pb =
          removeVietnameseTones(
            (row["Phòng ban"] ||
              row["Phong ban"] ||
              row["Pḥng ban"] ||
              ""
            ).toLowerCase()
          );
        return pb.includes(pbKeyword);
      });
    }
  }

  // 3. Mặc định: tìm theo full-text đơn giản
  let results = [];
  const keys = q.split(/\s+/).filter((w) => w.length > 1);

  for (const row of rows) {
    const text = removeVietnameseTones(
      Object.values(row)
        .join(" ")
        .toLowerCase()
    );
    if (keys.some((k) => text.includes(k))) {
      results.push(row);
      if (results.length >= 500) break;
    }
  }

  return results.length > 0 ? results : rows.slice(0, 20);
}

// ===== NHẬN DIỆN HỎI TOÀN BỘ NHÂN SỰ ====================================

function isAllEmployeesQuery(message) {
  const t = removeVietnameseTones((message || "").toLowerCase());

  if (
    t.includes("toan bo nhan su") ||
    t.includes("toan bo nhan vien") ||
    t.includes("tat ca nhan su") ||
    t.includes("tat ca nhan vien") ||
    t.includes("tong danh sach nhan su") ||
    t.includes("tong danh sach nhan vien")
  ) {
    return true;
  }

  if (
    (t.includes("danh sach nhan su") || t.includes("danh sach nhan vien")) &&
    !t.includes("truong") &&
    !t.includes("pho") &&
    !t.includes("phong ") &&
    !t.includes("dang lam") &&
    !t.includes("nghi")
  ) {
    return true;
  }

  return false;
}

// ===== TẠO FILE CSV ======================================================

function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];

  for (const row of rows) {
    const line = headers
      .map((h) => `"${(row[h] || "").toString().replace(/"/g, '""')}"`)
      .join(",");
    lines.push(line);
  }

  return lines.join("\n");
}

function createHrDownloadFile(rows) {
  if (!rows || rows.length === 0) return null;
  const csv = rowsToCsv(rows);
  const filename = `nhan-su-${Date.now()}.txt`;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  fs.writeFileSync(filePath, csv, "utf8");
  return `/downloads/${filename}`;
}

// ===== PHÂN LOẠI CÂU HỎI 4 PHẦN =========================================

function classifyQuestion(message) {
  const t = removeVietnameseTones((message || "").toLowerCase());

  if (t.includes("nhan su") || t.includes("nhan vien")) return 2;
  if (t.includes("quy trinh") || t.includes("sop")) return 3;
  if (t.includes("doanh thu") || t.includes("kpi") || t.includes("bao cao")) return 4;
  return 1;
}

// ===== ROUTES ============================================================

app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    model: assistantConfig.model,
    hr_csv_url: HR_CSV_URL,
    company_intro_csv_url: INTRO_CSV_URL,
  });
});

app.post("/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "Thiếu 'message' trong body." });
  }

  const section = classifyQuestion(message);
  let dataContext = "";
  let downloadUrl = null;
  let sectionLabel = "";

  try {
    if (section === 2) {
      sectionLabel = "PHAN_2_NHAN_SU";
      const hrRows = await getHrRows();

      const related = searchRows(message, hrRows);
      const rowsForFile = isAllEmployeesQuery(message) ? hrRows : related;

      if (rowsForFile && rowsForFile.length) {
        downloadUrl = createHrDownloadFile(rowsForFile);
      }

      dataContext = JSON.stringify(related.slice(0, 40), null, 2);
    } else if (section === 1) {
      sectionLabel = "PHAN_1_GIOI_THIEU";
      const intro = await getCompanyIntroRows();
      const related = searchRows(message, intro);
      dataContext = JSON.stringify(related.slice(0, 40), null, 2);
    } else if (section === 3) {
      sectionLabel = "PHAN_3_QUY_TRINH";
      dataContext = "Dữ liệu quy trình nội bộ chưa được kết nối.";
    } else if (section === 4) {
      sectionLabel = "PHAN_4_SO_LIEU";
      dataContext = "Dữ liệu số liệu / KPI chưa được kết nối.";
    }

    const instructions = `
${assistantConfig.system_prompt}

PHẦN HIỆN TẠI: ${sectionLabel}
- Trả lời bằng tiếng Việt, xưng Em – gọi Anh/Chị.
- Không bịa số liệu.
- Nếu không thấy dữ liệu phù hợp trong JSON thì nói rõ là chưa đủ dữ liệu.
`.trim();

    // ===== GỌI GROQ (CHAT COMPLETIONS) ==================================
    const groqResponse = await withGroqConcurrencyLimit(() =>
      callGroqWithRetry({
        model: assistantConfig.model || "llama-3.1-8b-instant",
        temperature: assistantConfig.temperature ?? 0.2,
        max_tokens: assistantConfig.max_output_tokens || 900,
        messages: [
          {
            role: "system",
            content: instructions,
          },
          {
            role: "user",
            content: `
Câu hỏi của người dùng:

"${message}"

Dữ liệu nội bộ liên quan (JSON, có thể đã rút gọn):

${dataContext}
            `.trim(),
          },
        ],
      })
    );

    let reply = "Em chưa tạo được câu trả lời phù hợp.";
    try {
      const firstChoice = groqResponse.choices?.[0];
      if (firstChoice?.message?.content) {
        reply = firstChoice.message.content;
      }
    } catch (e) {
      console.error("Lỗi trích xuất câu trả lời Groq:", e.message);
    }

    return res.json({
      reply,
      section,
      section_label: sectionLabel,
      download_url: downloadUrl,
    });
  } catch (e) {
    console.error("🔥 LỖI /chat:", e.message);
    return res.status(500).json({ error: "Lỗi máy chủ /chat." });
  }
});

// ===== START SERVER ======================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Trợ lý Intimex (Groq) đang chạy PORT", PORT);
});
