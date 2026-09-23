
## AI key on Render

For AI photo checking, the server can read the DeepSeek API key from the Render environment variable `DEEPSEEK_API_KEY` (recommended). In Render open the SafetyRoad service → **Environment** → **Environment Variables** → add:

- Key: `DEEPSEEK_API_KEY`
- Value: your DeepSeek API key

Save the variable and redeploy/restart the service. Never put the key in `frontend/index.html` or any browser JavaScript.

The admin settings key is still supported as a database fallback.

## Navigator voice guidance

The navigator now has a **Voice / Голос** button. It uses the browser's built-in Speech Synthesis API, so it does not require an AI key. Voice guidance can be enabled/disabled and the preference is saved on the device. During navigation the app announces route instructions and arrival when browser geolocation is available.
