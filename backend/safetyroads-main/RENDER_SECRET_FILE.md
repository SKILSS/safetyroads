# Render Secret File

This project can load a Render Secret File named `safetyroads.env`.

Render path at runtime:
`/etc/secrets/safetyroads.env`

Paste the following into the Secret File and replace the placeholder values:

```env
# Generate this locally with:
# openssl rand -base64 48
JWT_SECRET=PASTE_A_LONG_RANDOM_SECRET_HERE

# DeepSeek API key. Never put this in frontend code.
DEEPSEEK_API_KEY=PASTE_YOUR_DEEPSEEK_KEY_HERE

# Only needed if you use the create-admin script from the Render shell.
ADMIN_EMAIL=your-admin-email@example.com
ADMIN_PASSWORD=PASTE_A_LONG_RANDOM_ADMIN_PASSWORD_HERE
```

Do NOT commit the real file to GitHub.

## Render steps

1. Render → your Web Service → **Environment**.
2. **Secret Files** → **Add Secret File**.
3. Filename: `safetyroads.env`
4. Paste the contents above with your real values.
5. Save changes and redeploy.

The server reads `/etc/secrets/safetyroads.env` at startup.

`DATABASE_URL` can stay as a normal Render environment variable linked to your Postgres database.

## Generate the JWT secret

Run locally:

```bash
openssl rand -base64 48
```

Copy the result into `JWT_SECRET`.

## Important

Never paste a real API key or password into the source code, ZIP, GitHub, screenshots, or chat.
