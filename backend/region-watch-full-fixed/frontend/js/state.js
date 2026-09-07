// ---------------------------------------------------------------------------
// Global app state + API client. The frontend is served by the same server
// as the API (see backend/server.js), so relative paths like "/api/..." work
// both locally and once deployed — no separate URL to configure.
// ---------------------------------------------------------------------------
const STORAGE_KEYS = {
  theme: "regionwatch_theme",
  lang: "regionwatch_lang",
  showSupport: "regionwatch_show_support",
  token: "regionwatch_token",
  user: "regionwatch_user", // {email, role} — just for showing the UI, not trusted for access control
};

const state = {
  theme: localStorage.getItem(STORAGE_KEYS.theme) || "dark",
  lang: localStorage.getItem(STORAGE_KEYS.lang) || "ru",
  tab: "map",
  showSupport: localStorage.getItem(STORAGE_KEYS.showSupport) !== "false",
  selectedRegion: null,
  regionNames: [],
  problems: [],
  token: localStorage.getItem(STORAGE_KEYS.token) || null,
  user: JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || "null"),
  chatOpen: false,
  chatMessages: [],
};

function setState(patch) {
  Object.assign(state, patch);
  if ("theme" in patch) localStorage.setItem(STORAGE_KEYS.theme, state.theme);
  if ("lang" in patch) localStorage.setItem(STORAGE_KEYS.lang, state.lang);
  if ("showSupport" in patch) localStorage.setItem(STORAGE_KEYS.showSupport, String(state.showSupport));
  if ("token" in patch) {
    if (state.token) localStorage.setItem(STORAGE_KEYS.token, state.token);
    else localStorage.removeItem(STORAGE_KEYS.token);
  }
  if ("user" in patch) {
    if (state.user) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(state.user));
    else localStorage.removeItem(STORAGE_KEYS.user);
  }
  render();
}

function t() { return STRINGS[state.lang]; }
function isAdmin() { return state.user?.role === "admin"; }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const THEME_TOKENS = {
  dark: { land: "#1C2740", landHover: "#2A3A5C", accent: "#F2A93B" },
  light: { land: "#E4E8DE", landHover: "#C9D1BE", accent: "#C9631B" },
};
function theme() { return THEME_TOKENS[state.theme]; }

function severityColor(sev) {
  const v = getComputedStyle(document.documentElement);
  if (sev === "high") return v.getPropertyValue("--danger").trim();
  if (sev === "med") return v.getPropertyValue("--accent").trim();
  return v.getPropertyValue("--ok").trim();
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

function mixHex(hexA, hexB, weight) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * weight);
  const g = Math.round(a.g + (b.g - a.g) * weight);
  const bl = Math.round(a.b + (b.b - a.b) * weight);
  return `rgb(${r}, ${g}, ${bl})`;
}
function hexToRgb(hex) {
  const v = hex.replace("#", "");
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function problemTitle(p) { return state.lang === "ru" ? p.title_ru : p.title_en; }

function regionCounts() {
  const counts = {};
  for (const p of state.problems) {
    if (p.status === "rejected") continue;
    counts[p.region] = (counts[p.region] || 0) + 1;
  }
  return counts;
}

// --- API helper -------------------------------------------------------
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadProblems() {
  state.problems = await api("/problems").catch(() => []);
}

// --- Admin actions (server-enforced — the server checks the token's role,
// not this code) --------------------------------------------------------
async function adminSetStatus(id, status) {
  await api(`/problems/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }).catch(() => {});
  await loadProblems();
  render();
}
async function adminDeleteProblem(id) {
  await api(`/problems/${id}`, { method: "DELETE" }).catch(() => {});
  await loadProblems();
  render();
}
function adminActionsHtml(p) {
  if (!isAdmin()) return "";
  const s = t();
  return `
    <div style="display:flex;gap:6px;margin-top:6px">
      <button class="admin-btn" data-action="confirm" data-id="${p.id}">${s.adminConfirm}</button>
      <button class="admin-btn" data-action="reject" data-id="${p.id}">${s.adminReject}</button>
      <button class="admin-btn" data-action="delete" data-id="${p.id}">${s.adminDelete}</button>
    </div>`;
}
function wireAdminActions(mount) {
  mount.querySelectorAll(".admin-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === "confirm") adminSetStatus(id, "confirmed");
      else if (btn.dataset.action === "reject") adminSetStatus(id, "rejected");
      else if (btn.dataset.action === "delete") adminDeleteProblem(id);
    };
  });
}
