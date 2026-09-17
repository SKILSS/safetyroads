// ---------------------------------------------------------------------------
// App shell — header, tab nav, routes to the active tab's render function.
// ---------------------------------------------------------------------------
const TABS = [
  { id: "map", icon: "🗺️", key: "tabMap" },
  { id: "problems", icon: "⚠️", key: "tabProblems" },
  { id: "settings", icon: "⚙️", key: "tabSettings" },
];

function render() {
  const s = t();
  document.documentElement.setAttribute("data-theme", state.theme);

  const app = document.getElementById("app");
  app.innerHTML = `
    <header class="header">
      <div class="header-inner">
        <div class="logo">
          <div class="logo-badge">SR</div>
          <div>
            <div class="logo-title">${s.appName}</div>
            <div class="logo-tagline">${s.tagline}</div>
          </div>
        </div>
        <nav class="tabs" id="tabs">
          ${TABS.map((tab) => `
            <button class="tab-btn ${state.tab === tab.id ? "active" : ""}" data-tab="${tab.id}">
              <span>${tab.icon}</span><span>${s[tab.key]}</span>
            </button>`).join("")}
        </nav>
      </div>
    </header>
    <main id="main"></main>
    <div id="chat-root"></div>
  `;

  app.querySelectorAll("#tabs button").forEach((btn) => {
    btn.onclick = () => setState({ tab: btn.dataset.tab });
  });

  const main = document.getElementById("main");
  if (state.tab === "map") renderMapTab(main);
  else if (state.tab === "problems") renderProblemsTab(main);
  else if (state.tab === "settings") renderSettingsTab(main);

  renderChatWidget(document.getElementById("chat-root"));
}

render();
