// ---------------------------------------------------------------------------
// Problems tab — submitting requires login. The photo + description go to
// the server; the server calls DeepSeek itself using the key an admin set
// (see Settings), so no key ever touches this file or the browser.
// ---------------------------------------------------------------------------
let uploadedImage = null;

function renderProblemsTab(mount) {
  const s = t();
  if (!state.regionNames.length) loadGeoData(() => renderProblemsTab(mount));
  if (!state.problems.length) loadProblems().then(() => renderProblemsTab(mount));

  const loggedIn = !!state.token;

  mount.innerHTML = `
    <div class="problems-grid">
      <div class="card">
        <div class="panel-title"><span>${s.newProblem}</span></div>
        ${!loggedIn ? `<p class="note-text">${s.loginToSubmit}</p>` : ""}

        <div class="field-label">${s.photo}</div>
        <div class="upload-box" id="upload-box">
          ${uploadedImage ? `<img src="${uploadedImage}" />` : ""}
          <span class="muted">${uploadedImage ? s.changePhoto : s.photoHint}</span>
        </div>
        <input type="file" accept="image/*" id="file-input" style="display:none" />

        <div class="field-label">${s.descLabel}</div>
        <textarea id="desc-input" rows="3" placeholder="${s.descPlaceholder}"></textarea>

        <div class="field-label">${s.regionLabel}</div>
        <select id="region-select">
          ${state.regionNames.length === 0
            ? `<option value="">…</option>`
            : state.regionNames.map((n) => `<option value="${n}">${n}</option>`).join("")}
        </select>

        <button class="btn-primary" id="submit-btn" ${!loggedIn ? "disabled" : ""}>${s.submit}</button>
        <div id="verdict-slot"></div>
      </div>

      <div class="card">
        <div class="panel-title"><span>${s.feedTitle}</span></div>
        <ul class="problem-list">
          ${state.problems.map((p) => `
            <li class="problem-item">
              <div style="flex:1">
                <div class="problem-item-title">${problemTitle(p)}</div>
                <div class="problem-item-meta">
                  <span class="dot" style="display:inline-block;background:${severityColor(p.severity)}"></span>
                  ${p.region} · ${s["status" + capitalize(p.status)]}
                </div>
                ${p.ai_verdict ? `<div class="note-text" style="margin-top:4px">🤖 ${p.ai_verdict}</div>` : ""}
                ${adminActionsHtml(p)}
              </div>
            </li>`).join("")}
        </ul>
      </div>
    </div>
  `;

  mount.querySelector("#upload-box").onclick = () => mount.querySelector("#file-input").click();
  mount.querySelector("#file-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { uploadedImage = reader.result; renderProblemsTab(mount); };
    reader.readAsDataURL(file);
  };

  const submitBtn = mount.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => submitProblem(mount);
  wireAdminActions(mount);
}

async function submitProblem(mount) {
  const s = t();
  const verdictSlot = mount.querySelector("#verdict-slot");
  const desc = mount.querySelector("#desc-input").value;
  const region = mount.querySelector("#region-select").value;
  const submitBtn = mount.querySelector("#submit-btn");
  if (!region) return;

  verdictSlot.innerHTML = "";
  submitBtn.disabled = true;
  submitBtn.textContent = s.submitting;

  try {
    const created = await api("/problems", {
      method: "POST",
      body: JSON.stringify({
        region,
        category: "other",
        severity: "med",
        titleRu: desc || "Новое обращение",
        titleEn: desc || "New report",
        imageDataUrl: uploadedImage,
      }),
    });
    uploadedImage = null;
    await loadProblems();
    renderProblemsTab(mount);
    const slot = mount.querySelector("#verdict-slot");
    if (slot) {
      slot.innerHTML = created.ai_verdict
        ? verdictHtml(true, created.ai_verdict, s)
        : `<p class="note-text">${s.verdictNone}</p>`;
    }
  } catch {
    verdictSlot.innerHTML = `<p class="warn-text">${s.verdictError}</p>`;
    submitBtn.disabled = false;
    submitBtn.textContent = s.submit;
  }
}

function verdictHtml(ok, text, s) {
  return `
    <div class="verdict-box" style="border:1px solid ${ok ? "var(--ok)" : "var(--danger)"}">
      <div>
        <div class="verdict-title">${s.verdictHeading}</div>
        <div class="muted">${text}</div>
      </div>
    </div>`;
}
