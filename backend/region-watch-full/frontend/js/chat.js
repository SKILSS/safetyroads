// ---------------------------------------------------------------------------
// Support chat — local FAQ only, no real backend
// ---------------------------------------------------------------------------
const CHAT_FAQ = [
  { kw: ["фото", "photo", "загруз", "upload"], ru: "Во вкладке «Проблемы» нажмите на область загрузки, выберите фото, добавьте описание и регион, затем отправьте на проверку ИИ.", en: "In Problems, click the upload area, pick a photo, add a description and region, then submit for AI review." },
  { kw: ["ключ", "api", "key"], ru: "Ключ DeepSeek API задаёт только администратор в «Настройках» — он хранится на сервере, не в браузере.", en: "The DeepSeek API key is set only by the admin in Settings — it's stored on the server, not in the browser." },
  { kw: ["регион", "region", "карта", "map"], ru: "На карте показаны все регионы России — нажмите на любой, чтобы увидеть его проблемы.", en: "The map shows every region of Russia — click any of them to see its problems." },
];

function renderChatWidget(root) {
  const s = t();
  if (!state.showSupport) { root.innerHTML = ""; return; }

  if (!state.chatOpen) {
    root.innerHTML = `<button class="chat-fab" id="chat-open">💬</button>`;
    root.querySelector("#chat-open").onclick = () => setState({ chatOpen: true });
    return;
  }

  root.innerHTML = `
    <div class="chat-panel">
      <div class="chat-header"><span>${s.chatTitle}</span><button id="chat-close">✕</button></div>
      <div class="chat-body" id="chat-body">
        <div class="chat-msg bot">${s.chatWelcome}</div>
        ${state.chatMessages.map((m) => `<div class="chat-msg ${m.from}">${m.text}</div>`).join("")}
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="${s.chatPlaceholder}" />
        <button id="chat-send">➤</button>
      </div>
    </div>
  `;
  root.querySelector("#chat-close").onclick = () => setState({ chatOpen: false });
  const send = () => {
    const input = root.querySelector("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const match = CHAT_FAQ.find((f) => f.kw.some((k) => lower.includes(k)));
    const reply = match ? match[state.lang] : s.chatFallback;
    state.chatMessages = [...state.chatMessages, { from: "user", text }, { from: "bot", text: reply }];
    render();
  };
  root.querySelector("#chat-send").onclick = send;
  root.querySelector("#chat-input").onkeydown = (e) => { if (e.key === "Enter") send(); };
  root.querySelector("#chat-body").scrollTop = root.querySelector("#chat-body").scrollHeight;
}
