#!/bin/bash
set -e
rm -rf backend frontend
mkdir -p backend/middleware backend/routes backend/scripts frontend/css frontend/js
cat > 'backend/.env.example' << 'FILEEOF'
# Copy to .env locally, or set these in your host's dashboard (Render/Railway) in production.
# Never commit a real .env to git.

PORT=8080
NODE_ENV=production

DATABASE_URL=postgres://user:password@host:5432/regionwatch

# openssl rand -hex 32
JWT_SECRET=replace-with-a-64-char-random-string

# Used ONLY once, by scripts/create-admin.js, to create your admin account.
# You can delete these two lines from .env after running the script.
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=choose-a-strong-password

# Your frontend's real URL once deployed (custom domain or the host's URL)
ALLOWED_ORIGINS=https://your-domain.com
FILEEOF
cat > 'backend/db.js' << 'FILEEOF'
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

// CRITICAL: without this listener, any dropped/idle connection (common on
// free-tier Postgres) fires an 'error' event on the pool with no handler,
// which is an uncaught exception in Node and kills the whole process.
// That's what was taking the entire site down, not just DB-dependent routes.
pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error (connection recovered, process kept alive):", err);
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', -- 'user' or 'admin'
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS problems (
      id SERIAL PRIMARY KEY,
      region TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      severity TEXT NOT NULL DEFAULT 'med',
      status TEXT NOT NULL DEFAULT 'new',
      title_ru TEXT NOT NULL,
      title_en TEXT NOT NULL,
      image_data TEXT, -- base64 data URL; move to real object storage if volume grows
      ai_verdict TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_problems_region ON problems(region);
    CREATE INDEX IF NOT EXISTS idx_problems_created ON problems(created_at DESC);

    -- Single-row table: only the admin can ever write to it (see routes/admin.js).
    -- The DeepSeek key lives here, server-side, never sent to the browser.
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      deepseek_api_key TEXT,
      CONSTRAINT single_row CHECK (id = 1)
    );
    INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
}

module.exports = { pool, initSchema };
FILEEOF
cat > 'backend/package.json' << 'FILEEOF'
{
  "name": "region-watch-server",
  "version": "2.0.0",
  "description": "RegionWatch API — user accounts, single admin, server-held DeepSeek key, rate limiting.",
  "main": "server.js",
  "type": "commonjs",
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "create-admin": "node scripts/create-admin.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "compression": "^1.7.4",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.2.0",
    "express-slow-down": "^2.0.1",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.11.5"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
FILEEOF
cat > 'backend/server.js' << 'FILEEOF'
require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

const { pool, initSchema } = require("./db");
const { apiLimiter, authLimiter, authSlowDown } = require("./middleware/security");
const authRoutes = require("./routes/auth");
const problemsRoutes = require("./routes/problems");
const adminRoutes = require("./routes/admin");

const app = express();
app.set("trust proxy", 1); // needed behind Render/Railway/Cloudflare for real client IPs

app.use(helmet({ contentSecurityPolicy: false })); // CSP off by default so the existing frontend's inline script/CDN d3 still work; tighten later if you want
app.use(compression());
app.use(express.json({ limit: "3mb" })); // covers a base64 photo without allowing huge payload floods

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: false }));

app.use("/api", apiLimiter);
app.use("/api/auth/login", authLimiter, authSlowDown);
app.use("/api/auth/register", authLimiter, authSlowDown);

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/problems", problemsRoutes);
app.use("/api/admin", adminRoutes);

// Serve the frontend from the same server, so one deploy = the whole site.
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"), (err) => {
    // sendFile's own error callback, so a missing/misplaced frontend build
    // gives a clear log line pointing at the real cause instead of a bare
    // "Internal server error" with no context.
    if (err) {
      console.error("Could not send frontend/index.html — is the frontend/ folder deployed alongside backend/?", err);
      next(err);
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: "Internal server error." });
});

// Last-resort safety nets: log and keep running instead of a silent crash.
// The real fixes are try/catch in every route (done) and pool.on('error')
// in db.js (done) — these are just insurance against anything missed.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (process kept alive):", err);
});

const port = process.env.PORT || 8080;
const requiredEnv = ["DATABASE_URL", "JWT_SECRET"];
const missingEnv = requiredEnv.filter((k) => !process.env[k]);

