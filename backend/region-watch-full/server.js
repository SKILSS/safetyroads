require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

const { pool, initSchema } = require("./backend/db");
const { ensureAdmin } = require("./backend/scripts/ensure-admin");
const { apiLimiter, authLimiter, authSlowDown } = require("./backend/middleware/security");
const authRoutes = require("./backend/routes/auth");
const problemsRoutes = require("./backend/routes/problems");
const adminRoutes = require("./backend/routes/admin");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }

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
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

const port = process.env.PORT || 8080;
async function start() {
  await initSchema();
  await ensureAdmin();
  app.listen(port, () => console.log(`RegionWatch listening on :${port}`));
}
start().catch((err) => { console.error("Failed to start:", err); process.exit(1); });

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
