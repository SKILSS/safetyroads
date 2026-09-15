// Russia-wide road issue sync from OSM: construction, road closures and access restrictions.
require("dotenv").config();
const { pool } = require("../db");
const OVERPASS_URL = process.env.OVERPASS_URL || "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

async function fetchRoadProblems() {
  const query = `
    [out:json][timeout:900][maxsize:1073741824];
    area["ISO3166-1"="RU"][admin_level=2]->.ru;
    (
      way["highway"="construction"](area.ru);
      way["construction"](area.ru);
      way["road:closed"](area.ru);
      way["access"~"^(no|private)$"](area.ru);
      way["motor_vehicle"="no"](area.ru);
      way["vehicle"="no"](area.ru);
      node["barrier"="road_closure"](area.ru);
      node["road:closed"](area.ru);
    );
    out center tags;
  `;
  const res = await fetch(OVERPASS_URL,{method:"POST",headers:{"Content-Type":"text/plain"},body:query});
  if(!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
  return (await res.json()).elements;
}

function classify(tags={}) {
  if (tags["road:closed"] === "yes" || tags.barrier === "road_closure" || tags.access === "no") return ["closure","high","Перекрытие дороги","Road closure"];
  if (tags.motor_vehicle === "no" || tags.vehicle === "no") return ["restriction","high","Ограничение движения","Traffic restriction"];
  return ["construction","med","Дорожные работы","Road construction"];
}

async function syncRoadProblems() {
  const elements = await fetchRoadProblems();
  const seen=[];
  for(const el of elements){
    const tags=el.tags||{}; const lat=el.lat??el.center?.lat; const lng=el.lon??el.center?.lon;
    if(!Number.isFinite(lat)||!Number.isFinite(lng)) continue;
    const [category,severity,titleRu,titleEn]=classify(tags);
    const osmId=`${el.type}/${el.id}`; seen.push(osmId);
    const sourceUrl=`https://www.openstreetmap.org/${el.type}/${el.id}`;
    const titleRuFull = tags.name ? `${titleRu}: ${tags.name}` : titleRu;
    const titleEnFull = tags.name ? `${titleEn}: ${tags.name}` : titleEn;
    await pool.query(`
      INSERT INTO problems(region,category,severity,status,title_ru,title_en,lat,lng,is_road,source,source_url,source_updated_at,created_at)
      VALUES('Россия',$1,$2,'confirmed',$3,$4,$5,$6,false,'OpenStreetMap',$7,now(),now())
      ON CONFLICT (source_url) DO UPDATE SET
        severity=EXCLUDED.severity, category=EXCLUDED.category, title_ru=EXCLUDED.title_ru, title_en=EXCLUDED.title_en,
        lat=EXCLUDED.lat, lng=EXCLUDED.lng, source_updated_at=now(), status='confirmed'
    `,[category,severity,titleRuFull,titleEnFull,lat,lng,sourceUrl]);
  }
  // Remove only automatically imported OSM problems that are no longer present.
  if(seen.length) await pool.query(`DELETE FROM problems WHERE source='OpenStreetMap' AND NOT (source_url = ANY($1::text[]))`, [seen.map(id=>`https://www.openstreetmap.org/${id}`)]);
  console.log(`Russia-wide road issue sync complete: ${elements.length}`);
  return elements.length;
}
module.exports={syncRoadProblems};
if(require.main===module) syncRoadProblems().then(()=>pool.end()).catch(e=>{console.error(e);process.exit(1);});
