require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");

// Импорты с правильными путями
const { pool, initSchema } = require("./db");
const ensureAdmin = require("./scripts/ensure-admin");
const { apiLimiter, authLimiter, authSlowDown } = require("./middleware/security");
const authRoutes = require("./routes/auth");
const problemsRoutes = require("./routes/problems");
const adminRoutes = require("./routes/admin");

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "3mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.length === 0 || allowedOrigins.includes("*") ? true : allowedOrigins;

app.use(cors({ origin: corsOrigin, credentials: false }));

app.use("/api", apiLimiter);
app.use("/api/auth/login", authLimiter, authSlowDown);
app.use("/api/auth/register", authLimiter, authSlowDown);

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/problems", problemsRoutes);
app.use("/api/admin", adminRoutes);

// Раздача статики из папки frontend
app.use(express.static(path.join(__dirname, "frontend")));

// Все запросы, не начинающиеся с /api, отправляют index.html
app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// Обработка ошибок
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error." });
});

const port = process.env.PORT || 8080;

async function start() {
    await initSchema();
    await ensureAdmin();
    app.listen(port, () => console.log(`RegionWatch listening on ${port}`));
}

start().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
});

process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
});