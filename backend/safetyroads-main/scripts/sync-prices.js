// Price synchronization.
// 1) If a paid/official station-level provider is configured, its exact
//    station prices win.
// 2) Otherwise, use the public "Ехай" feed as a clearly-labelled fallback:
//    it provides network/region medians, not an exact pump price.
// This avoids presenting an average as if it were a live station quote.
require("dotenv").config();
const { pool } = require("../db");

const MATCH_RADIUS_METERS = 150;
const OPEN_PRICE_URL = "https://eh-ai.ru/assets/prices.json";

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
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function extractStations(payload) {
  const list = payload.result || payload.data || payload.stations || payload;
  if (!Array.isArray(list)) throw new Error("Unrecognized response shape.");
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

function value(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function syncOpenPrices() {
  const res = await fetch(OPEN_PRICE_URL, {
    headers: { "User-Agent": "SafetyRoad/2.1 (fuel-price-cache)" },
  });
  if (!res.ok) throw new Error(`Ехай price feed failed: ${res.status}`);
  const payload = await res.json();
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const brands = Array.isArray(payload.brands) ? payload.brands : [];

  const stations = (await pool.query(
    `SELECT id,name,brand,region_name,price_kind FROM gas_stations`
  )).rows;

  let updated = 0;
  for (const st of stations) {
    if (st.price_kind === "manual" || st.price_kind === "exact") continue;

    const brandNorm = normalize(st.brand || st.name);
    const regionNorm = normalize(st.region_name);
    const brandRow = brands.find(b => {
      const bn = normalize(b.name);
      return bn && (brandNorm === bn || brandNorm.includes(bn) || bn.includes(brandNorm));
    });
    const regionRow = regions.find(r => {
      const rn = normalize(r.name);
      return rn && regionNorm && (regionNorm === rn || regionNorm.includes(rn) || rn.includes(regionNorm));
    });

    // Brand medians are more specific than regional medians. The source itself
    // states that these are medians from connected networks, not pump quotes.
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
        price_source=$5, price_kind=$6, price_updated_at=to_timestamp($7), updated_at=now()
       WHERE id=$8`,
      [p92,p95,p98,dt,source,kind,Number(payload.updated || Math.floor(Date.now()/1000)),st.id]
    );
    updated++;
  }
  return { updated, updatedAt: payload.updated_h || null };
}

async function syncExactProvider(settings) {
  const res = await fetch(settings.price_api_url, {
    headers: { Authorization: `Bearer ${settings.price_api_key}`, "User-Agent": "SafetyRoad/2.1" },
  });
  if (!res.ok) throw new Error(`Provider request failed: ${res.status}`);
  const providerStations = extractStations(await res.json());
  const existing = (await pool.query("SELECT id,lat,lng FROM gas_stations")).rows;
  let matched = 0;

  for (const ps of providerStations) {
    let best = null, bestDist = Infinity;
    for (const ex of existing) {
      const d = haversineMeters(ps.lat, ps.lng, ex.lat, ex.lng);
      if (d < bestDist) { bestDist = d; best = ex; }
    }
    if (best && bestDist <= MATCH_RADIUS_METERS) {
      await pool.query(
        `UPDATE gas_stations SET
          price_92=$1,price_95=$2,price_98=$3,price_dt=$4,
          price_source=$5,price_kind='exact',price_updated_at=now(),updated_at=now()
         WHERE id=$6`,
        [ps.price92,ps.price95,ps.price98,ps.priceDt,settings.price_api_url,best.id]
      );
      matched++;
    } else {
      await pool.query(
        `INSERT INTO gas_stations
          (name,lat,lng,price_92,price_95,price_98,price_dt,price_source,price_kind,price_updated_at,source,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'exact',now(),'provider',now())`,
        [ps.name,ps.lat,ps.lng,ps.price92,ps.price95,ps.price98,ps.priceDt,settings.price_api_url]
      );
    }
  }
  return { matched, inserted: providerStations.length - matched };
}

async function syncPrices() {
  let open = null;
  try {
    open = await syncOpenPrices();
    console.log(`[sync-prices] Ехай fallback: updated ${open.updated}, snapshot ${open.updatedAt || "unknown"}`);
  } catch (err) {
    console.warn("[sync-prices] Ехай fallback failed:", err.message);
  }

  const settings = (await pool.query(
    "SELECT price_api_key,price_api_url FROM app_settings WHERE id=1"
  )).rows[0];

  if (!settings?.price_api_url || !settings?.price_api_key) {
    console.log("[sync-prices] No exact station-level provider configured; keeping clearly-labelled aggregate prices.");
    return { open, skippedExact: true };
  }

  const exact = await syncExactProvider(settings);
  console.log(`[sync-prices] Exact provider: updated ${exact.matched}, inserted ${exact.inserted}.`);
  return { open, exact };
}

module.exports = { syncPrices };

if (require.main === module) {
  syncPrices()
    .catch((err) => { console.error("sync-prices failed:", err); process.exitCode = 1; })
    .finally(() => pool.end());
}
