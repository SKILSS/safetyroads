const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { writeLimiter, aiLimiter } = require("../middleware/security");

const router = express.Router();

router.get("/", async (req, res) => {
  const { region } = req.query;
  const result = region
    ? await pool.query("SELECT * FROM problems WHERE region = $1 ORDER BY created_at DESC LIMIT 300", [region])
    : await pool.query("SELECT * FROM problems ORDER BY created_at DESC LIMIT 300");
  res.set("Cache-Control", "public, max-age=15");
  res.json(result.rows);
});

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > 3_500_000) return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
  return m ? { mime: m[1].toLowerCase(), data: dataUrl } : null;
}

function parseAiJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function runAiCheck({ apiKey, imageDataUrl, description }) {
  const aiRes = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this road/civic problem photo against the user's description. Do NOT claim that a photo proves the real-world event. Decide only whether the visible content is consistent with the description. Return ONLY valid JSON with exactly these keys: matchesDescription (boolean), detectedProblem (string), confidence (number from 0 to 1), reason (string, max 300 chars). User description: ${description}`,
          },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    }),
  });

  const bodyText = await aiRes.text();
  if (!aiRes.ok) {
    let detail = `DeepSeek HTTP ${aiRes.status}`;
    try { detail = JSON.parse(bodyText)?.error?.message || detail; } catch {}
    throw new Error(detail.slice(0, 220));
  }
  let data;
  try { data = JSON.parse(bodyText); } catch { throw new Error("Invalid response from DeepSeek."); }
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseAiJson(content);
  if (!parsed || typeof parsed.matchesDescription !== "boolean") {
    throw new Error("DeepSeek returned an unexpected AI response.");
  }
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  return {
    matchesDescription: parsed.matchesDescription,
    detectedProblem: String(parsed.detectedProblem || "unknown").slice(0, 200),
    confidence,
    reason: String(parsed.reason || "").slice(0, 300),
  };
}

router.post("/", requireAuth, writeLimiter, async (req, res) => {
  const { region, category, severity, titleRu, titleEn, imageDataUrl, lat, lng, isRoad, route } = req.body || {};
  if (!region || !titleRu || !titleEn) {
    return res.status(400).json({ error: "region, titleRu and titleEn are required." });
  }

  const image = imageDataUrl ? parseDataUrl(imageDataUrl) : null;
  if (imageDataUrl && !image) {
    return res.status(400).json({ error: "Unsupported or oversized image. Use JPEG, PNG, GIF or WebP." });
  }

  const roadMode = !!isRoad && Array.isArray(route) && route.length >= 2;
  const safeRoute = roadMode
    ? route.filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    : null;
  const safeLat = Number.isFinite(lat) ? lat : (roadMode && safeRoute.length ? safeRoute[0][0] : null);
  const safeLng = Number.isFinite(lng) ? lng : (roadMode && safeRoute.length ? safeRoute[0][1] : null);

  let aiVerdict = null;
  let aiStatus = "not_checked";
  let aiMatches = null;
  let aiConfidence = null;
  let aiDetected = null;
  let aiCheckedAt = null;
  let aiError = null;

  const settings = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
  const apiKey = settings?.deepseek_api_key || process.env.DEEPSEEK_API_KEY;
  if (apiKey && image) {
    try {
      const verdict = await runAiCheck({ apiKey, imageDataUrl: image.data, description: titleRu || titleEn });
      aiMatches = verdict.matchesDescription;
      aiConfidence = verdict.confidence;
      aiDetected = verdict.detectedProblem;
      aiVerdict = verdict.reason;
      aiStatus = "checked";
      aiCheckedAt = new Date();
    } catch (err) {
      aiStatus = "error";
      aiError = String(err.message || "AI check failed").slice(0, 220);
      console.error("[ai] problem check failed:", aiError);
    }
  } else if (!apiKey) {
    aiStatus = "not_configured";
  } else if (!image) {
    aiStatus = "no_image";
  }

  const result = await pool.query(
    `INSERT INTO problems (region, category, severity, status, title_ru, title_en, image_data, ai_verdict, ai_status, ai_matches, ai_confidence, ai_detected, ai_checked_at, lat, lng, is_road, route, created_by)
     VALUES ($1,$2,$3,'new',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [region, category || "other", severity || "med", titleRu, titleEn, image?.data || null, aiVerdict,
      aiStatus, aiMatches, aiConfidence, aiDetected, aiCheckedAt, safeLat, safeLng, roadMode,
      safeRoute ? JSON.stringify(safeRoute) : null, req.user.id]
  );
  res.status(201).json({ ...result.rows[0], ai_error: aiError });
});

// Owner can withdraw their own report. It stays in the database for audit/history
// but is marked withdrawn and is ignored by the map counters.
router.patch("/:id/withdraw", requireAuth, writeLimiter, async (req, res) => {
  const result = await pool.query(
    `UPDATE problems
     SET status = 'withdrawn'
     WHERE id = $1 AND created_by = $2 AND status NOT IN ('withdrawn','rejected')
     RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Report not found or you cannot withdraw it." });
  res.json(result.rows[0]);
});

router.patch("/:id", requireAdmin, writeLimiter, async (req, res) => {
  const { status, severity, category } = req.body || {};
  const result = await pool.query(
    `UPDATE problems SET status = COALESCE($1, status), severity = COALESCE($2, severity), category = COALESCE($3, category)
     WHERE id = $4 RETURNING *`,
    [status, severity, category, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
  res.json(result.rows[0]);
});

router.delete("/:id", requireAdmin, writeLimiter, async (req, res) => {
  await pool.query("DELETE FROM problems WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
