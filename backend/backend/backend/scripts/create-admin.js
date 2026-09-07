// Run once after deploying: npm run create-admin
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env, creates (or promotes) that
// user to role='admin'. This is the ONLY way an admin account gets made —
// the public /register endpoint always creates plain 'user' accounts.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, initSchema } = require("../db");

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  await initSchema();
  const hash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'`,
    [email.toLowerCase(), hash]
  );
  console.log(`Admin account ready: ${email}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/security");

const router = express.Router();

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
        aiVerdict = null;
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