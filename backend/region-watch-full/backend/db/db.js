require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

// ---------- Helper ----------
function loadModule(paths) {
  for (const p of paths) {
    const fullPath = path.resolve(__dirname, p);

    if (
      fs.existsSync(fullPath + ".js") ||
      fs.existsSync(fullPath) ||
      fs.existsSync(fullPath + "/index.js")
    ) {
      return require(fullPath);
    }
  }

  throw new Error(
    "Module not found. Tried:\n" +
      paths.map((p) => " - " + path.resolve(__dirname, p)).join("\n")
  );
}

// ---------- Database ----------
const { pool, initSchema } = loadModule([
  "./db",
  "./db/db",
  "./backend/db",
]);

// ---------- Routes ----------
const authRoutes = loadModule([
  "./routes/auth",
  "./маршруты/auth",
  "./backend/routes/auth",
]);

const problemsRoutes = loadModule([
  "./routes/problems",
  "./маршруты/problems",
  "./backend/routes/problems",
]);

const adminRoutes = loadModule([
  "./routes/admin",
  "./маршруты/admin",
  "./backend/routes/admin",
]);

// ---------- Security ----------
const security = loadModule([
  "./middleware/security",
  "./промежуточное программное обеспечение/security",
  "./backend/middleware/security",
]);

const {
  apiLimiter,
  authLimiter,
  authSlowDown,
} = security;

// ---------- App ----------
const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(compression());

app.use(
  express.json({
    limit: "3mb",
  })
);

// ---------- CORS ----------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: false,
  })
);

// ---------- API limits ----------
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

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "RegionWatch",
  });
});

// ---------- API ----------
app.use("/api/auth", authRoutes);
app.use("/api/problems", problemsRoutes);
app.use("/api/admin", adminRoutes);

// ---------- Frontend ----------
const frontendCandidates = [
  "../frontend",
  "./frontend",
  "../Src/внешний интерфейс",
  "./Src/внешний интерфейс",
];

let frontendPath = null;

for (const candidate of frontendCandidates) {
  const possible = path.resolve(__dirname, candidate);

  if (
    fs.existsSync(possible) &&
    fs.existsSync(path.join(possible, "index.html"))
  ) {
    frontendPath = possible;
    break;
  }
}

if (frontendPath) {
  console.log("Frontend:", frontendPath);

  app.use(express.static(frontendPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  console.warn("Frontend index.html was not found.");
}

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal server error.",
  });
});

// ---------- Start ----------
const port = process.env.PORT || 8080;

async function start() {
  try {
    await initSchema();

    app.listen(port, "0.0.0.0", () => {
      console.log(`RegionWatch listening on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

// ---------- Shutdown ----------
process.on("SIGTERM", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});

start();
