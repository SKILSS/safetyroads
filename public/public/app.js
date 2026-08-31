// public/app.js (frontend)
(async function () {
  const map = L.map('map').setView([55.8304, 49.0661], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  let tempMarker = null;
  let selectedLatLng = null;
  let markers = [];

  // UI helpers
  function $(id){ return document.getElementById(id); }
  function showModal(id){ $(id).classList.add('show'); }
  function hideModal(id){ $(id).classList.remove('show'); }

  window.startAdding = function () {
    const btn = $('addButton');
    btn.classList.add('active');
    btn.textContent = 'Нажмите на карте...';
    map.once('click', (e) => {
      selectedLatLng = e.latlng;
      if (tempMarker) map.removeLayer(tempMarker);
      tempMarker = L.marker(selectedLatLng).addTo(map);
      $('coordinates').textContent = `${selectedLatLng.lat.toFixed(6)}, ${selectedLatLng.lng.toFixed(6)}`;
      showModal('problemModal');
      btn.classList.remove('active');
      btn.textContent = '+ Добавить проблему';
    });
  };

  window.closeModal = function () {
    hideModal('problemModal');
    $('problemDescription').value = '';
    $('problemPhoto').value = '';
    if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
    selectedLatLng = null;
    $('coordinates').textContent = '—';
  };

  // load reports from server
  async function loadReports() {
    try {
      const resp = await fetch('/api/reports');
      const json = await resp.json();
      if (!json.ok) return console.warn('Failed to fetch reports', json);
      renderReports(json.results || []);
      updateStats(json.results || []);
    } catch (err) {
      console.error('Error loading reports', err);
    }
  }

  function clearMarkers(){
    markers.forEach(m => map.removeLayer(m));
    markers = [];
  }

  function renderReports(list){
    clearMarkers();
    const filter = $('filterType').value;
    const filtered = list.filter(r => filter === 'all' ? true : (r.type === filter || r.id === filter));
    filtered.forEach(r => {
      const m = L.marker([r.lat || r.latitude || r.lat, r.lng || r.longitude || r.lng])
        .addTo(map)
        .bindPopup(renderPopupHtml(r));
      markers.push(m);
    });
  }

  function renderPopupHtml(r) {
    const title = r.type ? (r.type + ' ') : '';
    const desc = r.description || r.summary || '';
    const date = r.createdAt || r.date || r._fetchedAt || '';
    const source = r.source || 'unknown';
    const id = r.id || r.sourceId || '';
    return `<div><div class="popup-title">${title}</div><div class="popup-description">${escapeHTML(desc)}</div><div class="popup-date">Источник: ${escapeHTML(source)}<br>${escapeHTML(date)}</div>
      ${r.source === 'local' ? `<button class="delete-button" onclick="deleteLocal('${id}')">Удалить</button>` : ''}
    </div>`;
  }

  window.deleteLocal = async function (id) {
    if (!confirm('Удалить отчёт?')) return;
    try {
      const resp = await fetch('/api/reports/' + encodeURIComponent(id), { method: 'DELETE' });
      const j = await resp.json();
      if (j.ok) { await loadReports(); }
    } catch (err) { console.error(err); }
  };

  function escapeHTML(s){ if(!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.filterProblems = function () { loadReports(); };

  // save local report
  window.saveProblem = async function () {
    if (!selectedLatLng) { alert('Сначала выберите место на карте'); return; }
    const type = $('problemType').value;
    const description = $('problemDescription').value.trim();
    const photoFile = $('problemPhoto').files[0];
    const payload = {
      type,
      description,
      lat: selectedLatLng.lat,
      lng: selectedLatLng.lng,
      date: new Date().toISOString()
    };
    try {
      // If you want to upload photo: send multipart to server. Here we keep demo simple and send JSON
      const resp = await fetch('/api/reports', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const j = await resp.json();
      if (j.ok) {
        closeModal();
        await loadReports();
      } else {
        alert('Failed to save report');
      }
    } catch (err) {
      console.error(err); alert('Error');
    }
  };

  // simple stats
  function updateStats(list){
    const total = (list || []).length;
    $('totalProblems').textContent = total;
    const road = (list || []).filter(r => ['pothole','traffic','marking'].includes(r.type)).length;
    $('roadProblems').textContent = road;
  }

  // support/settings
  window.openSupport = function(){ showModal('supportModal'); };
  window.closeSupport = function(){ hideModal('supportModal'); };
  window.openSettings = function(){ showModal('settingsModal'); };
  window.closeSettings = function(){ hideModal('settingsModal'); };

  // trigger server Deepseek sync
  window.triggerDeepseekSync = async function () {
    try {
      const resp = await fetch('/api/feeds/fetch');
      const j = await resp.json();
      if (j.ok) { alert('Sync triggered'); await loadReports(); }
      else alert('Sync failed');
    } catch (err) { console.error(err); alert('Error'); }
  };

  // periodic polling
  setInterval(loadReports, 30_000);

  // initial load
  await loadReports();

  // update stats when filter changes
  document.getElementById('filterType').addEventListener('change', loadReports);
})();// вызов verify-photo (client)
async function verifyPhotoOnServer(file) {
  const fd = new FormData();
  fd.append('photo', file, file.name);
  // optional: add meta: fd.append('meta', JSON.stringify({ source: 'web' }));
  const resp = await fetch('/api/deepseek/verify-photo', { method: 'POST', body: fd });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Verify failed: ' + txt);
  }
  return await resp.json(); // { ok:true, verdict, confidence, labels, raw }
}

// updated saveProblem()
window.saveProblem = async function() {
  if (!selectedLatLng) { alert('Сначала выберите место на карте'); return; }
  const type = document.getElementById('problemType').value;
  const description = document.getElementById('problemDescription').value.trim();
  const photoFile = document.getElementById('problemPhoto').files[0];

  let ai = null;
  if (photoFile) {
    try {
      // optional: show UI "verifying..."
      ai = await verifyPhotoOnServer(photoFile);
      // ai: {ok:true, verdict, confidence, labels, raw}
    } catch (err) {
      console.warn('AI verify failed', err);
      // allow continue — store report with ai=null
    }
  }

  const payload = {
    type,
    description,
    lat: selectedLatLng.lat,
    lng: selectedLatLng.lng,
    date: new Date().toISOString(),
    ai_verdict: ai ? ai.verdict : null,
    ai_confidence: ai ? ai.confidence : null,
    ai_labels: ai ? ai.labels : null,
    source: 'local'
  };

  // POST /api/reports as before
  const resp = await fetch('/api/reports', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const j = await resp.json();
  if (j.ok) { closeModal(); await loadReports(); }
  else alert('Failed to save report');
};