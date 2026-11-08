// Russia-only fuel price synchronization.
// The server runs this job once every 24 hours. Data is fetched from the
// Internet. If an exact station-level provider is configured, its station
// prices take priority. Otherwise the public Ехай feed is used as a clearly
// labelled brand/region median and is never presented as an exact pump quote.
require("dotenv").config();
const { pool } = require("../db");

const MATCH_RADIUS_METERS = 200;
const OPEN_PRICE_URL = "https://eh-ai.ru/assets/prices.json";
const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function value(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractStations(payload) {
  const list = payload.stations || payload.result || payload.data || [];
  if (!Array.isArray(list)) return [];
  return list.map((row) => ({
    name: row.name || row.station_name || row.title || "АЗС",
    brand: row.brand || row.operator || null,
    region: row.region || row.region_name || row.area || null,
    lat: Number(row.lat ?? row.latitude ?? row.coords?.lat),
    lng: Number(row.lng ?? row.lon ?? row.longitude ?? row.coords?.lon),
    price92: value(row.price_92 ?? row.ai92 ?? row.a92),
    price95: value(row.price_95 ?? row.ai95 ?? row.a95),
    price98: value(row.price_98 ?? row.ai98 ?? row.a98),
    priceDt: value(row.price_dt ?? row.dt ?? row.diesel),
  })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

async function syncOpenPrices() {
  const res = await fetch(OPEN_PRICE_URL, {
    headers: { "User-Agent": "SafetyRoad/2.2 (Russia-only-fuel-price-cache)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Ехай price feed failed: ${res.status}`);
  const payload = await res.json();

  // If the feed contains station-level coordinates, prefer them.
  const providerStations = extractStations(payload);
  const existing = (await pool.query(
    `SELECT id,lat,lng FROM gas_stations WHERE country_code='RU'`
  )).rows;

  let exactFromOpen = 0;
  for (const ps of providerStations) {
    if ([ps.price92,ps.price95,ps.price98,ps.priceDt].every(v => v === null)) continue;
    let best = null, bestDist = Infinity;
    for (const ex of existing) {
      const d = haversineMeters(ps.lat, ps.lng, ex.lat, ex.lng);
      if (d < bestDist) { bestDist = d; best = ex; }
    }
    if (best && bestDist <= MATCH_RADIUS_METERS) {
      await pool.query(
        `UPDATE gas_stations SET
          price_92=COALESCE($1,price_92),
          price_95=COALESCE($2,price_95),
          price_98=COALESCE($3,price_98),
          price_dt=COALESCE($4,price_dt),
          price_source=$5, price_kind='exact', price_updated_at=now(), updated_at=now()
         WHERE id=$6 AND country_code='RU'`,
        [ps.price92,ps.price95,ps.price98,ps.priceDt,OPEN_PRICE_URL,best.id]
      );
      exactFromOpen++;
    }
  }

  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const brands = Array.isArray(payload.brands) ? payload.brands : [];
  const stations = (await pool.query(
    `SELECT id,name,brand,region_name,price_kind
       FROM gas_stations
      WHERE country_code='RU'`
  )).rows;

  let updated = exactFromOpen;
  for (const st of stations) {
    if (st.price_kind === "manual" || st.price_kind === "exact") continue;

    const brandNorm = normalize(st.brand || st.name);
    const regionNorm = normalize(st.region_name);
    const brandRow = brands.find(b => {
      const bn = normalize(b.name);
      return bn && brandNorm && (brandNorm === bn || brandNorm.includes(bn) || bn.includes(brandNorm));
    });
    const regionRow = regions.find(r => {
      const rn = normalize(r.name);
      return rn && regionNorm && (regionNorm === rn || regionNorm.includes(rn) || rn.includes(regionNorm));
    });

    const row = brandRow || regionRow;
    if (!row) continue;

    const kind = brandRow ? "brand_median" : "region_median";
    const source = "Ехай (eh-ai.ru)";
    const p92 = value(row.ai92), p95 = value(row.ai95), p98 = value(row.ai98), dt = value(row.dt);
    if ([p92,p95,p98,dt].every(v => v === null)) continue;

    await pool.query(
      `UPDATE gas_stations SET
        price_92=COALESCE($1,price_92),
        price_95=COALESCE($2,price_95),
        price_98=COALESCE($3,price_98),
        price_dt=COALESCE($4,price_dt),
        price_source=$5, price_kind=$6,
        price_updated_at=to_timestamp($7), updated_at=now()
       WHERE id=$8 AND country_code='RU'`,
      [p92,p95,p98,dt,source,kind,
       Number(payload.updated || Math.floor(Date.now()/1000)),st.id]
    );
    updated++;
  }
  return { updated, exactFromOpen, updatedAt: payload.updated_h || null };
}

async function syncExactProvider(settings) {
  const res = await fetch(settings.price_api_url, {
    headers: {
      Authorization: `Bearer ${settings.price_api_key}`,
      "User-Agent": "SafetyRoad/2.2 (Russia-only-fuel-price-cache)"
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Provider request failed: ${res.status}`);
  const providerStations = extractStations(await res.json());
  const existing = (await pool.query(
    "SELECT id,lat,lng FROM gas_stations WHERE country_code='RU'"
  )).rows;
  let matched = 0;

  for (const ps of providerStations) {
    let best = null, bestDist = Infinity;
    for (const ex of existing) {
      const d = haversineMeters(ps.lat, ps.lng, ex.lat, ex.lng);
      if (d < bestDist) { bestDist = d; best = ex; }
    }
    // Never insert a provider station we cannot prove belongs to the RU cache.
    if (best && bestDist <= MATCH_RADIUS_METERS) {
      await pool.query(
        `UPDATE gas_stations SET
          price_92=$1,price_95=$2,price_98=$3,price_dt=$4,
          price_source=$5,price_kind='exact',price_updated_at=now(),updated_at=now()
         WHERE id=$6 AND country_code='RU'`,
        [ps.price92,ps.price95,ps.price98,ps.priceDt,settings.price_api_url,best.id]
      );
      matched++;
    }
  }
  return { matched, ignoredUnmatched: providerStations.length - matched };
}

async function syncPrices() {
  let open = null;
  try {
    open = await syncOpenPrices();
    console.log(`[sync-prices] Internet feed: updated ${open.updated}, exact ${open.exactFromOpen}, snapshot ${open.updatedAt || "unknown"}`);
  } catch (err) {
    console.warn("[sync-prices] Internet feed failed:", err.message);
  }

  const settings = (await pool.query(
    "SELECT price_api_key,price_api_url FROM app_settings WHERE id=1"
  )).rows[0];

  if (!settings?.price_api_url || !settings?.price_api_key) {
    console.log("[sync-prices] No exact station provider configured; keeping Internet feed prices/medians.");
    return { open, skippedExact: true };
  }

  const exact = await syncExactProvider(settings);
  console.log(`[sync-prices] Exact provider: matched ${exact.matched}, ignored ${exact.ignoredUnmatched}.`);
  return { open, exact };
}

async function runDailyPriceSync() {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('safetyroad:russia-prices-sync')) AS locked`
    );
    locked = !!lock.rows[0].locked;
    if (!locked) return { skipped: true, reason: "already-running" };

    const due = await client.query(
      `SELECT last_finished_at FROM external_sync_state WHERE sync_key='daily_russia_prices'`
    );
    const last = due.rows[0]?.last_finished_at
      ? new Date(due.rows[0].last_finished_at).getTime() : 0;

    if (last && Date.now() - last < DAY_MS) {
      return { skipped: true, reason: "not-due", last_finished_at: new Date(last).toISOString() };
    }

    await client.query(`
      INSERT INTO external_sync_state(sync_key,status,last_started_at,last_error)
      VALUES ('daily_russia_prices','running',now(),NULL)
      ON CONFLICT(sync_key) DO UPDATE SET
        status='running',last_started_at=now(),last_error=NULL
    `);
  } finally {
    if (locked) await client.query(
      "SELECT pg_advisory_unlock(hashtext('safetyroad:russia-prices-sync'))"
    ).catch(() => {});
    client.release();
  }

  try {
    const result = await syncPrices();
    await pool.query(`
      UPDATE external_sync_state
         SET status='ok',last_finished_at=now(),last_error=NULL
       WHERE sync_key='daily_russia_prices'
    `);
    return { scheduled: true, ...result };
  } catch (err) {
    await pool.query(`
      UPDATE external_sync_state
         SET status='error',last_finished_at=now(),last_error=$1
       WHERE sync_key='daily_russia_prices'
    `, [String(err.message || err).slice(0,2000)]).catch(() => {});
    throw err;
  }
}

module.exports = { syncPrices, runDailyPriceSync };

if (require.main === module) {
  syncPrices()
    .catch((err) => { console.error("sync-prices failed:", err); process.exitCode = 1; })
    .finally(() => pool.end());
}
