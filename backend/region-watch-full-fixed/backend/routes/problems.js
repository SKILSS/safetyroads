const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/security");

const router = express.Router();

// Public: anyone can read the map/feed — no login needed to browse.
router.get("/", async (req, res, next) => {
  try {
    const { region } = req.query;
    const result = region
      ? await pool.query("SELECT * FROM problems WHERE region = $1 ORDER BY created_at DESC LIMIT 300", [region])
      : await pool.query("SELECT * FROM problems ORDER BY created_at DESC LIMIT 300");
    res.set("Cache-Control", "public, max-age=15");
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Logged-in users only: submitting a report requires an account, so a
// single bad actor can't anonymously flood the feed or burn through your
// DeepSeek quota. The DeepSeek key itself never leaves the server — the
// browser just sends the report; this endpoint calls DeepSeek itself using
// the key an admin set via PUT /api/admin/settings.
router.post("/", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const { region, category, severity, titleRu, titleEn, imageDataUrl } = req.body || {};
    if (!region || !titleRu || !titleEn) {
      return res.status(400).json({ error: "region, titleRu and titleEn are required." });
    }

    let aiVerdict = null;
    const settings = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
    if (settings?.deepseek_api_key && imageDataUrl) {
      try {
        const aiRes = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.deepseek_api_key}` },
          body: JSON.stringify({
            model: "deepseek-v4-flash-vision-exp",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: `Look at this photo of a reported civic issue and describe in 1-2 sentences whether it looks genuine. User description: ${titleRu || titleEn}` },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            }],
            max_tokens: 200,
          }),
        });
        if (aiRes.ok) {
          const data = await aiRes.json();
          aiVerdict = data?.choices?.[0]?.message?.content || null;
        }
      } catch {
        aiVerdict = null; // AI review is best-effort; a failed call shouldn't block the report
      }
    }

    const result = await pool.query(
      `INSERT INTO problems (region, category, severity, status, title_ru, title_en, image_data, ai_verdict, created_by)
       VALUES ($1,$2,$3,'new',$4,$5,$6,$7,$8) RETURNING *`,
      [region, category || "other", severity || "med", titleRu, titleEn, imageDataUrl || null, aiVerdict, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admin-only: the final call on any report.
router.patch("/:id", requireAdmin, writeLimiter, async (req, res, next) => {
  try {
    const { status, severity, category } = req.body || {};
    const result = await pool.query(
      `UPDATE problems SET status = COALESCE($1, status), severity = COALESCE($2, severity), category = COALESCE($3, category)
       WHERE id = $4 RETURNING *`,
      [status, severity, category, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, writeLimiter, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM problems WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
