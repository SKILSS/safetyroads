# DeepSeek AI in SafetyRoad

The site now uses the server-side DeepSeek key for two AI features:

1. Photo verification when a user submits a road problem.
2. The AI assistant in Settings → Support.

## Configuration

You can configure the key in the admin account under **Settings → Admin panel → DeepSeek key**. The key is stored in PostgreSQL and is never sent to the browser.

Alternatively, set `DEEPSEEK_API_KEY` in the server environment (for example, Render Environment Variables). The database key takes precedence over the environment variable.

The server calls `https://api.deepseek.com/chat/completions` with the current `deepseek-flash` model. The model supports image input, so the existing photo-check flow remains compatible.

## AI assistant endpoint

`POST /api/ai/chat`

Requires the normal SafetyRoad Bearer token. Body:

```json
{
  "message": "Какие проблемы есть на маршруте?",
  "language": "ru"
}
```

The server adds a limited set of current non-withdrawn/non-rejected reports as context and asks DeepSeek to avoid inventing live traffic, closures, prices, or unverified facts.

## DeepSeek model note

The current API documentation lists `deepseek-flash` as a supported Chat Completions model and documents image input for it. The code therefore avoids the retired `deepseek-chat` / `deepseek-reasoner` names.
