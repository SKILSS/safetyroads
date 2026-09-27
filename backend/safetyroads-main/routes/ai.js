const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { aiLimiter } = require("../middleware/security");

const router = express.Router();

function cleanText(value, max = 4000) {
  return String(value || "").trim().slice(0, max);
}

router.post("/chat", requireAuth, aiLimiter, async (req, res) => {
  const message = cleanText(req.body?.message, 4000);
  const language = req.body?.language === "en" ? "en" : "ru";
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((m) => m && (m.role === "user" || m.role === "model"))
        .slice(-10)
        .map((m) => ({ role: m.role, text: cleanText(m.text, 1500) }))
        .filter((m) => m.text)
    : [];
  if (!message) return res.status(400).json({ error: language === "en" ? "Message is required." : "Введите сообщение." });

  const settings = (await pool.query("SELECT gemini_api_key FROM app_settings WHERE id = 1")).rows[0];
  const apiKey = settings?.gemini_api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: language === "en" ? "Gemini is not configured by the administrator." : "Gemini не настроен администратором." });

  const reports = await pool.query(
    `SELECT region, category, severity, status, title_ru, title_en, lat, lng, is_road
     FROM problems
     WHERE status NOT IN ('rejected','withdrawn')
     ORDER BY created_at DESC LIMIT 80`
  );

  const reportContext = reports.rows.map((p) => ({
    region: p.region,
    category: p.category,
    severity: p.severity,
    status: p.status,
    title: language === "en" ? p.title_en : p.title_ru,
    lat: p.lat,
    lng: p.lng,
    road: p.is_road,
  }));

  const system = language === "en"
    ? `You are the SafetyRoad AI assistant. Help users understand the site's road reports, navigator, routes, map, gas-station information, and how to use the app. Be concise and factual. Never claim that a reported problem is verified unless its status says confirmed. Do not invent live traffic, road closures, prices, or exact navigation events. If asked for something the app cannot know, say so. Reply in English.`
    : `Ты ИИ-помощник SafetyRoad. Помогай пользователю разбираться с обращениями о дорогах, навигатором, маршрутами, картой, АЗС и функциями сайта. Отвечай кратко и по делу. Не называй проблему подтверждённой, если её статус не confirmed. Не выдумывай пробки, перекрытия, цены или события навигации в реальном времени. Если сайт не может знать ответ, прямо скажи об этом. Отвечай на русском.`;

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const historyText = history.length
    ? history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n")
    : "No previous conversation.";
  const prompt = `${system}\n\nCurrent public report data (may be incomplete): ${JSON.stringify(reportContext)}\n\nConversation history:\n${historyText}\n\nLatest user message: ${message}`;

  try {
    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      }),
    });
    const bodyText = await aiRes.text();
    if (!aiRes.ok) {
      let detail = `Gemini HTTP ${aiRes.status}`;
      try { detail = JSON.parse(bodyText)?.error?.message || detail; } catch {}
      throw new Error(detail.slice(0, 240));
    }
    const data = JSON.parse(bodyText);
    const answer = String(data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "").trim();
    if (!answer) throw new Error("Gemini returned an empty answer.");
    res.json({ answer });
  } catch (err) {
    console.error("[ai/chat]", err);
    res.status(502).json({ error: language === "en" ? "The AI service is temporarily unavailable." : "Сервис ИИ временно недоступен." });
  }
});

module.exports = router;
