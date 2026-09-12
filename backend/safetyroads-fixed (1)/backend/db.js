const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
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
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      is_road BOOLEAN NOT NULL DEFAULT false, -- true = "whole road is bad", drawn as a red line
      route JSONB, -- array of [lat,lng] pairs when is_road = true
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_problems_region ON problems(region);
    CREATE INDEX IF NOT EXISTS idx_problems_created ON problems(created_at DESC);

    -- Safe on a database that already had the old (pre-map) "problems" table:
    -- adds the new columns in place instead of requiring a fresh DB.
    ALTER TABLE problems ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE problems ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
    ALTER TABLE problems ADD COLUMN IF NOT EXISTS is_road BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE problems ADD COLUMN IF NOT EXISTS route JSONB;

    -- Gas stations. Locations can be bulk-imported (see scripts/sync-stations.js,
    -- which pulls them from OpenStreetMap/Overpass — free, no key needed).
    -- Prices are NOT available from any free/live public feed for Russia, so
    -- they start NULL and are filled in by an admin (Settings > АЗС) or by
    -- wiring your own price provider into that same script.
    CREATE TABLE IF NOT EXISTS gas_stations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      price_92 NUMERIC,
      price_95 NUMERIC,
      price_98 NUMERIC,
      price_dt NUMERIC,
      source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'osm'
      osm_id TEXT UNIQUE, -- prevents duplicate rows when the sync script re-runs
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_stations_coords ON gas_stations(lat, lng);

    -- Single-row table: only the admin can ever write to it (see routes/admin.js).
    -- The DeepSeek key lives here, server-side, never sent to the browser.
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      deepseek_api_key TEXT,
      price_api_key TEXT, -- Bearer token for a fuel-price provider (e.g. Benzup) — see scripts/sync-prices.js
      price_api_url TEXT, -- that provider's "list stations with prices" endpoint
      CONSTRAINT single_row CHECK (id = 1)
    );
    INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS price_api_key TEXT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS price_api_url TEXT;
  `);
}

module.exports = { pool, initSchema };
