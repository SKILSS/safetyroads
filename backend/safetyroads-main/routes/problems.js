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
      thinking: { type: "disabled" },
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


async function runResolutionAiCheck({ apiKey, originalImageDataUrl, resolutionImageDataUrl, description, resolutionNote }) {
  const content = [
    {
      type: "text",
      text: `You are checking whether a previously reported public-road/civic problem appears to have been fixed. This is image evidence only; do not claim certainty about the real-world event. Compare the current photo with the original problem photo when available, plus the original description and the user's note. Return ONLY valid JSON with exactly these keys: isFixed (boolean), confidence (number 0 to 1), reason (string max 350 chars). Mark isFixed=true only when the current image provides reasonably clear visual evidence that the described problem is no longer present or has been repaired. If the image is ambiguous, unrelated, too poor, or the issue could still be present, use false with low confidence. Original description: ${description}. User note: ${resolutionNote || "No additional note."}`
    },
  ];
  if (originalImageDataUrl) content.push({ type: "text", text: "Original problem photo:" }, { type: "image_url", image_url: { url: originalImageDataUrl, detail: "high" } });
  content.push({ type: "text", text: "Photo submitted as evidence of repair:" }, { type: "image_url", image_url: { url: resolutionImageDataUrl, detail: "high" } });

  const aiRes = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      messages: [{ role: "user", content }],
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
  const parsed = parseAiJson(data?.choices?.[0]?.message?.content);
  if (!parsed || typeof parsed.isFixed !== "boolean") throw new Error("DeepSeek returned an unexpected resolution response.");
  return {
    isFixed: parsed.isFixed,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    reason: String(parsed.reason || "").slice(0, 350),
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


// Any authenticated user can submit photo evidence that a problem was fixed.
// The server keeps the original report and lets DeepSeek decide whether the new
// photo is strong enough evidence. Only a high-confidence positive result
// changes the public status to resolved.
router.post("/:id/resolve", requireAuth, writeLimiter, async (req, res) => {
  const { imageDataUrl, note } = req.body || {};
  const image = parseDataUrl(imageDataUrl);
  if (!image) return res.status(400).json({ error: "A valid repair photo is required." });

  const current = await pool.query("SELECT * FROM problems WHERE id = $1", [req.params.id]);
  const problem = current.rows[0];
  if (!problem) return res.status(404).json({ error: "Problem not found." });
  if (["withdrawn", "rejected", "resolved"].includes(problem.status)) {
    return res.status(409).json({ error: "This problem is no longer active." });
  }

  const settings = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
  const apiKey = settings?.deepseek_api_key || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    await pool.query(`UPDATE problems SET resolution_ai_status='not_configured', resolved_image_data=$1, resolution_note=$2, resolved_by=$3 WHERE id=$4`,
      [image.data, String(note || "").slice(0, 500), req.user.id, problem.id]);
    return res.status(503).json({ error: "AI review is not configured by the administrator." });
  }

  let verdict;
  try {
    verdict = await runResolutionAiCheck({
      apiKey,
      originalImageDataUrl: problem.image_data,
      resolutionImageDataUrl: image.data,
      description: problem.title_ru || problem.title_en,
      resolutionNote: String(note || "").slice(0, 500),
    });
  } catch (err) {
    const msg = String(err.message || "AI check failed").slice(0, 220);
    await pool.query(`UPDATE problems SET resolution_ai_status='error', resolved_image_data=$1, resolution_note=$2, resolved_by=$3 WHERE id=$4`,
      [image.data, String(note || "").slice(0, 500), req.user.id, problem.id]);
    console.error("[ai] resolution check failed:", msg);
    return res.status(502).json({ error: msg });
  }

  const accepted = verdict.isFixed && verdict.confidence >= 0.80;
  const updated = await pool.query(`
    UPDATE problems SET
      status=$1, resolved_by=$2, resolved_image_data=$3, resolution_note=$4,
      resolution_ai_status='checked', resolution_ai_matches=$5,
      resolution_ai_confidence=$6, resolution_ai_verdict=$7,
      resolution_ai_checked_at=now(), resolved_at=CASE WHEN $1='resolved' THEN now() ELSE NULL END
    WHERE id=$8 RETURNING *`,
    [accepted ? "resolved" : problem.status, req.user.id, image.data, String(note || "").slice(0, 500),
      verdict.isFixed, verdict.confidence, verdict.reason, problem.id]
  );

  res.json({
    ...updated.rows[0],
    resolved: accepted,
    ai_reason: verdict.reason,
    ai_confidence: verdict.confidence,
  });
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
