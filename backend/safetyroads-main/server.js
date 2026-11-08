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
const geocodeRoutes = require("./routes/geocode");
const aiRoutes = require("./routes/ai");
const { runDailyPriceSync } = require("./scripts/sync-prices");
const { startDailyExternalSyncScheduler } = require("./scripts/sync-external-problems");
const { startDailyRussiaStationSyncScheduler } = require("./scripts/sync-stations-russia");

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
app.use("/api/geocode", geocodeRoutes);
app.use("/api/ai", aiRoutes);

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

const port = process.env.PORT || 8080;
const PRICE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // exactly once per 24h

function schedulePriceSync() {
  const run = () => {
    runDailyPriceSync().catch((err) => console.error("[sync-prices] daily run failed:", err));
  };
  run(); // runs immediately only when the 24h cache is due
  setInterval(run, PRICE_SYNC_INTERVAL_MS);
}

async function start() {
  // Open the port FIRST so Render (and other hosts) detect the service right
  // away. DB init and the heavy first import run afterwards, in the background.
  app.listen(port, "0.0.0.0", () => console.log(`RegionWatch listening on :${port}`));

  // Two instances can overlap during a deploy; concurrent ALTER TABLE then
  // deadlocks (40P01). Retry a few times instead of crashing.
  for (let attempt = 1; ; attempt++) {
    try {
      await initSchema();
      break;
    } catch (err) {
      if (err.code === "40P01" && attempt < 6) {
        console.warn(`[db] initSchema deadlock, retry ${attempt}/5 in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw err;
      }
    }
  }

  // First deployment: if the RU cache is empty, import Russian fuel stations
  // in the background. The server is already accepting requests meanwhile.
  try {
    const stationCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM gas_stations WHERE country_code='RU'`
    );
    if (stationCount.rows[0].count === 0 && process.env.STATIONS_SYNC_BEFORE_LISTEN !== "false") {
      console.log("[stations] RU cache is empty; importing Russian fuel stations in background...");
      require("./scripts/sync-stations-russia").syncRussiaStations()
        .then(() => console.log("[stations] initial RU import finished"))
        .catch((err) => console.error("[stations] initial RU import failed:", err.message));
    }
  } catch (err) {
    console.error("[stations] could not check RU cache:", err.message);
  }

  schedulePriceSync();
  startDailyExternalSyncScheduler();
  startDailyRussiaStationSyncScheduler();
}
start().catch((err) => { console.error("Failed to start:", err); process.exit(1); });


process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