async function start() {
  if (missingEnv.length) {
    console.error(`Missing required environment variable(s): ${missingEnv.join(", ")}. Set them in Render → Environment, then redeploy.`);
    process.exit(1);
  }
  await initSchema();
  app.listen(port, () => console.log(`RegionWatch listening on :${port}`));
}
start().catch((err) => { console.error("Failed to start:", err); process.exit(1); });

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
FILEEOF
cat > 'backend/middleware/auth.js' << 'FILEEOF'
const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only." });
    next();
  });
}

// Like requireAuth, but doesn't fail if there's no token — req.user is just
// null. Used for endpoints public users can hit, where we still want to
// know who's logged in (e.g. to attribute a report to its author).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
FILEEOF
cat > 'backend/middleware/security.js' << 'FILEEOF'
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // login + register combined, per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3,
  delayMs: (hits) => hits * 500,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { apiLimiter, authLimiter, authSlowDown, writeLimiter };
FILEEOF
cat > 'backend/routes/auth.js' << 'FILEEOF'
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const router = express.Router();

function issueToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

// Anyone can register — always as a plain user. There is no "role" field
// accepted from the request body, so nobody can register themselves as
// admin through this endpoint.
router.post("/register", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: "Email and a password of at least 8 characters are required." });
    }
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: "An account with this email already exists." });

    const hash = bcrypt.hashSync(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, email, role",
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    res.status(201).json({ token: issueToken(user), user: { email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ token: issueToken(user), user: { email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
FILEEOF
cat > 'backend/routes/admin.js' << 'FILEEOF'
const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Admin-only. Returns whether a key is set, never the key itself, so it's
// safe even if this response somehow got logged or cached somewhere.
router.get("/settings", requireAdmin, async (req, res, next) => {
  try {
    const row = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
    res.json({ deepseekKeySet: !!row?.deepseek_api_key });
  } catch (err) {
    next(err);
  }
});

// Admin-only. This is the ONLY place the DeepSeek key can ever be written —
// it goes straight into the database and is never echoed back to any
// client, admin included, past this point.
router.put("/settings", requireAdmin, async (req, res, next) => {
  try {
    const { deepseekApiKey } = req.body || {};
    if (typeof deepseekApiKey !== "string") return res.status(400).json({ error: "deepseekApiKey (string) required." });
    await pool.query("UPDATE app_settings SET deepseek_api_key = $1 WHERE id = 1", [deepseekApiKey || null]);
    res.json({ deepseekKeySet: !!deepseekApiKey });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
FILEEOF
cat > 'backend/routes/problems.js' << 'FILEEOF'
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/security");

const router = express.Router();

// Public: anyone can read the map/feed — no login needed to browse.
router.get("/", async (req, res, next) => {
  try {
    const { region } = req.query;
    const result = region
      ? await pool.query("SELECT * FROM problems WHERE region = $1 ORDER BY created_at DESC LIMIT 300", [region])
      : await pool.query("SELECT * FROM problems ORDER BY created_at DESC LIMIT 300");
    res.set("Cache-Control", "public, max-age=15");
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Logged-in users only: submitting a report requires an account, so a
// single bad actor can't anonymously flood the feed or burn through your
// DeepSeek quota. The DeepSeek key itself never leaves the server — the
// browser just sends the report; this endpoint calls DeepSeek itself using
// the key an admin set via PUT /api/admin/settings.
router.post("/", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const { region, category, severity, titleRu, titleEn, imageDataUrl } = req.body || {};
    if (!region || !titleRu || !titleEn) {
      return res.status(400).json({ error: "region, titleRu and titleEn are required." });
    }

    let aiVerdict = null;
    const settings = (await pool.query("SELECT deepseek_api_key FROM app_settings WHERE id = 1")).rows[0];
    if (settings?.deepseek_api_key && imageDataUrl) {
      try {
        const aiRes = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.deepseek_api_key}` },
          body: JSON.stringify({
            model: "deepseek-v4-flash-vision-exp",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: `Look at this photo of a reported civic issue and describe in 1-2 sentences whether it looks genuine. User description: ${titleRu || titleEn}` },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            }],
            max_tokens: 200,
          }),
        });
        if (aiRes.ok) {
          const data = await aiRes.json();
          aiVerdict = data?.choices?.[0]?.message?.content || null;
        }
      } catch {
        aiVerdict = null; // AI review is best-effort; a failed call shouldn't block the report
      }
    }

    const result = await pool.query(
      `INSERT INTO problems (region, category, severity, status, title_ru, title_en, image_data, ai_verdict, created_by)
       VALUES ($1,$2,$3,'new',$4,$5,$6,$7,$8) RETURNING *`,
      [region, category || "other", severity || "med", titleRu, titleEn, imageDataUrl || null, aiVerdict, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Admin-only: the final call on any report.
router.patch("/:id", requireAdmin, writeLimiter, async (req, res, next) => {
  try {
    const { status, severity, category } = req.body || {};
    const result = await pool.query(
      `UPDATE problems SET status = COALESCE($1, status), severity = COALESCE($2, severity), category = COALESCE($3, category)
       WHERE id = $4 RETURNING *`,
      [status, severity, category, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, writeLimiter, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM problems WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
FILEEOF
cat > 'backend/scripts/create-admin.js' << 'FILEEOF'
// Run once after deploying: npm run create-admin
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env, creates (or promotes) that
// user to role='admin'. This is the ONLY way an admin account gets made —
// the public /register endpoint always creates plain 'user' accounts.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, initSchema } = require("../db");

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  await initSchema();
  const hash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'`,
    [email.toLowerCase(), hash]
  );
  console.log(`Admin account ready: ${email}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
FILEEOF
cat > 'frontend/index.html' << 'FILEEOF'
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Safetyroad</title>
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <div id="app"></div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
  <script src="js/i18n.js"></script>
  <script src="js/state.js"></script>
  <script src="js/map.js"></script>
  <script src="js/problems.js"></script>
  <script src="js/settings.js"></script>
  <script src="js/chat.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
FILEEOF
cat > 'frontend/css/style.css' << 'FILEEOF'
:root {
  --bg: #0A0F1A;
  --surface: #0F1626;
  --surface-raised: #141C30;
  --border: #212C42;
  --text: #E8ECF6;
  --text-muted: #7C8AAA;
  --accent: #F2A93B;
  --accent-text: #0A0F1A;
  --danger: #F0625F;
  --ok: #4CC38A;
  --land: #1C2740;
  --land-hover: #2A3A5C;
}

[data-theme="light"] {
  --bg: #F4F5F2;
  --surface: #FFFFFF;
  --surface-raised: #FBFBFA;
  --border: #E1E4DD;
  --text: #171B14;
  --text-muted: #63705F;
  --accent: #C9631B;
  --accent-text: #FFFFFF;
  --danger: #C43D3D;
  --ok: #237A57;
  --land: #E4E8DE;
  --land-hover: #C9D1BE;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Manrope', 'Inter', system-ui, sans-serif;
}

.header {
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.header-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
}
.logo-title { font-weight: 600; line-height: 1.2; }
.logo-tagline { color: var(--text-muted); font-size: 12px; line-height: 1.2; }

.tabs {
  display: flex;
  gap: 4px;
  margin-left: auto;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
}
.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 14px;
  background: transparent;
  color: var(--text);
  border: none;
  cursor: pointer;
}
.tab-btn.active { background: var(--accent); color: var(--accent-text); }

main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 16px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}

.map-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; }
@media (max-width: 800px) { .map-grid, .problems-grid { grid-template-columns: 1fr; } }

.map-card { position: relative; overflow: hidden; padding: 0; }
.map-card svg { width: 100%; display: block; cursor: grab; }
.map-overlay {
  position: absolute;
  z-index: 10;
  font-size: 11px;
  background: var(--surface-raised);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
}
.map-overlay.top-left { top: 12px; left: 12px; }
.map-overlay.bottom-left { bottom: 8px; left: 12px; background: transparent; border: none; }
.map-overlay.bottom-right { bottom: 8px; right: 12px; font-weight: 500; }
.map-controls { position: absolute; top: 12px; right: 12px; z-index: 10; display: flex; flex-direction: column; gap: 4px; }
.map-btn {
  width: 28px; height: 28px; border-radius: 6px;
  background: var(--surface-raised); border: 1px solid var(--border); color: var(--text);
  display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px;
}
.map-loading {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: var(--text-muted);
}

.region-path { cursor: pointer; transition: fill 0.1s; }

.panel-title { font-size: 14px; font-weight: 500; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
.panel-title button { background: none; border: none; color: var(--text-muted); font-size: 12px; cursor: pointer; }
.muted { color: var(--text-muted); font-size: 14px; }

.problem-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 520px; overflow: auto; }
.problem-item { border: 1px solid var(--border); background: var(--surface-raised); border-radius: 8px; padding: 10px; display: flex; align-items: flex-start; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.problem-item-title { font-size: 14px; line-height: 1.3; }
.problem-item-meta { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.admin-btn { font-size: 11px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
.admin-btn:hover { background: var(--land-hover); }

.problems-grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; }
.field-label { color: var(--text-muted); font-size: 12px; margin-bottom: 4px; }
.upload-box {
  border: 1px dashed var(--border); background: var(--surface-raised); border-radius: 8px;
  padding: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 12px; cursor: pointer;
}
.upload-box img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; }
textarea, select, input[type="text"], input[type="password"] {
  width: 100%; background: var(--surface-raised); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 8px; font-size: 14px; font-family: inherit; outline: none; margin-bottom: 12px;
}
.btn-primary {
  width: 100%; background: var(--accent); color: var(--accent-text); border: none;
  border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 500; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
.btn-primary:disabled { opacity: 0.6; cursor: default; }
.verdict-box { border-radius: 8px; padding: 12px; margin-top: 12px; font-size: 14px; display: flex; gap: 8px; background: var(--surface-raised); }
.verdict-title { font-weight: 500; margin-bottom: 2px; }

.settings-wrap { max-width: 560px; display: flex; flex-direction: column; gap: 16px; }
.settings-row { display: flex; align-items: center; justify-content: between; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.segmented { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.segmented button { padding: 6px 12px; font-size: 14px; background: transparent; color: var(--text); border: none; cursor: pointer; }
.segmented button.active { background: var(--accent); color: var(--accent-text); }
.theme-btn { display: flex; align-items: center; gap: 8px; border: 2px solid transparent; }
/* Fixed look regardless of the site's current theme, so each button always
   shows what selecting it would look like — no flipping colors. */
.segmented button.theme-btn[data-theme="light"] { background: #FFFFFF; color: #171B14; }
.segmented button.theme-btn[data-theme="dark"] { background: #0A0F1A; color: #E8ECF6; }
.segmented button.theme-btn.active { border-color: var(--accent); }
.theme-swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #8884; flex-shrink: 0; }
.theme-swatch.light { background: #FFFFFF; border-color: #ccc; }
.theme-swatch.dark { background: #0A0F1A; }
.toggle { width: 40px; height: 24px; border-radius: 999px; background: var(--land-hover); border: none; cursor: pointer; padding: 2px; display: flex; }
.toggle.on { background: var(--accent); justify-content: flex-end; }
.toggle-knob { width: 20px; height: 20px; border-radius: 50%; background: white; }
.warn-text { color: var(--danger); font-size: 12px; }
.note-text { color: var(--text-muted); font-size: 12px; line-height: 1.5; }

.chat-fab {
  position: fixed; bottom: 20px; right: 20px; width: 48px; height: 48px; border-radius: 50%;
  background: var(--accent); color: var(--accent-text); border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-size: 20px;
}
.chat-panel {
  position: fixed; bottom: 20px; right: 20px; width: 320px; max-width: 90vw;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden;
}
.chat-header { border-bottom: 1px solid var(--border); padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
.chat-header button { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; }
.chat-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow: auto; }
.chat-msg { font-size: 12px; border-radius: 8px; padding: 8px; max-width: 85%; }
.chat-msg.bot { background: var(--surface-raised); color: var(--text-muted); align-self: flex-start; }
.chat-msg.user { background: var(--accent); color: var(--accent-text); align-self: flex-end; }
.chat-input-row { border-top: 1px solid var(--border); padding: 8px; display: flex; gap: 8px; }
.chat-input-row input { margin: 0; flex: 1; font-size: 12px; padding: 6px 8px; }
.chat-input-row button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 16px; }
FILEEOF
cat > 'frontend/js/i18n.js' << 'FILEEOF'
const STRINGS = {
  ru: {
    appName: "Safetyroad",
    tagline: "Карта всех регионов России",
    tabMap: "Карта", tabProblems: "Проблемы", tabSettings: "Настройки",
    allRegions: "Вся страна", problemsIn: "Проблемы —",
    noSelection: "Нажмите на любой регион на карте, чтобы увидеть его проблемы.",
    newProblem: "Новое обращение", photo: "Фотография",
    photoHint: "Загрузите фото проблемы (дорога, освещение, мусор и т.д.)",
    changePhoto: "Заменить фото", descLabel: "Описание проблемы",
    descPlaceholder: "Кратко опишите, что не так…", regionLabel: "Регион",
    submit: "Отправить на проверку ИИ", submitting: "Отправляем…",
    loginToSubmit: "Войдите, чтобы отправить обращение.",
    verdictHeading: "Ответ ИИ",
    verdictNone: "Обращение отправлено. ИИ-проверка не настроена администратором — ждите ручной модерации.",
    verdictError: "Обращение отправлено, но при обращении к серверу произошла ошибка.",
    feedTitle: "Лента обращений",
    statusNew: "На проверке", statusConfirmed: "Подтверждено", statusRejected: "Отклонено",
    settingsAppearance: "Оформление", settingsTheme: "Тема", themeLight: "Светлая", themeDark: "Тёмная",
    settingsLanguage: "Язык",
    settingsAccount: "Аккаунт",
    email: "Email", password: "Пароль",
    login: "Войти", register: "Регистрация", logout: "Выйти",
    loggedInAs: "Вы вошли как", roleAdmin: "администратор", roleUser: "пользователь",
    authError: "Неверный email или пароль.",
    noAccount: "Нет аккаунта? Зарегистрироваться", haveAccount: "Уже есть аккаунт? Войти",
    settingsAdminApi: "DeepSeek API (только админ)",
    deepseekKeyLabel: "Ключ DeepSeek",
    deepseekKeySet: "Ключ задан и хранится только на сервере.",
    deepseekKeyNotSet: "Ключ не задан — автопроверка фото через ИИ выключена для всех.",
    saveKey: "Сохранить", keySaved: "Сохранено.",
    settingsSupport: "Поддержка", supportToggle: "Показывать чат поддержки",
    dataNote: "Обращения и аккаунты хранятся на сервере в базе данных — это уже не сбрасывается при перезагрузке страницы.",
    chatTitle: "Поддержка", chatWelcome: "Здравствуйте! Это лёгкий локальный помощник без реального оператора.",
    chatPlaceholder: "Напишите сообщение…", chatFallback: "Пока не знаю ответа на это.",
    mapLoading: "Загружаем границы всех регионов…",
    mapError: "Не удалось загрузить границы регионов (нет сети или источник недоступен).",
    zoomHint: "Колесо мыши — масштаб, перетаскивание — сдвиг, клик по региону — выбрать",
    regionsLoaded: "регионов на карте",
    road: "Дороги", light: "Освещение", trash: "Мусор", utilities: "ЖКХ", other: "Другое",
    adminConfirm: "Подтвердить", adminReject: "Отклонить", adminDelete: "Удалить",
  },
  en: {
    appName: "Safetyroad",
    tagline: "A map of every region of Russia",
    tabMap: "Map", tabProblems: "Problems", tabSettings: "Settings",
    allRegions: "Whole country", problemsIn: "Problems —",
    noSelection: "Click any region on the map to see its problems.",
    newProblem: "New report", photo: "Photo",
    photoHint: "Upload a photo of the issue (road, lighting, waste, etc.)",
    changePhoto: "Change photo", descLabel: "Description",
    descPlaceholder: "Briefly describe the issue…", regionLabel: "Region",
    submit: "Send for AI review", submitting: "Sending…",
    loginToSubmit: "Log in to submit a report.",
    verdictHeading: "AI response",
    verdictNone: "Report sent. AI review isn't configured by the admin yet — it awaits manual moderation.",
    verdictError: "Report sent, but something went wrong talking to the server.",
    feedTitle: "Report feed",
    statusNew: "Under review", statusConfirmed: "Confirmed", statusRejected: "Rejected",
    settingsAppearance: "Appearance", settingsTheme: "Theme", themeLight: "Light", themeDark: "Dark",
    settingsLanguage: "Language",
    settingsAccount: "Account",
    email: "Email", password: "Password",
    login: "Log in", register: "Register", logout: "Log out",
    loggedInAs: "Logged in as", roleAdmin: "admin", roleUser: "user",
    authError: "Wrong email or password.",
    noAccount: "No account? Register", haveAccount: "Already have an account? Log in",
    settingsAdminApi: "DeepSeek API (admin only)",
    deepseekKeyLabel: "DeepSeek key",
    deepseekKeySet: "Key is set and stored server-side only.",
    deepseekKeyNotSet: "No key set — automatic AI photo review is off for everyone.",
    saveKey: "Save", keySaved: "Saved.",
    settingsSupport: "Support", supportToggle: "Show support chat",
    dataNote: "Reports and accounts are stored server-side in a database — this no longer resets on page reload.",
    chatTitle: "Support", chatWelcome: "Hi! This is a lightweight local assistant, not a live agent.",
    chatPlaceholder: "Type a message…", chatFallback: "I don't have an answer for that yet.",
    mapLoading: "Loading every region's borders…",
    mapError: "Couldn't load region borders (no network or source unavailable).",
    zoomHint: "Scroll to zoom, drag to pan, click a region to select it",
    regionsLoaded: "regions on the map",
    road: "Roads", light: "Lighting", trash: "Waste", utilities: "Utilities", other: "Other",
    adminConfirm: "Confirm", adminReject: "Reject", adminDelete: "Delete",
  },
};
FILEEOF
cat > 'frontend/js/state.js' << 'FILEEOF'
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
FILEEOF
cat > 'frontend/js/map.js' << 'FILEEOF'
// ---------------------------------------------------------------------------
// Map tab — every federal subject of Russia rendered as its own clickable
// polygon. Interactions (hover/click/zoom) are handled locally, not through
// the global render(), so panning/zooming stays smooth.
// ---------------------------------------------------------------------------
// Preferred: your own copy, self-hosted next to index.html (see README).
const GEOJSON_URL_PRIMARY = "./russia.geojson";
// Fallback: used automatically if the file above isn't found (e.g. it
// hasn't been uploaded to the repo yet) — this guarantees the map still
// works while you sort that out.
const GEOJSON_URL_FALLBACK = "https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/russia.geojson";
const VIEW_W = 800, VIEW_H = 500;

let geoCache = null; // null | {status:'loading'|'ok'|'error', data}

function fetchGeoJson(url) {
  return fetch(url).then((r) => { if (!r.ok) throw new Error("bad status"); return r.json(); });
}

function loadGeoData(onDone) {
  if (geoCache && geoCache.status !== "loading") { onDone(); return; }
  if (geoCache && geoCache.status === "loading") return; // already in flight
  geoCache = { status: "loading", data: null };
  fetchGeoJson(GEOJSON_URL_PRIMARY)
    .catch(() => fetchGeoJson(GEOJSON_URL_FALLBACK))
    .then((data) => {
      geoCache = { status: "ok", data };
      state.regionNames = data.features.map((f) => f.properties.name).filter(Boolean).sort();
      onDone();
    })
    .catch(() => {
      geoCache = { status: "error", data: null };
      onDone();
    });
}

function renderMapTab(mount) {
  const s = t();
  mount.innerHTML = `
    <div class="map-grid">
      <div class="card map-card" id="map-card">
        <div class="map-loading" id="map-loading"><span>${s.mapLoading}</span></div>
        <div class="map-overlay top-left" id="map-count" style="display:none"></div>
        <div class="map-controls" style="display:none" id="map-controls">
          <button class="map-btn" id="zoom-in">+</button>
          <button class="map-btn" id="zoom-out">−</button>
          <button class="map-btn" id="zoom-reset">⟲</button>
        </div>
        <div class="map-overlay bottom-left" id="map-hint" style="display:none">${s.zoomHint}</div>
        <div class="map-overlay bottom-right" id="map-hover" style="display:none"></div>
        <svg id="map-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" style="aspect-ratio:${VIEW_W}/${VIEW_H}"></svg>
      </div>
      <div class="card" id="map-side"></div>
    </div>
  `;
  renderSidePanel(mount);
  loadProblems().then(() => {
    renderSidePanel(mount);
    if (geoCache && geoCache.status === "ok") drawMap(mount); // refresh colors now that counts are known
  });
  loadGeoData(() => drawMap(mount));
}

function drawMap(mount) {
  const loadingEl = mount.querySelector("#map-loading");
  if (!loadingEl) return; // user navigated away before fetch finished
  const s = t();

  if (geoCache.status === "error") {
    loadingEl.innerHTML = `<span style="color:var(--danger)">${s.mapError}</span>`;
    return;
  }
  loadingEl.style.display = "none";
  mount.querySelector("#map-count").style.display = "block";
  mount.querySelector("#map-count").textContent = `${geoCache.data.features.length} ${s.regionsLoaded}`;
  mount.querySelector("#map-controls").style.display = "flex";
  mount.querySelector("#map-hint").style.display = "block";

  const svg = d3.select(mount.querySelector("#map-svg"));
  svg.selectAll("*").remove();
  svg.append("rect").attr("width", VIEW_W).attr("height", VIEW_H).attr("fill", cssVar("--surface"));
  const g = svg.append("g");

  const projection = d3.geoMercator().fitExtent([[10, 10], [VIEW_W - 10, VIEW_H - 10]], geoCache.data);
  const path = d3.geoPath(projection);
  const counts = regionCounts();
  const maxCount = Math.max(1, ...Object.values(counts));
  const th = theme();
  const borderColor = cssVar("--border");

  const hoverBox = mount.querySelector("#map-hover");

  g.selectAll("path.region-path")
    .data(geoCache.data.features)
    .join("path")
    .attr("class", "region-path")
    .attr("d", path)
    .attr("fill", (f) => fillFor(f.properties.name, counts, maxCount, th))
    .attr("stroke", borderColor)
    .attr("stroke-width", 0.5)
    .on("mouseenter", function (event, f) {
      if (f.properties.name !== state.selectedRegion) d3.select(this).attr("fill", th.landHover);
      hoverBox.style.display = "block";
      hoverBox.textContent = f.properties.name;
    })
    .on("mouseleave", function (event, f) {
      if (f.properties.name !== state.selectedRegion) d3.select(this).attr("fill", fillFor(f.properties.name, counts, maxCount, th));
      hoverBox.style.display = "none";
    })
    .on("click", (event, f) => {
      const name = f.properties.name;
      state.selectedRegion = state.selectedRegion === name ? null : name;
      g.selectAll("path.region-path")
        .attr("fill", (d) => fillFor(d.properties.name, counts, maxCount, th))
        .attr("stroke-width", (d) => (d.properties.name === state.selectedRegion ? 1.5 : 0.5));
      renderSidePanel(mount);
    });

  const zoom = d3.zoom()
    .scaleExtent([1, 10])
    .translateExtent([[-VIEW_W, -VIEW_H], [VIEW_W * 2, VIEW_H * 2]])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  mount.querySelector("#zoom-in").onclick = () => svg.transition().duration(200).call(zoom.scaleBy, 1.5);
  mount.querySelector("#zoom-out").onclick = () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
  mount.querySelector("#zoom-reset").onclick = () => svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
}

function fillFor(name, counts, maxCount, th) {
  if (name === state.selectedRegion) return th.accent;
  const count = counts[name] || 0;
  if (count === 0) return th.land;
  return mixHex(th.land, th.accent, 0.25 + (count / maxCount) * 0.6);
}

function renderSidePanel(mount) {
  const s = t();
  const side = mount.querySelector("#map-side");
  const list = state.selectedRegion
    ? state.problems.filter((p) => p.region === state.selectedRegion)
    : state.problems;

  side.innerHTML = `
    <div class="panel-title">
      <span>${s.problemsIn} ${state.selectedRegion || s.allRegions}</span>
      ${state.selectedRegion ? `<button id="clear-region">${s.allRegions}</button>` : ""}
    </div>
    ${list.length === 0
      ? `<p class="muted">${s.noSelection}</p>`
      : `<ul class="problem-list">${list.map((p) => `
          <li class="problem-item">
            <span class="dot" style="background:${severityColor(p.severity)}"></span>
            <div style="flex:1">
              <div class="problem-item-title">${problemTitle(p)}</div>
              <div class="problem-item-meta">${p.region} · ${s[p.category]} · ${s["status" + capitalize(p.status)]}</div>
              ${adminActionsHtml(p)}
            </div>
          </li>`).join("")}</ul>`
    }
  `;
  const clearBtn = side.querySelector("#clear-region");
  if (clearBtn) clearBtn.onclick = () => { state.selectedRegion = null; drawMap(mount); renderSidePanel(mount); };
  wireAdminActions(side);
}
FILEEOF
cat > 'frontend/js/problems.js' << 'FILEEOF'
// ---------------------------------------------------------------------------
// Problems tab — submitting requires login. The photo + description go to
// the server; the server calls DeepSeek itself using the key an admin set
// (see Settings), so no key ever touches this file or the browser.
// ---------------------------------------------------------------------------
let uploadedImage = null;

function renderProblemsTab(mount) {
  const s = t();
  if (!state.regionNames.length) loadGeoData(() => renderProblemsTab(mount));
  if (!state.problems.length) loadProblems().then(() => renderProblemsTab(mount));

  const loggedIn = !!state.token;

  mount.innerHTML = `
    <div class="problems-grid">
      <div class="card">
        <div class="panel-title"><span>${s.newProblem}</span></div>
        ${!loggedIn ? `<p class="note-text">${s.loginToSubmit}</p>` : ""}

        <div class="field-label">${s.photo}</div>
        <div class="upload-box" id="upload-box">
          ${uploadedImage ? `<img src="${uploadedImage}" />` : ""}
          <span class="muted">${uploadedImage ? s.changePhoto : s.photoHint}</span>
        </div>
        <input type="file" accept="image/*" id="file-input" style="display:none" />

        <div class="field-label">${s.descLabel}</div>
        <textarea id="desc-input" rows="3" placeholder="${s.descPlaceholder}"></textarea>

        <div class="field-label">${s.regionLabel}</div>
        <select id="region-select">
          ${state.regionNames.length === 0
            ? `<option value="">…</option>`
            : state.regionNames.map((n) => `<option value="${n}">${n}</option>`).join("")}
        </select>

        <button class="btn-primary" id="submit-btn" ${!loggedIn ? "disabled" : ""}>${s.submit}</button>
        <div id="verdict-slot"></div>
      </div>

      <div class="card">
        <div class="panel-title"><span>${s.feedTitle}</span></div>
        <ul class="problem-list">
          ${state.problems.map((p) => `
            <li class="problem-item">
              <div style="flex:1">
                <div class="problem-item-title">${problemTitle(p)}</div>
                <div class="problem-item-meta">
                  <span class="dot" style="display:inline-block;background:${severityColor(p.severity)}"></span>
                  ${p.region} · ${s["status" + capitalize(p.status)]}
                </div>
                ${p.ai_verdict ? `<div class="note-text" style="margin-top:4px">🤖 ${p.ai_verdict}</div>` : ""}
                ${adminActionsHtml(p)}
              </div>
            </li>`).join("")}
        </ul>
      </div>
    </div>
  `;

  mount.querySelector("#upload-box").onclick = () => mount.querySelector("#file-input").click();
  mount.querySelector("#file-input").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { uploadedImage = reader.result; renderProblemsTab(mount); };
    reader.readAsDataURL(file);
  };

  const submitBtn = mount.querySelector("#submit-btn");
  if (submitBtn) submitBtn.onclick = () => submitProblem(mount);
  wireAdminActions(mount);
}

async function submitProblem(mount) {
  const s = t();
  const verdictSlot = mount.querySelector("#verdict-slot");
  const desc = mount.querySelector("#desc-input").value;
  const region = mount.querySelector("#region-select").value;
  const submitBtn = mount.querySelector("#submit-btn");
  if (!region) return;

  verdictSlot.innerHTML = "";
  submitBtn.disabled = true;
  submitBtn.textContent = s.submitting;

  try {
    const created = await api("/problems", {
      method: "POST",
      body: JSON.stringify({
        region,
        category: "other",
        severity: "med",
        titleRu: desc || "Новое обращение",
        titleEn: desc || "New report",
        imageDataUrl: uploadedImage,
      }),
    });
    uploadedImage = null;
    await loadProblems();
    renderProblemsTab(mount);
    const slot = mount.querySelector("#verdict-slot");
    if (slot) {
      slot.innerHTML = created.ai_verdict
        ? verdictHtml(true, created.ai_verdict, s)
        : `<p class="note-text">${s.verdictNone}</p>`;
    }
  } catch {
    verdictSlot.innerHTML = `<p class="warn-text">${s.verdictError}</p>`;
    submitBtn.disabled = false;
    submitBtn.textContent = s.submit;
  }
}

function verdictHtml(ok, text, s) {
  return `
    <div class="verdict-box" style="border:1px solid ${ok ? "var(--ok)" : "var(--danger)"}">
      <div>
        <div class="verdict-title">${s.verdictHeading}</div>
        <div class="muted">${text}</div>
      </div>
    </div>`;
}
FILEEOF
cat > 'frontend/js/settings.js' << 'FILEEOF'
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
FILEEOF
cat > 'frontend/js/chat.js' << 'FILEEOF'
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
FILEEOF
cat > 'frontend/js/app.js' << 'FILEEOF'
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
FILEEOF
echo "DONE — structure rebuilt."
find . -maxdepth 3 -type f | sort
