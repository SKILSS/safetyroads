// ----- Deepseek integration helpers (в server.js) -----
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// Общая функция вызова Deepseek REST API
async function deepseekRequest(pathSuffix, method = 'POST', body = null, headers = {}) {
  if (!DEEPSEEK_API_URL || !DEEPSEEK_API_KEY) throw new Error('Deepseek not configured (DEEPSEEK_API_URL/KEY)');
  const url = DEEPSEEK_API_URL.replace(/\/$/, '') + '/' + pathSuffix.replace(/^\//, '');
  const auth = { Authorization: `Bearer ${DEEPSEEK_API_KEY}` };
  try {
    const resp = await axios({
      url,
      method,
      headers: { ...auth, ...headers },
      data: body,
      timeout: 60000,
      responseType: 'json'
    });
    return resp.data;
  } catch (err) {
    // логируем подробности на сервере (не в браузере)
    console.error('Deepseek request failed', err?.response?.status, err?.response?.data || err.message);
    throw err;
  }
}

// POST /api/deepseek/search
app.post('/api/deepseek/search', async (req, res) => {
  try {
    const { query, filters } = req.body || {};
    if (!query) return res.status(400).json({ ok:false, error: 'query required' });
    // Пример: Deepseek может ожидать body { q: "...", filters: {...} } — адаптируйте при необходимости
    const dsResp = await deepseekRequest('/search', 'POST', { q: query, filters });
    // Нормализация ответа — приведём к единому формату items[]
    const items = (dsResp.items || dsResp.results || []).map(it => ({
      id: it.id || it.sourceId || null,
      title: it.title || it.name || '',
      summary: it.summary || it.snippet || '',
      latitude: it.latitude || it.lat || null,
      longitude: it.longitude || it.lon || it.lng || null,
      status: it.status || null,
      source: it.source || null,
      raw: it
    }));
    return res.json({ ok: true, items });
  } catch (err) {
    return res.status(502).json({ ok:false, error: 'Deepseek search error', details: err?.message || String(err) });
  }
});

// POST /api/deepseek/verify-photo
// Accepts multipart/form-data with field 'photo' and optional meta JSON in 'meta'
app.post('/api/deepseek/verify-photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok:false, error: 'photo required' });

    // Если Deepseek поддерживает binary upload at /image/analyze (пример),
    // отправляем raw bytes и получаем verdict.
    // Если их API требует multipart/form-data, используем axios + FormData on node (form-data lib).
    const urlPath = '/image/analyze'; // замените на реальный путь Deepseek
    // Пример отправки бинарного тела (если поддерживается)
    const dsResp = await axios.post(DEEPSEEK_API_URL.replace(/\/$/, '') + urlPath, req.file.buffer, {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/octet-stream'
      },
      timeout: 120000
    });
    // Преобразуем ответ Deepseek в { verdict, confidence, labels }
    // Обратите внимание: структура dsResp.data зависит от Deepseek — адаптируйте парсинг.
    const raw = dsResp.data;
    // Пример ожидания: raw = { predictions: [{label:'pothole', score:0.93}, ...] }
    let verdict = 'unknown';
    let confidence = 0;
    let labels = [];
    if (Array.isArray(raw.predictions)) {
      labels = raw.predictions.map(p => ({ label: p.label || p.tag, score: p.score || p.confidence }));
      // простая логика: берём лучший label
      const best = labels.reduce((a,b) => a.score > b.score ? a : b, labels[0] || {score:0});
      if (best) {
        confidence = best.score || 0;
        // map label to verdict
        const l = (best.label||'').toLowerCase();
        if (l.includes('pothole') || l.includes('damage') || l.includes('crack')) verdict = 'likely_damage';
        else if (confidence > 0.8) verdict = 'possible';
        else verdict = 'not_damage';
      }
    } else if (raw.verdict && raw.confidence) {
      verdict = raw.verdict;
      confidence = raw.confidence;
      labels = raw.labels || [];
    } else {
      // fallback: return raw
      verdict = raw.verdict || 'unknown';
    }

    return res.json({ ok:true, verdict, confidence, labels, raw });
  } catch (err) {
    console.error('verify-photo error', err?.response?.data || err.message);
    return res.status(502).json({ ok:false, error: 'Deepseek image error', details: err?.response?.data || err.message });
  }
});

// POST /api/deepseek/ingest — отправить нормализованный отчет в индекс Deepseek (опционально)
app.post('/api/deepseek/ingest', async (req, res) => {
  try {
    const payload = req.body || {};
    // адаптируйте путь /ingest под Deepseek
    const resp = await deepseekRequest('/ingest', 'POST', payload, { 'Content-Type': 'application/json' });
    return res.json({ ok:true, data: resp });
  } catch (err) {
    return res.status(502).json({ ok:false, error: err?.message || String(err) });
  }
});