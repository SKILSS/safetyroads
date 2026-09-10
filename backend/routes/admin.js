const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Admin-only. Returns whether a key is set, never the key itself, so it's
// safe even if this response somehow got logged or cached somewhere.
router.get("/settings", requireAdmin, async (req, res) => {
  const row = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
  res.json({ deepseekKeySet: !!row?.deepseek_api_key });
});

// Admin-only. This is the ONLY place the DeepSeek key can ever be written —
// it goes straight into the database and is never echoed back to any
// client, admin included, past this point.
router.put("/settings", requireAdmin, async (req, res) => {
  const { deepseekApiKey } = req.body || {};
  if (typeof deepseekApiKey !== "string") return res.status(400).json({ error: "deepseekApiKey (string) required." });
  await pool.query("UPDATE app_settings SET deepseek_api_key = $1 WHERE id = 1", [deepseekApiKey || null]);
  res.json({ deepseekKeySet: !!deepseekApiKey });
});

module.exports = router;

