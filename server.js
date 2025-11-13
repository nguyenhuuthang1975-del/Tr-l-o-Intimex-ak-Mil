// server.js
// Trợ lý Intimex Đắk Mil + đọc dữ liệu nhân sự từ Excel trên intimexdakmil.com

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
const ASSISTANT_CONFIG_PATH = process.env.ASSISTANT_CONFIG_PATH || path.join(__dirname, "config", "assistant.yaml");

// URL file Excel nhân sự
// ⚠ Nếu URL thực của bạn KHÔNG có public_html thì sửa lại thành:
// const EXCEL_URL = "https://intimexdakmil.com/data/Bang_nhan_su_mo_rong.xlsx";
const EXCEL_URL = "https://intimexdakmil.com/public_html/data/Bang_nhan_su_mo_rong.xlsx";

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
      system_prompt: "Bạn là trợ lý ảo Intimex Đắk Mil.",
    };
  }
}

loadAssistantConfig();

// ==== HÀM ĐỌC EXCEL TỪ URL ==============================================

async function loadExcelFromUrl(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
  });
  const workbook = XLSX.read(response.data, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows;
}

// Rút gọn dữ liệu Excel để không quá dài (tránh tràn token)
function buildHrContext(rows) {
  if (!rows || rows.length === 0) return "Không có dữ liệu nhân sự nào được đọc từ Excel.";

  // Lấy tối đa 50 dòng đầu để tránh prompt quá lớn
  const limited = rows.slice(0, 50);

  // Có thể chọn ra một số cột chính nếu cần (vd: Tên, Bộ phận, Chức vụ,…)
  // Ở đây mình giữ nguyên toàn bộ cột, nhưng bạn có thể tùy chỉnh:
  // const mapped = limited.map(r => ({
  //   Ho_ten: r["HỌ TÊN"],
  //   Bo_phan: r["BỘ PHẬN"],
  //   Chuc_vu: r["CHỨC VỤ"],
  //   SDT: r["SỐ ĐIỆN THOẠI"],
  //   Ghi_chu: r["GHI CHÚ"]
  // }));

  const jsonText = JSON.stringify(limited, null, 2);

  // Nếu vẫn quá dài, cắt bớt cho an toàn
  const MAX_CHARS = 8000;
  if (jsonText.length > MAX_CHARS) {
    return jsonText.slice(0, MAX_CHARS) + "\n... (đã rút gọn bớt dòng nhân sự)";
  }

  return jsonText;
}

// ==== ROUTES ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    model: assistantConfig?.model || "gpt-4.1-mini",
    excel_url: EXCEL_URL,
  });
});

app.post("/chat", async (req, res) => {
  const { message, device_id } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: "Thiếu trường 'message' trong body." });
  }

  try {
    // 1) Đọc dữ liệu Excel nhân sự
    let hrRows = [];
    let hrContext = "";
    try {
      hrRows = await loadExcelFromUrl(EXCEL_URL);
      hrContext = buildHrContext(hrRows);
      console.log(`Đã đọc ${hrRows.length} dòng nhân sự từ Excel.`);
    } catch (excelErr) {
      console.error("Lỗi khi tải/đọc file Excel:", excelErr.message);
      hrContext = "Không đọc được file Excel nhân sự. Hãy trả lời mà không dựa trên dữ liệu Excel.";
    }

    // 2) Ghép system prompt
    const baseSystemPrompt = assistantConfig.system_prompt || "Bạn là trợ lý ảo Intimex Đắk Mil.";
    const excelInstruction = `
Bạn được cung cấp một phần dữ liệu nhân sự (dạng JSON rút gọn) lấy từ file Excel nội bộ Intimex Đắk Mil.

- Nếu người dùng hỏi về nhân sự (tên, bộ phận, chức vụ, số điện thoại, …) thì hãy tra cứu TRONG dữ liệu này.
- Nếu không tìm thấy thông tin tương ứng trong dữ liệu, hãy nói rõ là "Không thấy dữ liệu trong bảng nhân sự" và KHÔNG được bịa.
- Nếu câu hỏi không liên quan tới nhân sự, bạn có thể bỏ qua dữ liệu này và trả lời như một trợ lý bình thường.

Dữ liệu JSON được truyền trong nội dung câu hỏi bên dưới.
    `.trim();

    const instructions = `${baseSystemPrompt}\n\n${excelInstruction}`;

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

Dữ liệu nhân sự (JSON rút gọn lấy từ Excel ${EXCEL_URL}):

${hrContext}
          `.trim(),
        },
      ],
    });

    const replyText = response.output_text || "Xin lỗi, hiện tại tôi không tạo được trả lời.";

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
