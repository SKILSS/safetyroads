/*
 * Daily external road/civic problem importer for SafetyRoad.
 *
 * Sources:
 *  1) OpenStreetMap/Overpass: machine-readable map tags with coordinates.
 *  2) RSS/Atom feeds configured in EXTERNAL_RSS_FEEDS (Google News RSS is a
 *     convenient default, but users should add official regional feeds too).
 *
 * This is deliberately NOT described as "all internet": there is no single
 * API containing every report in Russia, and many sites prohibit scraping.
 * The importer is source-based, deduplicated, and stores source URLs.
 */
const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { pool, initSchema } = require('../db');

const parser = new Parser({
  timeout: 25000,
  headers: { 'User-Agent': 'SafetyRoad/1.0 daily public-source importer' }
});

const OVERPASS_URLS = (process.env.OVERPASS_URLS || [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const RSS_MAX_AGE_DAYS = Number(process.env.EXTERNAL_RSS_MAX_AGE_DAYS || 7);

const RSS_FEEDS = (process.env.EXTERNAL_RSS_FEEDS || [
  'https://news.google.com/rss/search?q=Россия+ямы+дороги&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+разбитая+дорога&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+грязь+дорога&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+дорожные+работы+перекрытие&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+опасный+участок+дороги&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+просадка+дороги+провал&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+гололед+дорога&hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=Россия+подтопление+дороги&hl=ru&gl=RU&ceid=RU:ru'
].join('\n')).split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

const OVERPASS_BBOXES = [
  [41.0, 19.0, 55.0, 60.0],
  [41.0, 60.0, 55.0, 90.0],
  [41.0, 90.0, 55.0, 120.0],
  [41.0, 120.0, 55.0, 180.0],
  [55.0, 19.0, 70.0, 60.0],
  [55.0, 60.0, 70.0, 100.0],
  [55.0, 100.0, 70.0, 140.0],
  [55.0, 140.0, 70.0, 180.0],
  [70.0, 19.0, 82.0, 90.0],
  [70.0, 90.0, 82.0, 180.0]
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(s='') { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function esc(s='') { return String(s).replace(/[<>]/g, ''); }
function clamp(s, n) { return String(s || '').slice(0, n); }
function hashId(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

const categories = [
  { key: 'pothole', re: /ям|выбоин|выбоин|колдобин|разбит|разрушен.*асфальт|асфальт.*разруш/i },
  { key: 'mud', re: /гряз|грязн|глина|раскис|болот|забрызг/i },
  { key: 'roadworks', re: /ремонт дорог|дорожн.*работ|перекрыт|ограничен.*движ|строительств.*дорог/i },
  { key: 'flood', re: /подтоп|затоп|наводнен|вода.*дорог|разлив/i },
  { key: 'ice', re: /гололед|гололёд|ледян|обледен|скользк/i },
  { key: 'debris', re: /мусор|облом|камн.*дорог|предмет.*дорог|дерев.*дорог/i },
  { key: 'road_damage', re: /просад|провал|трещин.*дорог|ополз|размыв/i },
  { key: 'accident_hazard', re: /аварийн.*участ|опасн.*участ|дтп|авари[яй]/i },
  { key: 'other', re: /./ }
];

function classify(title, text='') {
  const blob = `${title} ${text}`;
  const found = categories.find(x => x.re.test(blob)) || categories.at(-1);
  const severity = /провал|затоп|наводнен|авари|опасн|перекрыт|дтп/i.test(blob) ? 'high' : /гололед|ям|выбоин|разбит|подтоп/i.test(blob) ? 'med' : 'low';
  return { category: 'road', kind: found.key, severity };
}

function normalizeRegion(text) {
  const s = String(text || '').toLowerCase();
  const known = [
    ['Москва','Москва'], ['Санкт-Петербург','Санкт-Петербург'], ['Московская область','Московская область'],
    ['Ленинградская область','Ленинградская область'], ['Краснодарский край','Краснодарский край'],
    ['Свердловская область','Свердловская область'], ['Новосибирская область','Новосибирская область'],
    ['Ростовская область','Ростовская область'], ['Татарстан','Республика Татарстан'], ['Башкортостан','Республика Башкортостан'],
    ['Дагестан','Республика Дагестан'], ['Челябинская область','Челябинская область'], ['Самарская область','Самарская область'],
    ['Нижегородская область','Нижегородская область'], ['Воронежская область','Воронежская область'],
    ['Пермский край','Пермский край'], ['Красноярский край','Красноярский край'], ['Приморский край','Приморский край'],
    ['Хабаровский край','Хабаровский край'], ['Иркутская область','Иркутская область'], ['Кемеровская область','Кемеровская область'],
    ['Омская область','Омская область'], ['Тюменская область','Тюменская область'], ['Алтайский край','Алтайский край'],
    ['Крым','Республика Крым'], ['Севастополь','Севастополь']
  ];
  for (const [needle, region] of known) if (s.includes(needle.toLowerCase())) return region;
  return null;
}

async function insertExternal({ externalId, region, category, severity, titleRu, titleEn, lat, lng, sourceType, sourceName, sourceUrl }) {
  if (!externalId) return false;
  const exists = await pool.query('SELECT id FROM problems WHERE source_type=$1 AND external_id=$2 LIMIT 1', [sourceType, externalId]);
  if (exists.rows.length) {
    await pool.query('UPDATE problems SET source_last_seen_at=now() WHERE id=$1', [exists.rows[0].id]);
    return false;
  }
  await pool.query(`
    INSERT INTO problems
      (region, category, severity, status, title_ru, title_en, lat, lng, created_by,
       source_type, source_name, source_url, external_id, imported_at)
    VALUES ($1,$2,$3,'new',$4,$5,$6,$7,NULL,$8,$9,$10,$11,now())
  `, [region || 'Россия', category, severity, clamp(titleRu, 300), clamp(titleEn || titleRu, 300), lat, lng,
      sourceType, clamp(sourceName, 120), clamp(sourceUrl, 1000), externalId]);
  return true;
}

function elementPoint(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  if (el.geometry?.length) {
    const mid = el.geometry[Math.floor(el.geometry.length / 2)];
    return [mid.lat, mid.lon];
  }
  return [null, null];
}

async function fetchOverpass(query) {
  let last;
  for (const base of OVERPASS_URLS) {
    try {
      const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SafetyRoad/1.0' }, body: new URLSearchParams({ data: query }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error('No Overpass endpoint available');
}

async function syncOsm() {
  let inserted = 0;
  for (const [s,w,n,e] of OVERPASS_BBOXES) {
    const q = `[out:json][timeout:120];(\n` +
      `nwr["hazard"](${s},${w},${n},${e});\n` +
      `nwr["surface"="mud"](${s},${w},${n},${e});\n` +
      `nwr["smoothness"~"^(very_bad|horrible|impassable)$"](${s},${w},${n},${e});\n` +
      `nwr["highway"="construction"](${s},${w},${n},${e});\n` +
      `nwr["roadworks"](${s},${w},${n},${e});\n` +
      `);out center tags;`;
    try {
      const data = await fetchOverpass(q);
      for (const el of data.elements || []) {
        const tags = el.tags || {};
        const [lat,lng] = elementPoint(el);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const raw = Object.entries(tags).map(([k,v]) => `${k}=${v}`).join(', ');
        const c = classify(raw, raw);
        const title = tags.name ? `${tags.name}: ${c.kind}` : `Дорожная проблема OSM: ${c.kind}`;
        inserted += await insertExternal({
          externalId: `osm:${el.type}:${el.id}`,
          region: normalizeRegion(tags['addr:region'] || tags['addr:state'] || tags.name) || 'Россия',
          category: c.category, severity: c.severity,
          titleRu: title, titleEn: `OSM road problem: ${c.kind}`,
          lat, lng, sourceType: 'osm', sourceName: 'OpenStreetMap',
          sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`
        }) ? 1 : 0;
      }
    } catch (e) { console.error('[external/osm] bbox failed:', e.message); }
    await sleep(1200);
  }
  return inserted;
}

async function syncRss() {
  let inserted = 0;
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of (feed.items || []).slice(0, 50)) {
        const published = item.isoDate || item.pubDate || item.published;
        if (published) {
          const ageMs = Date.now() - new Date(published).getTime();
          if (Number.isFinite(ageMs) && ageMs > RSS_MAX_AGE_DAYS * 86400000) continue;
        }
        const title = stripHtml(item.title || '');
        const text = stripHtml(item.contentSnippet || item.content || item.summary || '');
        if (!title) continue;
        const c = classify(title, text);
        const region = normalizeRegion(`${title} ${text}`) || 'Россия';
        const sourceUrl = item.link || url;
        const externalId = `rss:${hashId(sourceUrl + '|' + (item.guid || title))}`;
        inserted += await insertExternal({ externalId, region, category: c.category, severity: c.severity,
          titleRu: title, titleEn: `Road issue: ${c.kind}`, lat: null, lng: null,
          sourceType: 'rss', sourceName: feed.title || 'RSS', sourceUrl }) ? 1 : 0;
      }
    } catch (e) { console.error('[external/rss] feed failed:', url, e.message); }
    await sleep(500);
  }
  return inserted;
}

async function main() {
  await initSchema();
  const osm = await syncOsm();
  const rss = await syncRss();
  const staleOsm = await pool.query(`UPDATE problems SET status='resolved' WHERE source_type='osm' AND status='new' AND source_last_seen_at < now() - interval '14 days'`);
  const staleRss = await pool.query(`UPDATE problems SET status='resolved' WHERE source_type='rss' AND status='new' AND imported_at < now() - make_interval(days => $1)`, [RSS_MAX_AGE_DAYS]);
  console.log(JSON.stringify({ ok: true, osmInserted: osm, rssInserted: rss, staleOsm: staleOsm.rowCount, staleRss: staleRss.rowCount, finishedAt: new Date().toISOString() }));
  await pool.end();
}

main().catch(async e => { console.error('[external] fatal:', e); try { await pool.end(); } catch {} process.exit(1); });
