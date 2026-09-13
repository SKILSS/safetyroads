const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/security");

const router = express.Router();

// Public: the map needs this with no login, same as /api/problems.
router.get("/", async (req, res) => {
  const result = await pool.query("SELECT * FROM gas_stations ORDER BY updated_at DESC LIMIT 2000");
  res.set("Cache-Control", "public, max-age=30");
  res.json(result.rows);
});

// Admin-only: add a station by hand (when you don't want to run the OSM sync script).
router.post("/", requireAdmin, writeLimiter, async (req, res) => {
  const { name, brand, lat, lng, price92, price95, price98, priceDt } = req.body || {};
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "name, lat and lng are required." });
  }
  const result = await pool.query(
    `INSERT INTO gas_stations (name, brand, lat, lng, price_92, price_95, price_98, price_dt, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual', now()) RETURNING *`,
    [name, brand || null, lat, lng, price92 ?? null, price95 ?? null, price98 ?? null, priceDt ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// Admin-only: update a station's prices (this is how prices actually get kept
// current, since there is no free live price feed — see scripts/sync-stations.js).
router.patch("/:id", requireAdmin, writeLimiter, async (req, res) => {
  const { name, brand, price92, price95, price98, priceDt } = req.body || {};
  const result = await pool.query(
    `UPDATE gas_stations SET
       name = COALESCE($1, name),
       brand = COALESCE($2, brand),
       price_92 = COALESCE($3, price_92),
       price_95 = COALESCE($4, price_95),
       price_98 = COALESCE($5, price_98),
       price_dt = COALESCE($6, price_dt),
       updated_at = now()
     WHERE id = $7 RETURNING *`,
    [name, brand, price92, price95, price98, priceDt, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
  res.json(result.rows[0]);
});

router.delete("/:id", requireAdmin, writeLimiter, async (req, res) => {
  await pool.query("DELETE FROM gas_stations WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
