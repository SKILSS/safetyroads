# Gemini support fix

- Fixed the literal JavaScript `${lang === ...}` text in the support panel.
- Support now displays a real user/Gemini conversation.
- The support client sends requests to `POST /api/ai/chat`.
- Conversation history is bounded to the last 10 messages.
- Gemini errors are shown as normal chat messages.
- `/etc/secrets/safetyroads.env` is now loaded automatically when present on Render.
- Default Gemini model: `gemini-3.8-flash`.

Render secret example:

```env
JWT_SECRET=...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
```
