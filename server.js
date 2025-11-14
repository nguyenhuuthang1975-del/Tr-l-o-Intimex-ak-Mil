// server.js
// Trợ lý Intimex Đắk Mil + đọc dữ liệu nhân sự từ CSV trên intimexdakmil.com

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const XLSX = require("xlsx");
const OpenAI = require("openai");

// ==== CẤU HÌNH CƠ BẢN ===================================================

if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is missing. Add it to Render Environment.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

// Đường dẫn file cấu hình trợ lý
const ASSISTANT_CONFIG_PATH =
  process.env.ASSISTANT_CONFIG_PATH || path.join(__dirname, "config", "assistant.yaml");

// URL file CSV nhân sự (đúng theo bạn đã nói)
const HR_CSV_URL =
  process.env.HR_CSV_URL ||
  "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.csv";

// ==== HÀM ĐỌC CẤU HÌNH TRỢ LÝ ===========================================

let assistantConfig = null;

function loadAssistantConfig() {
  try {
    const raw = fs.readFileSync(ASSISTANT_CONFIG_PATH, "utf8");
    assistantConfig = yaml.load(raw);
    console.log("Assistant config loaded:", ASSISTANT_CONFIG_PATH);
  } catch (err) {
    console.error("Không đọc được config/assistant.yaml, dùng cấu hình mặc định.", err.message);
    assistantConfig = {
      model: "gpt-4.1-mini",
      temperature: 0.2,
      max_output_tokens: 800,
      system_prompt: "Bạn là trợ lý ảo Intimex Đắk Mil, chuyên hỗ trợ các câu hỏi về nhân sự.",
    };
  }
}

loadAssistantConfig();

// ==== HÀM ĐỌC CSV TỪ URL + CACHE =======================================

// Cache để tránh mỗi câu hỏi lại tải CSV 1 lần
let hrCache = {
  rows: [],
  loadedAt: 0,
};
const HR_CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút

async function loadHrFromUrl(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
  });

  // XLSX có thể đọc được cả CSV/Excel từ buffer, tự detect định dạng
  const workbook = XLSX.read(response.data, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows;
}

async function getHrRows() {
  const now = Date.now();
  if (hrCache.rows.length && now - hrCache.loadedAt < HR_CACHE_TTL_MS) {
    return hrCache.rows;
  }

  const rows = await loadHrFromUrl(HR_CSV_URL);
  hrCache = {
    rows,
    loadedAt: now,
  };
  console.log(`Đã tải lại dữ liệu nhân sự: ${rows.length} dòng.`);
  return rows;
}

// Tìm các dòng nhân sự có liên quan đến câu hỏi
function searchHrRows(question, rows, limit = 50) {
  if (!rows || rows.length === 0) return [];
  if (!question || !question.trim()) return rows.slice(0, limit);

  const q = question.toLowerCase();
  const keywords = q.split(/\s+/).filter((w) => w.length > 1);

  const results = [];

  for (const row of rows) {
    const line = Object.values(row).join(" ").toLowerCase();
    let matched = false;

    for (const kw of keywords) {
      if (line.includes(kw)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      results.push(row);
      if (results.length >= limit) break;
    }
  }

  // Nếu không tìm được gì, trả về vài dòng đầu để model vẫn biết cấu trúc dữ liệu
  if (results.length === 0) {
    return rows.slice(0, limit);
  }

  return results;
}

// Rút gọn dữ liệu nhân sự để đưa vào prompt
function buildHrContext(rows) {
  if (!rows || rows.length === 0) {
    return "Không có dòng dữ liệu nhân sự phù hợp trong bảng.";
  }

  const limited = rows.slice(0, 50);
  const jsonText = JSON.stringify(limited, null, 2);

  const MAX_CHARS = 8000;
  if (jsonText.length > MAX_CHARS) {
    return jsonText.slice(0, MAX_CHARS) + "\n... (đã rút gọn bớt dòng nhân sự)";
  }

  return jsonText;
}

// ==== ROUTES ============================================================

app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    model: assistantConfig?.model || "gpt-4.1-mini",
    hr_csv_url: HR_CSV_URL,
  });
});

