const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Admin-only. Returns whether a key is set, never the key itself, so it's
// safe even if this response somehow got logged or cached somewhere.
router.get("/settings", requireAdmin, async (req, res) => {
  const row = (await pool.query("SELECT deepseek_api_key, price_api_key, price_api_url FROM app_settings WHERE id = 1")).rows[0];
  res.json({
    deepseekKeySet: !!row?.deepseek_api_key,
    priceApiKeySet: !!row?.price_api_key,
    priceApiUrl: row?.price_api_url || "",
  });
});

// Admin-only. This is the ONLY place these keys can ever be written — they
// go straight into the database and are never echoed back to any client,
// admin included, past this point (priceApiUrl isn't secret, so it IS
// echoed back above, to prefill the settings form).
router.put("/settings", requireAdmin, async (req, res) => {
  const { deepseekApiKey, priceApiKey, priceApiUrl } = req.body || {};
  const sets = [];
  const values = [];
  if (typeof deepseekApiKey === "string") { values.push(deepseekApiKey || null); sets.push(`deepseek_api_key = $${values.length}`); }
  if (typeof priceApiKey === "string") { values.push(priceApiKey || null); sets.push(`price_api_key = $${values.length}`); }
  if (typeof priceApiUrl === "string") { values.push(priceApiUrl || null); sets.push(`price_api_url = $${values.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  await pool.query(`UPDATE app_settings SET ${sets.join(", ")} WHERE id = 1`, values);
  const row = (await pool.query("SELECT deepseek_api_key, price_api_key, price_api_url FROM app_settings WHERE id = 1")).rows[0];
  res.json({
    deepseekKeySet: !!row?.deepseek_api_key,
    priceApiKeySet: !!row?.price_api_key,
    priceApiUrl: row?.price_api_url || "",
  });
});

module.exports = router;

