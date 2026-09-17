// ---------------------------------------------------------------------------
// Map tab — every federal subject of Russia rendered as its own clickable
// polygon. Interactions (hover/click/zoom) are handled locally, not through
// the global render(), so panning/zooming stays smooth.
// ---------------------------------------------------------------------------
// Preferred: your own copy, self-hosted next to index.html (see README).
const GEOJSON_URL_PRIMARY = "./russia.geojson";
// Fallback: used automatically if the file above isn't found (e.g. it
// hasn't been uploaded to the repo yet) — this guarantees the map still
// works while you sort that out.
const GEOJSON_URL_FALLBACK = "https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/russia.geojson";
const VIEW_W = 800, VIEW_H = 500;

let geoCache = null; // null | {status:'loading'|'ok'|'error', data}

function fetchGeoJson(url) {
  return fetch(url).then((r) => { if (!r.ok) throw new Error("bad status"); return r.json(); });
}

function loadGeoData(onDone) {
  if (geoCache && geoCache.status !== "loading") { onDone(); return; }
  if (geoCache && geoCache.status === "loading") return; // already in flight
  geoCache = { status: "loading", data: null };
  fetchGeoJson(GEOJSON_URL_PRIMARY)
    .catch(() => fetchGeoJson(GEOJSON_URL_FALLBACK))
    .then((data) => {
      geoCache = { status: "ok", data };
      state.regionNames = data.features.map((f) => f.properties.name).filter(Boolean).sort();
      onDone();
    })
    .catch(() => {
      geoCache = { status: "error", data: null };
      onDone();
    });
}

function renderMapTab(mount) {
  const s = t();
  mount.innerHTML = `
    <div class="map-grid">
      <div class="card map-card" id="map-card">
        <div class="map-loading" id="map-loading"><span>${s.mapLoading}</span></div>
        <div class="map-overlay top-left" id="map-count" style="display:none"></div>
        <div class="map-controls" style="display:none" id="map-controls">
          <button class="map-btn" id="zoom-in">+</button>
          <button class="map-btn" id="zoom-out">−</button>
          <button class="map-btn" id="zoom-reset">⟲</button>
        </div>
        <div class="map-overlay bottom-left" id="map-hint" style="display:none">${s.zoomHint}</div>
        <div class="map-overlay bottom-right" id="map-hover" style="display:none"></div>
        <svg id="map-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" style="aspect-ratio:${VIEW_W}/${VIEW_H}"></svg>
      </div>
      <div class="card" id="map-side"></div>
    </div>
  `;
  renderSidePanel(mount);
  loadProblems().then(() => {
    renderSidePanel(mount);
    if (geoCache && geoCache.status === "ok") drawMap(mount); // refresh colors now that counts are known
  });
  loadGeoData(() => drawMap(mount));
}

function drawMap(mount) {
  const loadingEl = mount.querySelector("#map-loading");
  if (!loadingEl) return; // user navigated away before fetch finished
  const s = t();

  if (geoCache.status === "error") {
    loadingEl.innerHTML = `<span style="color:var(--danger)">${s.mapError}</span>`;
    return;
  }
  loadingEl.style.display = "none";
  mount.querySelector("#map-count").style.display = "block";
  mount.querySelector("#map-count").textContent = `${geoCache.data.features.length} ${s.regionsLoaded}`;
  mount.querySelector("#map-controls").style.display = "flex";
  mount.querySelector("#map-hint").style.display = "block";

  const svg = d3.select(mount.querySelector("#map-svg"));
  svg.selectAll("*").remove();
  svg.append("rect").attr("width", VIEW_W).attr("height", VIEW_H).attr("fill", cssVar("--surface"));
  const g = svg.append("g");

  const projection = d3.geoMercator().fitExtent([[10, 10], [VIEW_W - 10, VIEW_H - 10]], geoCache.data);
  const path = d3.geoPath(projection);
  const counts = regionCounts();
  const maxCount = Math.max(1, ...Object.values(counts));
  const th = theme();
  const borderColor = cssVar("--border");

  const hoverBox = mount.querySelector("#map-hover");

  g.selectAll("path.region-path")
    .data(geoCache.data.features)
    .join("path")
    .attr("class", "region-path")
    .attr("d", path)
    .attr("fill", (f) => fillFor(f.properties.name, counts, maxCount, th))
    .attr("stroke", borderColor)
    .attr("stroke-width", 0.5)
    .on("mouseenter", function (event, f) {
      if (f.properties.name !== state.selectedRegion) d3.select(this).attr("fill", th.landHover);
      hoverBox.style.display = "block";
      hoverBox.textContent = f.properties.name;
    })
    .on("mouseleave", function (event, f) {
      if (f.properties.name !== state.selectedRegion) d3.select(this).attr("fill", fillFor(f.properties.name, counts, maxCount, th));
      hoverBox.style.display = "none";
    })
    .on("click", (event, f) => {
      const name = f.properties.name;
      state.selectedRegion = state.selectedRegion === name ? null : name;
      g.selectAll("path.region-path")
        .attr("fill", (d) => fillFor(d.properties.name, counts, maxCount, th))
        .attr("stroke-width", (d) => (d.properties.name === state.selectedRegion ? 1.5 : 0.5));
      renderSidePanel(mount);
    });

  const zoom = d3.zoom()
    .scaleExtent([1, 10])
    .translateExtent([[-VIEW_W, -VIEW_H], [VIEW_W * 2, VIEW_H * 2]])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  mount.querySelector("#zoom-in").onclick = () => svg.transition().duration(200).call(zoom.scaleBy, 1.5);
  mount.querySelector("#zoom-out").onclick = () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
  mount.querySelector("#zoom-reset").onclick = () => svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
}

function fillFor(name, counts, maxCount, th) {
  if (name === state.selectedRegion) return th.accent;
  const count = counts[name] || 0;
  if (count === 0) return th.land;
  return mixHex(th.land, th.accent, 0.25 + (count / maxCount) * 0.6);
}

function renderSidePanel(mount) {
  const s = t();
  const side = mount.querySelector("#map-side");
  const list = state.selectedRegion
    ? state.problems.filter((p) => p.region === state.selectedRegion)
    : state.problems;

  side.innerHTML = `
    <div class="panel-title">
      <span>${s.problemsIn} ${state.selectedRegion || s.allRegions}</span>
      ${state.selectedRegion ? `<button id="clear-region">${s.allRegions}</button>` : ""}
    </div>
    ${list.length === 0
      ? `<p class="muted">${s.noSelection}</p>`
      : `<ul class="problem-list">${list.map((p) => `
          <li class="problem-item">
            <span class="dot" style="background:${severityColor(p.severity)}"></span>
            <div style="flex:1">
              <div class="problem-item-title">${problemTitle(p)}</div>
              <div class="problem-item-meta">${p.region} · ${s[p.category]} · ${s["status" + capitalize(p.status)]}</div>
              ${adminActionsHtml(p)}
            </div>
          </li>`).join("")}</ul>`
    }
  `;
  const clearBtn = side.querySelector("#clear-region");
  if (clearBtn) clearBtn.onclick = () => { state.selectedRegion = null; drawMap(mount); renderSidePanel(mount); };
  wireAdminActions(side);
}