app.post("/chat", async (req, res) => {
  const { message, device_id } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: "Thiếu trường 'message' trong body." });
  }

  try {
    // 1) Đọc dữ liệu nhân sự từ CSV (có cache)
    let hrRows = [];
    let hrContext = "";

    try {
      hrRows = await getHrRows();
      const relatedRows = searchHrRows(message, hrRows);
      hrContext = buildHrContext(relatedRows);
      console.log(
        `Đã đọc ${hrRows.length} dòng nhân sự từ CSV, chọn ${relatedRows.length} dòng liên quan.`
      );
    } catch (excelErr) {
      console.error("Lỗi khi tải/đọc file CSV nhân sự:", excelErr.message);
      hrContext =
        "Không đọc được file nhân sự (CSV). Hãy trả lời mà không dựa trên dữ liệu nhân sự nội bộ.";
    }

    // 2) Ghép system prompt + hướng dẫn dùng dữ liệu nhân sự
    const baseSystemPrompt =
      assistantConfig.system_prompt ||
      "Bạn là trợ lý ảo Intimex Đắk Mil, chuyên hỗ trợ các câu hỏi về nhân sự.";

    const hrInstruction = `
Bạn được cung cấp một phần dữ liệu nhân sự (dạng JSON rút gọn) lấy từ file Bang_nhan_su_mo_rong.csv của Intimex Đắk Mil.

- Nếu người dùng hỏi về nhân sự (họ tên, mã nhân viên, phòng ban, chức vụ, số điện thoại, tình trạng làm việc, v.v.) thì hãy tra cứu TRONG dữ liệu này.
- Nếu KHÔNG tìm thấy thông tin tương ứng, hãy trả lời rõ: "Không thấy dữ liệu tương ứng trong bảng nhân sự." và KHÔNG được bịa.
- Nếu câu hỏi không liên quan đến nhân sự, bạn có thể bỏ qua dữ liệu JSON này và trả lời như một trợ lý bình thường.
- Luôn trả lời bằng tiếng Việt, lịch sự, dễ hiểu. Xưng "Em" và gọi người dùng là "Anh/Chị".
    `.trim();

    const instructions = `${baseSystemPrompt}\n\n${hrInstruction}`;

    // 3) Gọi OpenAI Responses API
    const response = await client.responses.create({
      model: assistantConfig.model || "gpt-4.1-mini",
      temperature: assistantConfig.temperature ?? 0.2,
      max_output_tokens: assistantConfig.max_output_tokens || 800,
      instructions,
      input: [
        {
          role: "user",
          content: `
Câu hỏi của người dùng:

"${message}"

Dữ liệu nhân sự (JSON rút gọn, đã lọc theo câu hỏi, lấy từ ${HR_CSV_URL}):

${hrContext}
          `.trim(),
        },
      ],
    });

    // 4) Lấy text trả lời (SDK mới không có response.output_text)
    let replyText = "Xin lỗi, hiện tại em chưa tạo được câu trả lời phù hợp.";

    try {
      const firstOutput = response.output?.[0];
      const firstContent = firstOutput?.content?.[0];

      // Tùy phiên bản SDK, text có thể là string hoặc object { value: string }
      if (firstContent?.text) {
        replyText =
          typeof firstContent.text === "string"
            ? firstContent.text
            : firstContent.text.value || replyText;
      }
    } catch (e) {
      console.error("Lỗi khi trích xuất text từ response:", e.message);
    }

    res.json({
      reply: replyText,
      model: assistantConfig.model || "gpt-4.1-mini",
      device_id: device_id || null,
    });
  } catch (err) {
    console.error("Lỗi /chat:", err.response?.data || err.message);
    res.status(500).json({
      error: "Lỗi nội bộ server khi xử lý câu hỏi.",
      details: err.message,
    });
  }
});

// ==== KHỞI ĐỘNG SERVER ==================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Intimex assistant server is running on port ${PORT}`);
});
