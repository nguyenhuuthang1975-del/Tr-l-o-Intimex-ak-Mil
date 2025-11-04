import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import axios from "axios";
import yaml from "js-yaml";

dotenv.config();
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is missing. Add it to .env");
  process.exit(1);
}

// load YAML config
const cfgPath = path.join(process.cwd(), "config", "assistant.yaml");
let CFG = {};
function loadConfig() {
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    CFG = yaml.load(raw);
    console.log("[CONFIG] Loaded:", {
      name: CFG?.name,
      model: CFG?.model,
      temperature: CFG?.temperature,
    });
  } catch (e) {
    console.error("Cannot load config/assistant.yaml:", e.message);
    process.exit(1);
  }
}
loadConfig();

app.get("/", (req, res) => res.send("Intimex Bridge is running."));
app.get("/health", (req, res) => res.json({ ok: true, name: CFG?.name, model: CFG?.model }));

app.post("/chat", async (req, res) => {
  const { message, device_id, session_id } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing 'message'" });

  const systemPrompt = CFG?.system_prompt || "Bạn là trợ lý ảo.";
  const model = CFG?.model || "gpt-4.1-mini";
  const temperature = CFG?.temperature ?? 0.4;
  const max_output_tokens = CFG?.max_output_tokens ?? 512;

  try {
    // OpenAI Responses API
    const r = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model,
        temperature,
        max_output_tokens,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    // Try to read text safely (covers different payload shapes)
    let reply = "";
    const data = r.data;

    // Newer Responses API commonly returns output_text
    if (typeof data.output_text === "string") {
      reply = data.output_text;
    }
    // Fallback – explore nested content
    if (!reply && Array.isArray(data.output)) {
      const first = data.output[0];
      if (first?.content && Array.isArray(first.content)) {
        const t = first.content.find(c => c?.type === "output_text" || c?.type === "text");
        reply = t?.text || "";
      }
    }
    if (!reply && typeof data?.choices?.[0]?.message?.content === "string") {
      reply = data.choices[0].message.content; // legacy fallback
    }

    res.json({ reply, model, device_id, session_id: session_id || null });
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err.message);
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "Upstream error", detail: err?.response?.data || err.message });
  }
});

// lightweight endpoint to hot-reload config without restarting (optional)
app.post("/admin/reload-config", (req, res) => {
  try {
    loadConfig();
    res.json({ ok: true, model: CFG?.model });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Intimex Bridge listening on :${PORT}`));
