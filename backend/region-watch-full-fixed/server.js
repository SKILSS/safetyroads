require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

const { pool, initSchema } = require("./backend/db");
const { apiLimiter, authLimiter, authSlowDown } = require("./backend/middleware/security");
const authRoutes = require("./backend/routes/auth");
const problemsRoutes = require("./backend/routes/problems");
const adminRoutes = require("./backend/routes/admin");

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
