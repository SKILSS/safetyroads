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
const stationsRoutes = require("./routes/stations");
const { syncStations } = require("./scripts/sync-stations");
const { syncPrices } = require("./scripts/sync-prices");
const { syncRoadProblems } = require("./scripts/sync-road-problems");

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
app.use("/api/stations", stationsRoutes);

// Serve the frontend from the same server, so one deploy = the whole site.
app.use(express.static(path.join(__dirname, "frontend")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

// Keeps gas station markers (locations from OSM) and their prices (from
// whatever provider is configured in Settings > Admin panel) current
// automatically, once a day — no external cron needed. Runs shortly after
// boot, then every 24h. Both syncs are safe to call with nothing configured:
// syncStations just re-pulls OSM's free data, syncPrices logs and no-ops if
// no provider is set.
const DAY_MS = 24 * 60 * 60 * 1000;
async function runDailyStationSync() {
  try {
    await syncStations();
  } catch (err) {
    console.error("Scheduled station sync failed:", err);
  }
  try {
    await syncRoadProblems();
  } catch (err) {
    console.error("Scheduled road-problem sync failed:", err);
  }
  try {
    await syncPrices();
  } catch (err) {
    console.error("Scheduled price sync failed:", err);
  }
}
function scheduleDailyStationSync() {
  setTimeout(runDailyStationSync, 60 * 1000); // small delay so it doesn't compete with server boot
  setInterval(runDailyStationSync, DAY_MS);
}

const port = process.env.PORT || 8080;
async function start() {
  await initSchema();
  app.listen(port, () => console.log(`RegionWatch listening on :${port}`));
  scheduleDailyStationSync();
}
start().catch((err) => { console.error("Failed to start:", err); process.exit(1); });

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });