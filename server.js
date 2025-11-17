/*******************************************************
 *  TRỢ LÝ ẢO INTIMEX ĐẮK MIL – SERVER.JS HOÀN CHỈNH
 *  BẢN ĐÃ TÍCH HỢP HÀM LỌC NHÂN SỰ THÔNG MINH
 *******************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const OpenAI = require("openai");

// ================== CHECK OPENAI KEY ==================

if (!process.env.OPENAI_API_KEY) {
  console.error("⛔ ERROR: OPENAI_API_KEY is missing.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== RATE LIMIT & RETRY ==================

const OPENAI_MAX_CONCURRENT = 2;
let openaiCurrentRunning = 0;

async function withOpenAIConcurrencyLimit(fn) {
  while (openaiCurrentRunning >= OPENAI_MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 150));
  }
  openaiCurrentRunning++;
  try {
    return await fn();
  } finally {
    openaiCurrentRunning--;
  }
}

async function callOpenAIWithRetry(payload, retries = 3, delayMs = 1000) {
  try {
    return await client.responses.create(payload);
  } catch (err) {
    if ((err.status === 429 || err.code === "rate_limit_exceeded") && retries > 0) {
      console.warn(`⚠️ OpenAI 429, retry sau ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      return callOpenAIWithRetry(payload, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

// ================== APP ==================

const app = express();
app.use(cors());
app.use(express.json());

// ================== DOWNLOAD FOLDER ==================

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use("/downloads", express.static(DOWNLOAD_DIR));

// ================== LOAD CONFIG ==================

const CONFIG_PATH = path.join(__dirname, "config", "assistant.yaml");

let assistantConfig = {};
try {
  assistantConfig = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.warn("⚠️ Không tìm thấy assistant.yaml – dùng config mặc định.");
  assistantConfig = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_output_tokens: 900,
    system_prompt: "Bạn là trợ lý nội bộ Intimex Đắk Mil."
  };
}

// ================== CSV URLs ==================

const INTRO_CSV_URL = "https://intimexdakmil.com/public_html/data/gioithieu.csv";

const HR_CSV_URL =
  "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.csv";

let introCache = { rows: [], loadedAt: 0 };
let hrCache = { rows: [], loadedAt: 0 };

const CACHE_TTL = 10 * 60 * 1000;

// ================== LOAD CSV ==================

async function getCompanyIntroRows() {
  const now = Date.now();
  if (introCache.rows.length && now - introCache.loadedAt < CACHE_TTL) {
    return introCache.rows;
  }

  const res = await axios.get(INTRO_CSV_URL, { responseType: "text" });
  const records = parse(res.data, { columns: true, skip_empty_lines: true });

  introCache = { rows: records, loadedAt: now };
  return records;
}

async function getHrRows() {
  const now = Date.now();
  if (hrCache.rows.length && now - hrCache.loadedAt < CACHE_TTL) {
    return hrCache.rows;
  }

  const res = await axios.get(HR_CSV_URL, { responseType: "text" });
  const records = parse(res.data, { columns: true, skip_empty_lines: true });

  hrCache = { rows: records, loadedAt: now };
  return records;
}

// ================== UTILS ==================

function removeVietnameseTones(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// ================== HÀM LỌC NHÂN SỰ THÔNG MINH ==================

function searchRows(question, rows) {
  const q = removeVietnameseTones((question || "").toLowerCase());

  // -------- 1. LỌC "TRƯỞNG PHÒNG" --------
  if (q.includes("truong phong") || q.includes("truong") || q.includes("tp")) {
    return rows.filter((row) => {
      const chucVu = removeVietnameseTones(
        (row["Chức vụ"] || row["chuc vu"] || "").toLowerCase()
      );
      return (
        chucVu.includes("truong") ||
        chucVu.includes("giam doc") ||
        chucVu.includes("tp") ||
        chucVu.includes("truong bo phan")
      );
    });
  }

  // -------- 2. LỌC THEO PHÒNG BAN --------
  if (q.includes("phong ")) {
    const words = q.split(" ");
    const idx = words.indexOf("phong");
    if (idx !== -1 && words[idx + 1]) {
      const pbKeyword = words[idx + 1];

      return rows.filter((row) => {
        const pb = removeVietnameseTones(
          (row["Phòng ban"] || row["phong ban"] || "").toLowerCase()
        );
        return pb.includes(pbKeyword);
      });
    }
  }

  // -------- 3. LỌC MẶC ĐỊNH (full text) --------
  let results = [];
  const keys = q.split(/\s+/).filter((w) => w.length > 1);

  for (const row of rows) {
    const text = removeVietnameseTones(
      Object.values(row).join(" ").toLowerCase()
    );
    if (keys.some((k) => text.includes(k))) {
      results.push(row);
      if (results.length >= 500) break;
    }
  }

  return results.length > 0 ? results : rows.slice(0, 20);
}

// ================== NHẬN DIỆN HỎI FULL DANH SÁCH ==================

function isAllEmployeesQuery(message) {
  const t = removeVietnameseTones(message.toLowerCase());

  if (
    t.includes("toan bo nhan su") ||
    t.includes("toan bo nhan vien") ||
    t.includes("tat ca nhan su") ||
    t.includes("tat ca nhan vien") ||
    t.includes("tong danh sach nhan su") ||
    t.includes("tong danh sach nhan vien")
  )
    return true;

  if (
    (t.includes("danh sach nhan su") || t.includes("danh sach nhan vien")) &&
    !t.includes("truong") &&
    !t.includes("pho") &&
    !t.includes("phong ") &&
    !t.includes("dang lam") &&
    !t.includes("nghi")
  )
    return true;

  return false;
}

// ================== TẠO FILE CSV ==================

function rowsToCsv(rows) {
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
  const csv = rowsToCsv(rows);
  const filename = `nhan-su-${Date.now()}.csv`;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  fs.writeFileSync(filePath, csv, "utf8");

  return `/downloads/${filename}`;
}

// ================== CLASSIFY QUESTION ==================

function classifyQuestion(msg) {
  const t = removeVietnameseTones(msg.toLowerCase());
  if (t.includes("nhan su") || t.includes("nhan vien")) return 2;
  if (t.includes("quy trinh") || t.includes("sop")) return 3;
  if (t.includes("doanh thu") || t.includes("kpi")) return 4;
  return 1;
}

// ================== ROUTE CHAT ==================

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message)
    return res.status(400).json({ error: "Thiếu nội dung message." });

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

      downloadUrl = createHrDownloadFile(rowsForFile);

      dataContext = JSON.stringify(related.slice(0, 40), null, 2);
    }

    if (section === 1) {
      sectionLabel = "PHAN_1_GIOI_THIEU";
      const intro = await getCompanyIntroRows();
      const related = searchRows(message, intro);
      dataContext = JSON.stringify(related.slice(0, 40), null, 2);
    }

    if (section === 3) {
      sectionLabel = "PHAN_3_QUY_TRINH";
      dataContext = "Chưa kết nối dữ liệu quy trình.";
    }

    if (section === 4) {
      sectionLabel = "PHAN_4_SO_LIEU";
      dataContext = "Chưa kết nối dữ liệu số liệu.";
    }

    const instructions = `
${assistantConfig.system_prompt}

PHẦN HIỆN TẠI: ${sectionLabel}
Trả lời bằng tiếng Việt, xưng Em – gọi Anh/Chị. Không bịa số liệu.
Nếu là PHẦN 2: chỉ dựa vào JSON nhân sự bên dưới.
`;

    const openaiResponse = await withOpenAIConcurrencyLimit(() =>
      callOpenAIWithRetry({
        model: assistantConfig.model,
        temperature: 0.2,
        max_output_tokens: 800,
        instructions,
        input: [
          {
            role: "user",
            content: `
Câu hỏi:

"${message}"

Dữ liệu nội bộ liên quan:
${dataContext}
            `
          }
        ]
      })
    );

    let reply = "Không tạo được câu trả lời.";
    try {
      reply =
        openaiResponse.output?.[0]?.content?.[0]?.text ||
        openaiResponse.output?.[0]?.content?.[0]?.text?.value ||
        reply;
    } catch {}

    res.json({
      reply,
      download_url: downloadUrl,
      section,
      section_label: sectionLabel
    });
  } catch (e) {
    console.error("🔥 LỖI /chat:", e.message);
    res.status(500).json({
      error: "Lỗi máy chủ."
    });
  }
});

// ================== START SERVER ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Trợ lý Intimex đang chạy PORT", PORT);
});
