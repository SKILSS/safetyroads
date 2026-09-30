// ---------------------------------------------------------------------------
// Full Russia-only gas-station synchronizer.
//
// Source: OpenStreetMap via Overpass. This imports mapped objects tagged
// amenity=fuel inside the official OSM RU boundary, including nodes/ways/
// relations. It deliberately does NOT query neighbouring countries.
//
// Usage:
//   node scripts/sync-stations-russia.js
//
// Optional:
//   OVERPASS_URL=https://overpass-api.de/api/interpreter
//   STATION_TILE_DEGREES=10
//
// The script uses longitude/latitude tiles because a single country-wide
// Overpass request is too large. osm_id makes the operation idempotent.
// Prices are intentionally untouched; see sync-prices.js for price syncing.
// ---------------------------------------------------------------------------
require("dotenv").config();
const { pool } = require("../db");

const OVERPASS_URLS = String(
  process.env.OVERPASS_URLS ||
  process.env.OVERPASS_URL ||
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter"
).split(",").map(s => s.trim()).filter(Boolean);

const STEP = Math.max(2, Number(process.env.STATION_TILE_DEGREES || 10));
const MIN_LAT = 41;
const MAX_LAT = 83;
const MIN_LNG = 19;
const MAX_LNG = 181;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTile(bbox, attempt = 0) {
  const query = `
    [out:json][timeout:180];
    area["ISO3166-1"="RU"][boundary="administrative"]->.russia;
    (
      node["amenity"="fuel"](area.russia)(${bbox});
      way["amenity"="fuel"](area.russia)(${bbox});
      relation["amenity"="fuel"](area.russia)(${bbox});
    );
    out center tags;
  `;

  for (let i = 0; i < OVERPASS_URLS.length; i++) {
    const url = OVERPASS_URLS[(attempt + i) % OVERPASS_URLS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "SafetyRoad/2.1 Russia-only station sync"
        },
        body: query,
        signal: AbortSignal.timeout(240000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data.elements) ? data.elements : [];
    } catch (err) {
      console.warn(`Overpass failed (${url}) for ${bbox}: ${err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed for tile ${bbox}`);
}

async function upsert(el) {
  const lat = Number(el.lat ?? el.center?.lat);
  const lng = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  const tags = el.tags || {};
  const name = tags.name || tags.brand || tags.operator || "АЗС";
  const brand = tags.brand || tags.operator || null;
  const region = tags["addr:region"] || tags["addr:state"] || tags["is_in:region"] || null;
  const osmId = `${el.type}/${el.id}`;

  await pool.query(
    `INSERT INTO gas_stations
      (name, brand, region_name, lat, lng, source, osm_id, country_code, updated_at)
     VALUES ($1,$2,$3,$4,$5,'osm',$6,'RU',now())
     ON CONFLICT (osm_id) DO UPDATE SET
       name=EXCLUDED.name,
       brand=EXCLUDED.brand,
       region_name=COALESCE(EXCLUDED.region_name, gas_stations.region_name),
       lat=EXCLUDED.lat,
       lng=EXCLUDED.lng,
       country_code='RU',
       updated_at=now()`,
    [name, brand, region, lat, lng, osmId]
  );
  return true;
}

async function main() {
  console.log(`Russia-only station sync: tile=${STEP}°`);
  console.log(`Overpass endpoints: ${OVERPASS_URLS.join(", ")}`);

  const seen = new Set();
  let total = 0;
  let tiles = 0;

  // Broad geographic envelope only; the Overpass RU area is the authoritative
  // country boundary, so foreign points inside the rectangle are excluded.
  for (let lat = MIN_LAT; lat < MAX_LAT; lat += STEP) {
    for (let lng = MIN_LNG; lng < MAX_LNG; lng += STEP) {
      const south = lat;
      const west = lng;
      const north = Math.min(lat + STEP, MAX_LAT);
      const east = Math.min(lng + STEP, MAX_LNG);
      const bbox = `${south},${west},${north},${east}`;
      tiles++;

      try {
        const elements = await fetchTile(bbox);
        let added = 0;
        for (const el of elements) {
          const id = `${el.type}/${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (await upsert(el)) { added++; total++; }
        }
        console.log(`[${tiles}] ${bbox}: ${elements.length} OSM objects, ${added} new/updated`);
      } catch (err) {
        console.error(`[${tiles}] FAILED ${bbox}: ${err.message}`);
      }

      await sleep(700);
    }
  }

  // Remove old OSM records that are not RU-tagged. This is a final safety net
  // for databases created by earlier versions of SafetyRoad.
  const cleaned = await pool.query(
    `DELETE FROM gas_stations
     WHERE source='osm' AND COALESCE(country_code,'') <> 'RU'
     RETURNING id`
  );

  const count = await pool.query(
    `SELECT COUNT(*)::int AS count FROM gas_stations WHERE country_code='RU'`
  );

  console.log(`Done. ${total} objects processed; removed ${cleaned.rowCount} non-RU OSM rows.`);
  console.log(`RU stations currently in DB: ${count.rows[0].count}`);
  await pool.end();
}

main().catch(err => {
  console.error("Russia-only station sync failed:", err);
  process.exit(1);
});
