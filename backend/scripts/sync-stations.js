// ---------------------------------------------------------------------------
// Pulls real gas-station LOCATIONS (name, brand, coordinates) from
// OpenStreetMap's Overpass API — free, no key required — and upserts them
// into gas_stations.
//
// What this script does NOT do: fetch live fuel PRICES. There is no free,
// public, real-time price feed for Russian АЗС. Two ways to fill prices in:
//   1. Manual: an admin edits a station's price on the map (Settings > АЗС,
//      or PATCH /api/stations/:id) — same crowd-checked model as problems.
//   2. Automated: if you have access to a paid/official price provider
//      (e.g. a regional monitoring service), add a fetch() call for it
//      right where marked below and PATCH the price columns the same way
//      this script upserts locations.
//
// This does NOT run on its own — nothing in this project has a live server
// that can execute scheduled jobs for you. Run it yourself, either:
//   - by hand: `node backend/scripts/sync-stations.js`
//   - on a schedule: a cron job on your host, a Render/Railway "Cron Job",
//     or a scheduled GitHub Action that runs this and exits.
//
// Usage: node scripts/sync-stations.js [bbox]
//   bbox = "minLat,minLng,maxLat,maxLng" (default: Moscow + Moscow Region)
// ---------------------------------------------------------------------------
require("dotenv").config();
const { pool } = require("../db");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_BBOX = "55.0,36.0,56.6,38.5"; // Moscow + Moscow Region — pass your own for other regions

async function fetchStations(bbox) {
  const query = `
    [out:json][timeout:60];
    (
      node["amenity"="fuel"](${bbox});
      way["amenity"="fuel"](${bbox});
    );
    out center tags;
  `;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  });
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
  const data = await res.json();
  return data.elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (!lat || !lng) return null;
      const tags = el.tags || {};
      return {
        osmId: `${el.type}/${el.id}`,
        name: tags.name || tags.brand || "АЗС",
        brand: tags.brand || tags.operator || null,
        lat,
        lng,
      };
    })
    .filter(Boolean);
}

async function upsert(station) {
  // ON CONFLICT on osm_id: re-running this script updates location/name but
  // NEVER touches the price columns, so admin-entered prices survive re-syncs.
  await pool.query(
    `INSERT INTO gas_stations (name, brand, lat, lng, source, osm_id, updated_at)
     VALUES ($1,$2,$3,$4,'osm',$5, now())
     ON CONFLICT (osm_id) DO UPDATE SET
       name = EXCLUDED.name, brand = EXCLUDED.brand, lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
    [station.name, station.brand, station.lat, station.lng, station.osmId]
  );
}

async function main() {
  const bbox = process.argv[2] || DEFAULT_BBOX;
  console.log(`Fetching gas stations from Overpass for bbox ${bbox} ...`);
  const stations = await fetchStations(bbox);
  console.log(`Got ${stations.length} stations, upserting ...`);
  for (const s of stations) await upsert(s);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error("sync-stations failed:", err);
  process.exit(1);
});
