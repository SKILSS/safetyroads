// Russia-wide gas station location sync from OpenStreetMap/Overpass.
// Exact station prices are supplied by the optional Benzup adapter in sync-prices.js.
require("dotenv").config();
const { pool } = require("../db");

const OVERPASS_URL = process.env.OVERPASS_URL || "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
const SOURCE_URL = "https://www.openstreetmap.org/";

async function fetchStations() {
  const query = `
    [out:json][timeout:900][maxsize:1073741824];
    area["ISO3166-1"="RU"][admin_level=2]->.ru;
    nwr["amenity"="fuel"](area.ru);
    out center tags;
  `;
  const res = await fetch(OVERPASS_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: query });
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
  const data = await res.json();
  return data.elements.map(el => {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const tags = el.tags || {};
    return {
      osmId: `${el.type}/${el.id}`,
      name: tags.name || tags.brand || tags.operator || "АЗС",
      brand: tags.brand || tags.operator || null,
      lat, lng,
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`
    };
  }).filter(Boolean);
}

async function upsert(s) {
  await pool.query(`
    INSERT INTO gas_stations (name, brand, lat, lng, source, osm_id, source_updated_at, source_url, updated_at)
    VALUES ($1,$2,$3,$4,'osm',$5,now(),$6,now())
    ON CONFLICT (osm_id) DO UPDATE SET
      name=EXCLUDED.name, brand=EXCLUDED.brand, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
      source_updated_at=EXCLUDED.source_updated_at, source_url=EXCLUDED.source_url, updated_at=now()
  `, [s.name, s.brand, s.lat, s.lng, s.osmId, s.sourceUrl]);
}

async function syncStations() {
  console.log("Fetching all Russian fuel stations from Overpass...");
  const stations = await fetchStations();
  for (const s of stations) await upsert(s);
  // Remove OSM stations that disappeared from the latest full snapshot.
  // This keeps the database representative of the current Russia-wide OSM dataset.
  if (stations.length) {
    const ids = stations.map(s => s.osmId);
    await pool.query(`DELETE FROM gas_stations WHERE source='osm' AND NOT (osm_id = ANY($1::text[]))`, [ids]);
  }
  console.log(`Russia-wide station sync complete: ${stations.length}`);
  return stations.length;
}
module.exports = { syncStations };
if (require.main === module) syncStations().then(()=>pool.end()).catch(e=>{console.error(e);process.exit(1);});
