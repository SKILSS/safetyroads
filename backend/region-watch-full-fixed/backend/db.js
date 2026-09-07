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
