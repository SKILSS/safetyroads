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
        <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" id="file-input" style="display:none" />
        <div class="field-label">${s.descLabel}</div>
        <textarea id="desc-input" rows="3" placeholder="${s.descPlaceholder}"></textarea>
        <div class="field-label">${s.regionLabel}</div>
        <select id="region-select">
          ${state.regionNames.length === 0 ? `<option value="">…</option>` : state.regionNames.map((n) => `<option value="${n}">${n}</option>`).join("")}
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
                  ${p.region} · ${s["status" + capitalize(p.status)] || p.status}
                </div>
                ${p.ai_verdict ? `<div class="note-text" style="margin-top:4px">🤖 ${escapeHtml(p.ai_verdict)} ${p.ai_confidence != null ? `(${Math.round(Number(p.ai_confidence)*100)}%)` : ""}</div>` : ""}
                ${p.ai_status === "error" ? `<div class="warn-text" style="margin-top:4px">⚠️ ${s.aiCheckError}</div>` : ""}
                ${p.ai_status === "not_configured" ? `<div class="note-text" style="margin-top:4px">ℹ️ ${s.verdictNone}</div>` : ""}
                ${state.user?.id && Number(p.created_by) === Number(state.user.id) && !["withdrawn","rejected"].includes(p.status) ? `<button class="admin-btn withdraw-btn" data-id="${p.id}" style="margin-top:6px">${s.withdraw}</button>` : ""}
                ${adminActionsHtml(p)}
              </div>
            </li>`).join("")}
        </ul>
      </div>
    </div>`;

  mount.querySelector("#upload-box").onclick = () => mount.querySelector("#file-input").click();
  mount.querySelector("#file-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type) || file.size > 2_500_000) {
      alert(s.imageTooLarge);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { uploadedImage = reader.result; renderProblemsTab(mount); };
    reader.readAsDataURL(file);
  };

  const submitBtn = mount.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => submitProblem(mount);
  mount.querySelectorAll(".withdraw-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(s.withdrawConfirm)) return;
      btn.disabled = true;
      try { await withdrawProblem(Number(btn.dataset.id)); }
      catch (err) { alert(err.message || s.withdrawError); btn.disabled = false; }
    };
  });
  wireAdminActions(mount);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
}

async function submitProblem(mount) {
  const s = t();
  const verdictSlot = mount.querySelector("#verdict-slot");
  const desc = mount.querySelector("#desc-input").value.trim();
  const region = mount.querySelector("#region-select").value;
  const submitBtn = mount.querySelector("#submit-btn");
  if (!region || !desc) { verdictSlot.innerHTML = `<p class="warn-text">${s.descriptionRequired}</p>`; return; }

  verdictSlot.innerHTML = `<p class="note-text">${s.aiChecking}</p>`;
  submitBtn.disabled = true;
  submitBtn.textContent = s.submitting;
  try {
    const created = await api("/problems", {
      method: "POST",
      body: JSON.stringify({ region, category: "other", severity: "med", titleRu: desc, titleEn: desc, imageDataUrl: uploadedImage }),
    });
    uploadedImage = null;
    await loadProblems();
    renderProblemsTab(mount);
    const slot = mount.querySelector("#verdict-slot");
    if (slot) {
      if (created.ai_status === "checked") {
        slot.innerHTML = verdictHtml(!!created.ai_matches, created.ai_verdict || s.aiChecked, s, created.ai_confidence, created.ai_detected);
      } else if (created.ai_status === "error") {
        slot.innerHTML = `<p class="warn-text">⚠️ ${s.aiCheckError}</p>`;
      } else {
        slot.innerHTML = `<p class="note-text">${s.verdictNone}</p>`;
      }
    }
  } catch (err) {
    verdictSlot.innerHTML = `<p class="warn-text">${escapeHtml(err.message || s.verdictError)}</p>`;
    submitBtn.disabled = false;
    submitBtn.textContent = s.submit;
  }
}

function verdictHtml(ok, text, s, confidence, detected) {
  return `<div class="verdict-box" style="border:1px solid ${ok ? "var(--ok)" : "var(--danger)"}">
    <div><div class="verdict-title">${s.verdictHeading}</div>
    <div class="muted">${escapeHtml(text)}</div>
    ${detected ? `<div class="muted">${s.detected}: ${escapeHtml(detected)}</div>` : ""}
    ${confidence != null ? `<div class="muted">${s.confidence}: ${Math.round(Number(confidence)*100)}%</div>` : ""}</div>
  </div>`;
}
