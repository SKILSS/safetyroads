let uploadedImage = null;
let fixedImages = {};
let swipeState = {};

window.openProblemFix = function(id) {
  setState({ tab: "problems" });
  setTimeout(() => {
    const btn = document.querySelector(`.fix-btn[data-id="${Number(id)}"]`);
    if (btn) btn.click();
  }, 0);
};


function renderProblemsTab(mount) {
  const s = t();
  if (!state.regionNames.length) loadGeoData(() => renderProblemsTab(mount));
  if (!state.problems.length) loadProblems().then(() => renderProblemsTab(mount));
  const loggedIn = !!state.token;
  const activeProblems = state.problems.filter((p) => !["withdrawn", "rejected", "resolved"].includes(p.status));

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
          ${state.regionNames.length === 0 ? `<option value="">…</option>` : state.regionNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
        </select>
        <button class="btn-primary" id="submit-btn" ${!loggedIn ? "disabled" : ""}>${s.submit}</button>
        <div id="verdict-slot"></div>
      </div>

      <div class="card">
        <div class="panel-title"><span>${s.feedTitle}</span></div>
        <ul class="problem-list">
          ${activeProblems.length ? activeProblems.map((p) => problemCardHtml(p, s)).join("") : `<li class="muted">${s.noActiveProblems || s.noSelection}</li>`}
        </ul>
      </div>
    </div>
    <div id="delete-confirm-overlay" class="withdraw-overlay" aria-hidden="true">
      <div class="withdraw-modal">
        <div class="withdraw-icon">✕</div>
        <h4>${s.deleteQuestion}</h4>
        <p>${s.deleteQuestion}</p>
        <div class="withdraw-actions">
          <button id="delete-cancel">${s.cancel}</button>
          <button id="delete-confirm" class="danger">${s.confirm}</button>
        </div>
      </div>
    </div>`;

  mount.querySelector("#upload-box").onclick = () => mount.querySelector("#file-input").click();
  mount.querySelector("#file-input").onchange = (e) => handleImageFile(e.target, (data) => {
    uploadedImage = data;
    renderProblemsTab(mount);
  }, s);

  const submitBtn = mount.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => submitProblem(mount);

  wireDeleteButtons(mount);
  wireFixButtons(mount);
  wireDeleteConfirmation(mount);
  wireAdminActions(mount);
}

function problemCardHtml(p, s) {
  const owner = state.user?.id && Number(p.created_by) === Number(state.user.id);
  const canWithdraw = owner && !["withdrawn", "rejected", "resolved"].includes(p.status);
  return `
    <li class="problem-swipe-wrap" data-problem-id="${p.id}">
      ${canWithdraw ? `<button class="swipe-delete-action" data-delete-id="${p.id}" aria-label="${s.confirm}">✕</button>` : ""}
      <div class="problem-item swipe-card" data-swipe-id="${p.id}">
        ${canWithdraw ? `<button type="button" class="problem-delete-btn" data-delete-id="${p.id}" aria-label="${s.deleteQuestion}">✕</button>` : ""}
        <div class="problem-content" style="flex:1">
          <div class="problem-item-title">${escapeHtml(problemTitle(p))}</div>
          <div class="problem-item-meta">
            <span class="dot" style="display:inline-block;background:${severityColor(p.severity)}"></span>
            ${escapeHtml(p.region)} · ${s["status" + capitalize(p.status)] || escapeHtml(p.status)}
          </div>
          ${p.ai_verdict ? `<div class="note-text" style="margin-top:4px">🤖 ${escapeHtml(p.ai_verdict)} ${p.ai_confidence != null ? `(${Math.round(Number(p.ai_confidence)*100)}%)` : ""}</div>` : ""}
          ${p.ai_status === "error" ? `<div class="warn-text" style="margin-top:4px">⚠️ ${s.aiCheckError}</div>` : ""}
          <div class="problem-actions-row">
            <button class="admin-btn fix-btn" data-id="${p.id}">${s.markFixed}</button>
            ${adminActionsHtml(p)}
          </div>
        </div>
      </div>
      <div class="fix-panel" data-fix-id="${p.id}" aria-hidden="true">
        <div class="fix-panel-title">${s.markFixed}</div>
        <div class="fix-upload" data-fix-upload="${p.id}">${fixedImages[p.id] ? `<img src="${fixedImages[p.id]}" />` : `<span>${s.fixedPhotoHint}</span>`}</div>
        <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" data-fix-input="${p.id}" style="display:none" />
        <textarea class="fix-note" data-fix-note="${p.id}" rows="2" placeholder="${s.fixedNote}"></textarea>
        <div class="fix-actions">
          <button class="admin-btn fix-cancel" data-id="${p.id}">${s.cancel}</button>
          <button class="btn-primary fix-submit" data-id="${p.id}">${s.fixedSubmit}</button>
        </div>
        <div class="fix-result" data-fix-result="${p.id}"></div>
      </div>
    </li>`;
}

function handleImageFile(input, callback, s) {
  const file = input.files?.[0];
  if (!file) return;
  if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type) || file.size > 2_500_000) {
    alert(s.imageTooLarge);
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => callback(reader.result);
  reader.readAsDataURL(file);
}

function wireDeleteButtons(mount) {
  mount.querySelectorAll(".problem-delete-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDeleteConfirmation(mount, Number(btn.dataset.deleteId));
    };
  });
}

function wireDeleteConfirmation(mount) {
  const overlay = mount.querySelector("#delete-confirm-overlay");
  if (!overlay) return;
  mount.querySelector("#delete-cancel").onclick = () => closeDeleteConfirmation(mount);
  mount.querySelector("#delete-confirm").onclick = async () => {
    const id = Number(overlay.dataset.id);
    const btn = mount.querySelector("#delete-confirm");
    btn.disabled = true;
    try {
      await withdrawProblem(id);
      closeDeleteConfirmation(mount);
    } catch (err) {
      alert(err.message || t().deleteError);
      btn.disabled = false;
    }
  };
}

function openDeleteConfirmation(mount, id) {
  const overlay = mount.querySelector("#delete-confirm-overlay");
  overlay.dataset.id = id;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
}
function closeDeleteConfirmation(mount) {
  const overlay = mount.querySelector("#delete-confirm-overlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  overlay.removeAttribute("data-id");
}

function wireFixButtons(mount) {
  mount.querySelectorAll(".fix-btn").forEach((btn) => {
    btn.onclick = () => {
      const id = Number(btn.dataset.id);
      const panel = mount.querySelector(`.fix-panel[data-fix-id="${id}"]`);
      if (panel) panel.classList.toggle("open");
    };
  });
  mount.querySelectorAll("[data-fix-upload]").forEach((box) => {
    box.onclick = () => mount.querySelector(`[data-fix-input="${box.dataset.fixUpload}"]`).click();
  });
  mount.querySelectorAll("[data-fix-input]").forEach((input) => {
    input.onchange = (e) => handleImageFile(e.target, (data) => {
      fixedImages[Number(input.dataset.fixInput)] = data;
      renderProblemsTab(mount);
      const panel = mount.querySelector(`.fix-panel[data-fix-id="${input.dataset.fixInput}"]`);
      if (panel) panel.classList.add("open");
    }, t());
  });
  mount.querySelectorAll(".fix-cancel").forEach((btn) => {
    btn.onclick = () => {
      const panel = mount.querySelector(`.fix-panel[data-fix-id="${btn.dataset.id}"]`);
      if (panel) panel.classList.remove("open");
    };
  });
  mount.querySelectorAll(".fix-submit").forEach((btn) => {
    btn.onclick = () => submitResolution(mount, Number(btn.dataset.id));
  });
}

async function submitResolution(mount, id) {
  const s = t();
  const image = fixedImages[id];
  const note = mount.querySelector(`[data-fix-note="${id}"]`)?.value.trim() || "";
  const result = mount.querySelector(`[data-fix-result="${id}"]`);
  const btn = mount.querySelector(`.fix-submit[data-id="${id}"]`);
  if (!image) { result.innerHTML = `<p class="warn-text">${s.fixedPhotoHint}</p>`; return; }
  btn.disabled = true;
  result.innerHTML = `<p class="note-text">${s.fixedChecking}</p>`;
  try {
    const verdict = await resolveProblem(id, image, note);
    if (verdict.resolved) {
      delete fixedImages[id];
      await loadProblems();
      renderProblemsTab(mount);
      return;
    }
    result.innerHTML = `<div class="verdict-box" style="border:1px solid var(--danger)"><div class="verdict-title">${s.fixedRejected}</div><div class="muted">${escapeHtml(verdict.ai_reason || "")}${verdict.ai_confidence != null ? ` (${Math.round(Number(verdict.ai_confidence)*100)}%)` : ""}</div></div>`;
    btn.disabled = false;
  } catch (err) {
    result.innerHTML = `<p class="warn-text">${escapeHtml(err.message || s.fixedError)}</p>`;
    btn.disabled = false;
  }
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
