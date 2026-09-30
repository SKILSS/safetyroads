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

const RUSSIA_AREA_QUERY = `area["ISO3166-1"="RU"][boundary="administrative"]->.russia;`;

// External collection is intentionally restricted to the Russian Federation.
// Using the OSM country boundary avoids the old rectangular bboxes, which also
// covered neighbouring countries.
const RUSSIA_CONTEXT_RE = /(?:росси(?:я|и|йский|йская|йское|йские)|рф|российск\w*|москв\w*|санкт[- ]?петербург\w*|ленинградск\w*|московск\w*|краснодарск\w*|ростовск\w*|воронежск\w*|нижегородск\w*|самарск\w*|свердловск\w*|новосибирск\w*|тюменск\w*|омск\w*|иркутск\w*|красноярск\w*|приморск\w*|хабаровск\w*|кемеровск\w*|челябинск\w*|пермск\w*|башкортостан\w*|татарстан\w*|дагестан\w*|крым\w*|севастопол\w*|алтайск\w*|бурят\w*|карели\w*|коми\w*|мордов\w*|удмурт\w*|чуваш\w*|якут\w*|саха\w*)/i;


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

async function insertExternal({ externalId, region, category, severity, titleRu, titleEn, lat, lng, sourceType, sourceName, sourceUrl, sourceReason }) {
  if (!externalId) return false;
  const exists = await pool.query('SELECT id FROM problems WHERE source_type=$1 AND external_id=$2 LIMIT 1', [sourceType, externalId]);
  if (exists.rows.length) {
    await pool.query('UPDATE problems SET source_last_seen_at=now() WHERE id=$1', [exists.rows[0].id]);
    return false;
  }
  await pool.query(`
    INSERT INTO problems
      (region, category, severity, status, title_ru, title_en, lat, lng, created_by,
       source_type, source_name, source_url, external_id, imported_at, source_last_seen_at, source_reason)
    VALUES ($1,$2,$3,'new',$4,$5,$6,$7,NULL,$8,$9,$10,$11,now(),now(),$12)
  `, [region || 'Россия', category, severity, clamp(titleRu, 300), clamp(titleEn || titleRu, 300), lat, lng,
      sourceType, clamp(sourceName, 120), clamp(sourceUrl, 1000), externalId, clamp(sourceReason, 500)]);
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
  const q = `[out:json][timeout:300];${RUSSIA_AREA_QUERY}(` +
    `nwr["hazard"](area.russia);` +
    `nwr["surface"="mud"](area.russia);` +
    `nwr["smoothness"~"^(very_bad|horrible|impassable)$"](area.russia);` +
    `nwr["highway"="construction"](area.russia);` +
    `nwr["roadworks"](area.russia);` +
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
        sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        sourceReason: `Внешние данные OpenStreetMap: обнаружен признак «${c.kind}» в тегах объекта.`
      }) ? 1 : 0;
    }
  } catch (e) { console.error('[external/osm] Russia area query failed:', e.message); }
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
        const russianContext = `${title} ${text}`;
        if (!RUSSIA_CONTEXT_RE.test(russianContext)) continue;
        const c = classify(title, text);
        const region = normalizeRegion(russianContext) || 'Россия';
        const sourceUrl = item.link || url;
        const externalId = `rss:${hashId(sourceUrl + '|' + (item.guid || title))}`;
        inserted += await insertExternal({ externalId, region, category: c.category, severity: c.severity,
          titleRu: title, titleEn: `Road issue: ${c.kind}`, lat: null, lng: null,
          sourceType: 'rss', sourceName: feed.title || 'RSS', sourceUrl,
          sourceReason: `Внешний источник: публикация о дорожной проблеме в РФ (${c.kind}).` }) ? 1 : 0;
      }
    } catch (e) { console.error('[external/rss] feed failed:', url, e.message); }
    await sleep(500);
  }
  return inserted;
}

async function syncExternalProblems() {
  await initSchema();
  const osm = await syncOsm();
  const rss = await syncRss();
  const staleOsm = await pool.query(`UPDATE problems SET status='resolved' WHERE source_type='osm' AND status='new' AND source_last_seen_at < now() - interval '14 days'`);
  const staleRss = await pool.query(`UPDATE problems SET status='resolved' WHERE source_type='rss' AND status='new' AND imported_at < now() - make_interval(days => $1)`, [RSS_MAX_AGE_DAYS]);
  return { ok: true, osmInserted: osm, rssInserted: rss, staleOsm: staleOsm.rowCount, staleRss: staleRss.rowCount, finishedAt: new Date().toISOString() };
}

const DAILY_SYNC_KEY = 'daily_external_problems';
const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAILY_SYNC_CHECK_MS = 60 * 60 * 1000;

async function runExternalSyncIfDue({ force = false } = {}) {
  await initSchema();
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('safetyroad:daily-external-problems')) AS locked");
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { ok: false, skipped: true, reason: 'already-running' };

    const state = await client.query(
      'SELECT last_finished_at, status FROM external_sync_state WHERE sync_key=$1 FOR UPDATE',
      [DAILY_SYNC_KEY]
    );
    const row = state.rows[0];
    const lastFinished = row?.last_finished_at ? new Date(row.last_finished_at).getTime() : 0;
    const due = force || !lastFinished || (Date.now() - lastFinished >= DAILY_SYNC_INTERVAL_MS);
    if (!due) {
      return { ok: true, skipped: true, reason: 'not-due', lastFinishedAt: row.last_finished_at };
    }

    await client.query(
      `UPDATE external_sync_state
       SET last_started_at=now(), status='running', last_error=NULL
       WHERE sync_key=$1`,
      [DAILY_SYNC_KEY]
    );

    try {
      const result = await syncExternalProblems();
      await client.query(
        `UPDATE external_sync_state
         SET last_finished_at=now(), status='success', last_error=NULL
         WHERE sync_key=$1`,
        [DAILY_SYNC_KEY]
      );
      return { ...result, scheduled: true };
    } catch (error) {
      await client.query(
        `UPDATE external_sync_state
         SET status='error', last_error=$2
         WHERE sync_key=$1`,
        [DAILY_SYNC_KEY, String(error?.message || error).slice(0, 2000)]
      );
      throw error;
    }
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('safetyroad:daily-external-problems'))"); } catch {}
    }
    client.release();
  }
}

function startDailyExternalSyncScheduler() {
  const run = () => runExternalSyncIfDue().then(result => {
    if (result?.scheduled) console.log('[external] daily sync completed:', result);
    else if (result?.skipped && result.reason !== 'not-due') console.log('[external] daily sync skipped:', result.reason);
  }).catch(err => console.error('[external] daily scheduled run failed:', err));

  // Check once after startup, then periodically. If the Web Service sleeps,
  // the next request/wakeup triggers the same check and catches up when due.
  run();
  return setInterval(run, DAILY_SYNC_CHECK_MS);
}

module.exports = { syncExternalProblems, runExternalSyncIfDue, startDailyExternalSyncScheduler };

if (require.main === module) {
  syncExternalProblems().then(async result => {
    console.log(JSON.stringify(result));
    await pool.end();
  }).catch(async e => {
    console.error('[external] fatal:', e);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
}
