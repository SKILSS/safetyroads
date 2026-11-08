# Google Gemini setup

SafetyRoad uses Google Gemini for the AI photo checks, repair-photo checks, and the AI assistant chat. The current model is `gemini-3.8-flash` (configurable with `GEMINI_MODEL`). Google documents Gemini image input and structured JSON output for this model.

## Render Environment Variables
Set:

`GEMINI_API_KEY=your_google_ai_studio_api_key`

Optional:

`GEMINI_MODEL=gemini-3.8-flash`

The API key is used only by the backend and is never sent to the browser.

## Admin panel
An administrator can also paste the Gemini key in the SafetyRoad admin settings. It is stored server-side in `app_settings.gemini_api_key`; the key itself is never returned to the browser.

## GitHub
Never commit the real Gemini key, `.env`, `safetyroads.env`, or any other secret file.
