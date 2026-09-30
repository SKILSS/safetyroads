# Render + Google Gemini

1. Render → your Web Service → Environment.
2. Either add `GEMINI_API_KEY` as an Environment Variable, or create a Secret File named `safetyroads.env`.
3. If using a Secret File, put:

```env
GEMINI_API_KEY=YOUR_REAL_GEMINI_KEY
GEMINI_MODEL=gemini-3.8-flash
```

4. Save and redeploy.

Do not commit the real key to GitHub. The backend sends the key to Google using the `x-goog-api-key` header. The browser never receives it.

The AI photo checker compares the uploaded image with the user's description; it does not prove that the real-world event happened.
