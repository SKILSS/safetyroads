// ---------------------------------------------------------------------------
// Keeps gas station PRICES current by pulling them from a paid/official
// price provider (there is no free live price feed for Russian АЗС — see
// scripts/sync-stations.js for why locations and prices are handled
// separately).
//
// This is a generic adapter, not a finished integration with any specific
// provider — you still need to:
//   1. Get access to a provider (e.g. https://benzup.ru/apiprice, or your
//      region's own monitoring service) and its API docs.
//   2. Set its endpoint + your Bearer token once, as an admin, either via
//      the Settings screen (Admin panel > "АЗС") or directly:
//        PUT /api/admin/settings   { "priceApiUrl": "...", "priceApiKey": "..." }
//   3. Adjust `extractStations()` below to match the EXACT field names your
//      provider returns (this script guesses a few common ones, but every
//      provider's JSON shape is different).
//
// This now runs automatically every 24 hours as long as the backend server
// is running (see server.js, which calls syncPrices() on startup and then
// on a 24h setInterval). You can still run it by hand at any time:
//   node backend/scripts/sync-prices.js
// or on your own external schedule (cron, Render Cron Job, GitHub Action) —
// running it more than once in the same day is harmless, just wasted calls.
//
// Matching a provider's stations to the ones already in gas_stations (added
// by scripts/sync-stations.js from OpenStreetMap) is done by nearest
// coordinates, since the two systems don't share IDs. MATCH_RADIUS_METERS
// controls how close a provider station has to be to count as "the same"
// station — tune it if you get too many/too few matches.
// ---------------------------------------------------------------------------
require("dotenv").config();
const { pool } = require("../db");

const MATCH_RADIUS_METERS = 150;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Tries a handful of common key names so this has a chance of working
// out-of-the-box; ADJUST to your provider's real response shape.
function extractStations(payload) {
  const list = payload.result || payload.data || payload.stations || payload;
  if (!Array.isArray(list)) throw new Error("Unrecognized response shape — edit extractStations() in this script.");
  return list.map((row) => ({
    name: row.name || row.station_name || row.title || "АЗС",
    lat: Number(row.lat ?? row.latitude ?? row.coords?.lat),
    lng: Number(row.lng ?? row.lon ?? row.longitude ?? row.coords?.lon),
    price92: row.price_92 ?? row.ai92 ?? row.a92 ?? null,
    price95: row.price_95 ?? row.ai95 ?? row.a95 ?? null,
    price98: row.price_98 ?? row.ai98 ?? row.a98 ?? null,
    priceDt: row.price_dt ?? row.dt ?? row.diesel ?? null,
  })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

// Does the actual sync. Never closes the pool — callers own the pool's
// lifecycle (the server keeps it open for the life of the process; the CLI
// entrypoint below closes it after this resolves).
async function syncPrices() {
  const settings = (await pool.query("SELECT price_api_key, price_api_url FROM app_settings WHERE id = 1")).rows[0];
  if (!settings?.price_api_url || !settings?.price_api_key) {
    console.log("[sync-prices] No price provider configured yet (Settings > Admin panel). Nothing to sync.");
    return { skipped: true };
  }

  console.log(`[sync-prices] Fetching prices from ${settings.price_api_url} ...`);
  const res = await fetch(settings.price_api_url, {
    headers: { Authorization: `Bearer ${settings.price_api_key}` },
  });
  if (!res.ok) throw new Error(`Provider request failed: ${res.status}`);
  const providerStations = extractStations(await res.json());
  console.log(`[sync-prices] Got ${providerStations.length} stations with prices from the provider.`);

  const existing = (await pool.query("SELECT id, lat, lng FROM gas_stations")).rows;
  let matched = 0;
  for (const ps of providerStations) {
    let best = null;
    let bestDist = Infinity;
    for (const ex of existing) {
      const d = haversineMeters(ps.lat, ps.lng, ex.lat, ex.lng);
      if (d < bestDist) { bestDist = d; best = ex; }
    }
    if (best && bestDist <= MATCH_RADIUS_METERS) {
      await pool.query(
        `UPDATE gas_stations SET price_92=$1, price_95=$2, price_98=$3, price_dt=$4, updated_at=now() WHERE id=$5`,
        [ps.price92, ps.price95, ps.price98, ps.priceDt, best.id]
      );
      matched++;
    } else {
      await pool.query(
        `INSERT INTO gas_stations (name, lat, lng, price_92, price_95, price_98, price_dt, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'provider', now())`,
        [ps.name, ps.lat, ps.lng, ps.price92, ps.price95, ps.price98, ps.priceDt]
      );
    }
  }
  console.log(`[sync-prices] Updated ${matched} existing stations, inserted ${providerStations.length - matched} new ones.`);
  return { matched, inserted: providerStations.length - matched };
}

module.exports = { syncPrices };

// Only run as a one-off CLI script when invoked directly (`node sync-prices.js`),
// not when required by server.js for the scheduled 24h sync.
if (require.main === module) {
  syncPrices()
    .catch((err) => {
      console.error("sync-prices failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
