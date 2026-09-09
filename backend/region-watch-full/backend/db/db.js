require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

const { pool, initSchema } = require("./db");
const {
  apiLimiter,
  authLimiter,
  authSlowDown
} = require("./middleware/security");

const authRoutes = require("./routes/auth");
const problemsRoutes = require("./routes/problems");
const adminRoutes = require("./routes/admin");

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());

app.use(
  express.json({
    limit: "3mb"
  })
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: false
  })
);

app.use("/api", apiLimiter);

app.use(
  "/api/auth/login",
  authLimiter,
  authSlowDown
);

app.use(
  "/api/auth/register",
  authLimiter,
  authSlowDown
);

app.get("/health", (req, res) => {
  res.json({
    ok: true
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/problems", problemsRoutes);
app.use("/api/admin", adminRoutes);

// Frontend
const frontendPath = path.join(
  __dirname,
  "..",
  "frontend"
);

app.use(express.static(frontendPath));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  res.sendFile(
    path.join(frontendPath, "index.html")
  );
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal server error."
  });
});

// Render provides PORT
const port = process.env.PORT || 8080;

async function start() {
  try {
    await initSchema();

    app.listen(port, "0.0.0.0", () => {
      console.log(
        `RegionWatch listening on port ${port}`
      );
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});