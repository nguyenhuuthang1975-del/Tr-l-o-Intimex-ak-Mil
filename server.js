// server.js - bản không dùng XLSX (ổn định trên Render)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const OpenAI = require("openai");

if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is missing.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

// Load assistant config
const ASSISTANT_CONFIG_PATH = path.join(__dirname, "config", "assistant.yaml");

let assistantConfig = {};
try {
  assistantConfig = yaml.load(fs.readFileSync(ASSISTANT_CONFIG_PATH, "utf8"));
} catch (e) {
  assistantConfig = {
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_output_tokens: 800,
    system_prompt: "Bạn là trợ lý ảo Intimex Đắk Mil.",
  };
}

// CSV URL nhân sự
const HR_CSV_URL =
  "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.csv";

// Cache dữ liệu CSV
let hrCache = { rows: [], loadedAt: 0 };
const HR_TTL_MS = 10 * 60 * 1000;

async function getHrRows() {
  const now = Date.now();

  if (hrCache.rows.length && now - hrCache.loadedAt < HR_TTL_MS) {
    return hrCache.rows;
  }

  const res = await axios.get(HR_CSV_URL, { responseType: "text" });

  const records = parse(res.data, {
    columns: true,
    skip_empty_lines: true,
  });

  hrCache = {
    rows: records,
    loadedAt: now,
  };

  console.log("Đã nạp CSV:", records.length, "dòng");
  return records;
}

function searchRows(question, rows) {
  const q = question.toLowerCase();
  const keys = q.split(/\s+/);

  let results = [];

  for (const row of rows) {
    const text = Object.values(row).join(" ").toLowerCase();
    if (keys.some((k) => text.includes(k))) {
      results.push(row);
      if (results.length >= 50) break;
    }
  }

  if (results.length === 0) return rows.slice(0, 20);
  return results;
}

function createContext(rows) {
  const json = JSON.stringify(rows.slice(0, 40), null, 2);
  return json.length > 7000 ? json.substring(0, 7000) + "...(rút gọn)" : json;
}

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });

  let hrRows = [];
  let hrContext = "";

  try {
    hrRows = await getHrRows();
    const related = searchRows(message, hrRows);
    hrContext = createContext(related);
  } catch (e) {
    hrContext = "Không đọc được CSV.";
  }

  const instructions = `
${assistantConfig.system_prompt}

Bạn được cấp dữ liệu nhân sự dạng JSON bên dưới.
- Nếu người dùng hỏi về tên / mã nhân viên / phòng ban / chức vụ → hãy tra cứu trong dữ liệu.
- Nếu không thấy thông tin, hãy nói: "Không có dữ liệu phù hợp."
- Luôn trả lời bằng tiếng Việt, lịch sự.
  `.trim();

  const response = await client.responses.create({
    model: assistantConfig.model,
    temperature: assistantConfig.temperature,
    instructions,
    input: [
      {
        role: "user",
        content: `
Câu hỏi: "${message}"

Dữ liệu nhân sự liên quan (JSON rút gọn):
${hrContext}
        `,
      },
    ],
  });

  let text = "Em chưa trả lời được.";

  try {
    text = response.output?.[0]?.content?.[0]?.text || text;
  } catch {}

  res.json({ reply: text });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server đang chạy...")
);
