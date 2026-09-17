// ---------------------------------------------------------------------------
// Settings tab — appearance, account (login/register/logout), and — only
// for the admin account — the DeepSeek key, which is set here and saved
// straight to the server; it's never stored or shown in this browser again.
// ---------------------------------------------------------------------------
let authMode = "login"; // "login" | "register"
let deepseekKeyStatus = null; // {deepseekKeySet} once fetched

function renderSettingsTab(mount) {
  const s = t();
  mount.innerHTML = `
    <div class="settings-wrap">
      <div class="card">
        <div class="panel-title"><span>${s.settingsAppearance}</span></div>
        <div class="settings-row">
          <span>${s.settingsTheme}</span>
          <div class="segmented">
            <button data-theme="light" class="theme-btn ${state.theme === "light" ? "active" : ""}">
              <span class="theme-swatch light"></span>${s.themeLight}
            </button>
            <button data-theme="dark" class="theme-btn ${state.theme === "dark" ? "active" : ""}">
              <span class="theme-swatch dark"></span>${s.themeDark}
            </button>
          </div>
        </div>
        <div class="settings-row">
          <span>${s.settingsLanguage}</span>
          <div class="segmented">
            <button data-lang="ru" class="${state.lang === "ru" ? "active" : ""}">RU</button>
            <button data-lang="en" class="${state.lang === "en" ? "active" : ""}">EN</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="panel-title"><span>${s.settingsAccount}</span></div>
        ${renderAccountSection(s)}
      </div>

      ${isAdmin() ? `
      <div class="card">
        <div class="panel-title"><span>${s.settingsAdminApi}</span></div>
        ${renderDeepseekSection(s)}
      </div>` : ""}

      <div class="card">
        <div class="panel-title"><span>${s.settingsSupport}</span></div>
        <div class="settings-row">
          <span>${s.supportToggle}</span>
          <button class="toggle ${state.showSupport ? "on" : ""}" id="support-toggle"><span class="toggle-knob"></span></button>
        </div>
      </div>

      <p class="note-text">${s.dataNote}</p>
    </div>
  `;

  mount.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.onclick = () => { document.documentElement.setAttribute("data-theme", btn.dataset.theme); setState({ theme: btn.dataset.theme }); };
  });
  mount.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.onclick = () => setState({ lang: btn.dataset.lang });
  });
  mount.querySelector("#support-toggle").onclick = () => setState({ showSupport: !state.showSupport });

  wireAccountSection(mount);
  if (isAdmin()) wireDeepseekSection(mount);
}

// --- Account: login / register / logout --------------------------------
function renderAccountSection(s) {
  if (state.token && state.user) {
    return `
      <div class="settings-row">
        <span>✅ ${s.loggedInAs} <strong>${state.user.email}</strong> (${state.user.role === "admin" ? s.roleAdmin : s.roleUser})</span>
        <button class="btn-primary" id="logout-btn" style="width:auto;padding:6px 14px">${s.logout}</button>
      </div>`;
  }
  return `
    <input type="text" id="auth-email" placeholder="${s.email}" />
    <input type="password" id="auth-password" placeholder="${s.password}" />
    <button class="btn-primary" id="auth-submit-btn">${authMode === "login" ? s.login : s.register}</button>
    <p class="note-text" id="auth-msg"></p>
    <p class="note-text" id="auth-toggle-link" style="cursor:pointer;text-decoration:underline">
      ${authMode === "login" ? s.noAccount : s.haveAccount}
    </p>`;
}
function wireAccountSection(mount) {
  const logoutBtn = mount.querySelector("#logout-btn");
  if (logoutBtn) logoutBtn.onclick = () => setState({ token: null, user: null });

  const toggleLink = mount.querySelector("#auth-toggle-link");
  if (toggleLink) toggleLink.onclick = () => { authMode = authMode === "login" ? "register" : "login"; renderSettingsTab(mount); };

  const submitBtn = mount.querySelector("#auth-submit-btn");
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const s = t();
      const email = mount.querySelector("#auth-email").value.trim();
      const password = mount.querySelector("#auth-password").value;
      const msg = mount.querySelector("#auth-msg");
      try {
        const data = await api(`/auth/${authMode === "login" ? "login" : "register"}`, {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setState({ token: data.token, user: data.user });
      } catch (err) {
        msg.textContent = err.message || s.authError;
      }
    };
  }
}

// --- DeepSeek key: admin only, write-only from the UI's perspective -----
function renderDeepseekSection(s) {
  return `
    <p class="note-text" id="deepseek-status">…</p>
    <input type="password" id="deepseek-key-input" placeholder="sk-…" />
    <button class="btn-primary" id="deepseek-save-btn">${s.saveKey}</button>
    <p class="note-text" id="deepseek-msg"></p>`;
}
function wireDeepseekSection(mount) {
  const statusEl = mount.querySelector("#deepseek-status");
  api("/admin/settings").then((data) => {
    if (statusEl) statusEl.textContent = data.deepseekKeySet ? t().deepseekKeySet : t().deepseekKeyNotSet;
  }).catch(() => {});

  mount.querySelector("#deepseek-save-btn").onclick = async () => {
    const s = t();
    const key = mount.querySelector("#deepseek-key-input").value.trim();
    const msg = mount.querySelector("#deepseek-msg");
    try {
      await api("/admin/settings", { method: "PUT", body: JSON.stringify({ deepseekApiKey: key }) });
      msg.textContent = s.keySaved;
      mount.querySelector("#deepseek-key-input").value = "";
    } catch (err) {
      msg.textContent = err.message;
    }
  };
}
