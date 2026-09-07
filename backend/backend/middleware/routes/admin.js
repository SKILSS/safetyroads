const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../auth");

const router = express.Router();

router.get("/settings", requireAdmin, async (req, res, next) => {
  try {
    const row = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
    res.json({ deepseekKeySet: !!row?.deepseek_api_key });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requireAdmin, async (req, res, next) => {
  try {
    const { deepseekApiKey } = req.body || {};
    if (typeof deepseekApiKey !== "string") return res.status(400).json({ error: "deepseekApiKey (string) required." });
    await pool.query("UPDATE app_settings SET deepseek_api_key = $1 WHERE id = 1", [deepseekApiKey || null]);
    res.json({ deepseekKeySet: !!deepseekApiKey });
  } catch (err) {
    next(err);
  }
});

module.exports = router;