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

async function upsertBatch(elements, client) {
  const rows = [];
  for (const el of elements) {
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const tags = el.tags || {};
    rows.push({
      name: tags.name || tags.brand || tags.operator || "АЗС",
      brand: tags.brand || tags.operator || null,
      region: tags["addr:region"] || tags["addr:state"] || tags["is_in:region"] || null,
      lat, lng, osmId: `${el.type}/${el.id}`
    });
  }
  if (!rows.length) return 0;

  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const n = i * 6;
    values.push(`($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},'osm',$${n+6},'RU',now())`);
    params.push(r.name, r.brand, r.region, r.lat, r.lng, r.osmId);
  });
  await client.query(`
    INSERT INTO gas_stations
      (name, brand, region_name, lat, lng, source, osm_id, country_code, updated_at)
    VALUES ${values.join(',')}
    ON CONFLICT (osm_id) DO UPDATE SET
      name=EXCLUDED.name,
      brand=EXCLUDED.brand,
      region_name=COALESCE(EXCLUDED.region_name, gas_stations.region_name),
      lat=EXCLUDED.lat,
      lng=EXCLUDED.lng,
      country_code='RU',
      updated_at=now()
  `, params);
  return rows.length;
}

async function syncRussiaStations() {
  console.log(`Russia-only station sync: tile=${STEP}°`);
  const runStartedAt = new Date();
  let total = 0, tiles = 0, successfulTiles = 0;

  // IMPORTANT: every tile is committed on its own. Stations appear on the map
  // as soon as their tile is imported, and a restart / spin-down of the host
  // in the middle of the run no longer throws away everything already done.
  for (let lat = MIN_LAT; lat < MAX_LAT; lat += STEP) {
    for (let lng = MIN_LNG; lng < MAX_LNG; lng += STEP) {
      const bbox = `${lat},${lng},${Math.min(lat + STEP, MAX_LAT)},${Math.min(lng + STEP, MAX_LNG)}`;
      tiles++;
      try {
        const elements = await fetchTile(bbox);
        const client = await pool.connect();
        let added = 0;
        try {
          // chunk to stay far below the 65535 bind-parameter limit
          for (let i = 0; i < elements.length; i += 2000) {
            added += await upsertBatch(elements.slice(i, i + 2000), client);
          }
        } finally { client.release(); }
        successfulTiles++;
        total += added;
        console.log(`[stations] ${tiles} ${bbox}: ${elements.length} objects, ${added} upserted`);
      } catch (err) {
        console.error(`[stations] ${tiles} FAILED ${bbox}: ${err.message}`);
      }
      await sleep(500);
    }
  }

  // Purge only after a fully successful run: rows not touched in this run
  // (updated_at older than the run start) are no longer in OSM.
  if (successfulTiles === tiles) {
    await pool.query(
      `DELETE FROM gas_stations WHERE source='osm' AND country_code='RU' AND updated_at < $1`,
      [runStartedAt]
    );
  } else {
    console.warn(`[stations] keeping stale RU rows because only ${successfulTiles}/${tiles} tiles succeeded`);
  }
  await pool.query(`DELETE FROM gas_stations WHERE source='osm' AND COALESCE(country_code,'') <> 'RU'`);

  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM gas_stations WHERE country_code='RU'`);
  console.log(`Russia station sync complete. ${total} objects processed; ${count.rows[0].count} RU stations cached.`);
  return { total, tiles, successfulTiles, count: count.rows[0].count, complete: successfulTiles === tiles };
}

// Holds a Postgres advisory lock for the WHOLE run, so two overlapping
// instances (e.g. during a Render deploy) never import at the same time.
async function runDailyRussiaStationSync() {
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('safetyroad:russia-stations-sync')) AS locked`);
    if (!lock.rows[0].locked) return { skipped: true, reason: 'already-running' };
    try {
      const due = await pool.query(`SELECT last_finished_at FROM external_sync_state WHERE sync_key='daily_russia_stations'`);
      const last = due.rows[0]?.last_finished_at ? new Date(due.rows[0].last_finished_at).getTime() : 0;
      const have = await pool.query(`SELECT COUNT(*)::int AS c FROM gas_stations WHERE country_code='RU'`);
      if (last && have.rows[0].c > 0 && Date.now() - last < 24 * 60 * 60 * 1000) {
        return { skipped: true, reason: 'not-due', last_finished_at: new Date(last).toISOString() };
      }
      await pool.query(`
        INSERT INTO external_sync_state(sync_key,status,last_started_at,last_error)
        VALUES ('daily_russia_stations','running',now(),NULL)
        ON CONFLICT(sync_key) DO UPDATE SET status='running',last_started_at=now(),last_error=NULL
      `);
      const result = await syncRussiaStations();
      if (result.complete) {
        await pool.query(`UPDATE external_sync_state SET status='ok',last_finished_at=now(),last_error=NULL WHERE sync_key='daily_russia_stations'`);
      } else {
        // not finished: leave last_finished_at alone so the next hourly tick retries
        await pool.query(`UPDATE external_sync_state SET status='partial',last_error=$1 WHERE sync_key='daily_russia_stations'`,
          [`only ${result.successfulTiles}/${result.tiles} tiles succeeded`]);
      }
      // Prices can only be matched to stations that exist, so refresh them now.
      try { await require('./sync-prices').syncPrices(); }
      catch (e) { console.warn('[stations] price refresh after import failed:', e.message); }
      return { scheduled: true, ...result };
    } catch (err) {
      await pool.query(`UPDATE external_sync_state SET status='error',last_error=$1 WHERE sync_key='daily_russia_stations'`,
        [String(err.message || err).slice(0, 2000)]).catch(() => {});
      throw err;
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext('safetyroad:russia-stations-sync'))`).catch(() => {});
    }
  } finally { lockClient.release(); }
}

function startDailyRussiaStationSyncScheduler() {
  const run = () => runDailyRussiaStationSync()
    .then(result => { if (result?.scheduled) console.log('[stations] daily sync completed:', result); })
    .catch(err => console.error('[stations] daily sync failed:', err));
  // Deliberately do not await this. The HTTP server must start immediately.
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncRussiaStations, runDailyRussiaStationSync, startDailyRussiaStationSyncScheduler };

if (require.main === module) {
  syncRussiaStations().then(async result => {
    console.log(JSON.stringify(result));
    await pool.end();
  }).catch(async err => {
    console.error('Russia-only station sync failed:', err);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
}
