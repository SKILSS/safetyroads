const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/security");

const router = express.Router();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validBbox(q) {
  const minLat = num(q.minLat), minLng = num(q.minLng);
  const maxLat = num(q.maxLat), maxLng = num(q.maxLng);
  if ([minLat,minLng,maxLat,maxLng].some(v => v === null)) return null;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
  if (maxLat <= minLat || maxLng <= minLng) return null;
  // Protect the DB and Overpass from a world-sized request.
  if ((maxLat-minLat) * (maxLng-minLng) > 25) return null;
  return { minLat, minLng, maxLat, maxLng };
}

function bboxKey(b) {
  return [b.minLat,b.minLng,b.maxLat,b.maxLng].map(v => Number(v).toFixed(2)).join(",");
}

const osmRefreshCache = new Map();
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

async function syncOsmBbox(bbox) {
  const key = bboxKey(bbox);
  const now = Date.now();
  const cached = osmRefreshCache.get(key);
  if (cached && now - cached < 10 * 60 * 1000) return;
  osmRefreshCache.set(key, now);

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="fuel"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      way["amenity"="fuel"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      relation["amenity"="fuel"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
    );
    out center tags;
  `;

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": "SafetyRoad/2.1 gas-station-sync" },
    body: query,
  });
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
  const data = await res.json();

  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const tags = el.tags || {};
    const name = tags.name || tags.brand || tags.operator || "АЗС";
    const brand = tags.brand || tags.operator || null;
    const region = tags["addr:region"] || tags["addr:state"] || tags["is_in:region"] || null;
    const osmId = `${el.type}/${el.id}`;
    await pool.query(
      `INSERT INTO gas_stations
        (name, brand, region_name, lat, lng, source, osm_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,'osm',$6,now())
       ON CONFLICT (osm_id) DO UPDATE SET
         name=EXCLUDED.name, brand=EXCLUDED.brand, region_name=COALESCE(EXCLUDED.region_name,gas_stations.region_name),
         lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`,
      [name, brand, region, lat, lng, osmId]
    );
  }
}

// Public: return stations in the current viewport. The viewport is also used
// to lazily discover missing OSM stations, so moving around the map fills the
// local cache without loading tens of thousands of markers at once.
router.get("/", async (req, res) => {
  const bbox = validBbox(req.query);
  try {
    if (bbox) {
      // Only discover OSM data at useful zoom levels; the frontend sends a
      // bounded viewport, so this remains cheap and avoids a country-wide query.
      const shouldRefresh = req.query.refresh !== "0";
      if (shouldRefresh) {
        try { await syncOsmBbox(bbox); } catch (e) {
          console.warn("[stations] OSM refresh failed:", e.message);
        }
      }
      const result = await pool.query(
        `SELECT * FROM gas_stations
         WHERE lat BETWEEN $1 AND $3 AND lng BETWEEN $2 AND $4
         ORDER BY updated_at DESC
         LIMIT 12000`,
        [bbox.minLat,bbox.minLng,bbox.maxLat,bbox.maxLng]
      );
      res.set("Cache-Control", "public, max-age=20");
      return res.json(result.rows);
    }

    const result = await pool.query("SELECT * FROM gas_stations ORDER BY updated_at DESC LIMIT 12000");
    res.set("Cache-Control", "public, max-age=30");
    res.json(result.rows);
  } catch (err) {
    console.error("[stations] GET failed:", err);
    res.status(500).json({ error: "Failed to load gas stations." });
  }
});

// Admin-only: add a station by hand.
router.post("/", requireAdmin, writeLimiter, async (req, res) => {
  const { name, brand, regionName, lat, lng, price92, price95, price98, priceDt } = req.body || {};
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "name, lat and lng are required." });
  }
  const result = await pool.query(
    `INSERT INTO gas_stations
      (name, brand, region_name, lat, lng, price_92, price_95, price_98, price_dt,
       price_source, price_kind, price_updated_at, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual','manual',now(),'manual',now())
     RETURNING *`,
    [name, brand || null, regionName || null, lat, lng, price92 ?? null, price95 ?? null, price98 ?? null, priceDt ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// Admin-only: update a station's prices.
router.patch("/:id", requireAdmin, writeLimiter, async (req, res) => {
  const { name, brand, regionName, price92, price95, price98, priceDt } = req.body || {};
  const result = await pool.query(
    `UPDATE gas_stations SET
       name = COALESCE($1, name),
       brand = COALESCE($2, brand),
       region_name = COALESCE($3, region_name),
       price_92 = COALESCE($4, price_92),
       price_95 = COALESCE($5, price_95),
       price_98 = COALESCE($6, price_98),
       price_dt = COALESCE($7, price_dt),
       price_source = 'manual',
       price_kind = 'manual',
       price_updated_at = now(),
       updated_at = now()
     WHERE id = $8 RETURNING *`,
    [name, brand, regionName, price92, price95, price98, priceDt, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
  res.json(result.rows[0]);
});

router.delete("/:id", requireAdmin, writeLimiter, async (req, res) => {
  await pool.query("DELETE FROM gas_stations WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

module.exports = router;
