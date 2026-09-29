# Daily external road-problem import (without a separate Render Cron Job)

SafetyRoad can import public, machine-readable road/civic-problem data approximately once every 24 hours **from the existing Web Service**. No separate Render Cron Job is required.

## How it works

The Web Service checks the PostgreSQL table `external_sync_state`. If the last successful external sync was 24 hours or more ago, it starts a new sync. The check runs at startup and then once per hour while the Web Service process is awake. PostgreSQL advisory locking prevents two instances from running the same daily sync at the same time.

If Render's Free Web Service sleeps, an exact 24-hour wall-clock execution cannot be guaranteed. When the service wakes again, the scheduler checks the stored timestamp and catches up if the 24-hour interval has elapsed.

## Included sources

1. OpenStreetMap via Overpass — coordinates + tags for hazards, mud surfaces, very bad/horrible/impassable smoothness, road construction/roadworks.
2. Default Google News RSS searches for Russian road-problem topics.
3. Add official regional RSS/Atom feeds with `EXTERNAL_RSS_FEEDS` (one URL per line).

Imported records have `source_type`, `source_name`, `source_url`, `external_id`, and `imported_at`, and are deduplicated.

## Render setup

Use your existing **Web Service** only. Do **not** create a separate Cron Job for this feature. The service needs the same `DATABASE_URL` it already uses.

Optional custom feeds:

`EXTERNAL_RSS_FEEDS=https://example.gov/feed.xml\nhttps://another-region.example/rss`

Prefer official/public RSS or APIs over scraping pages.

The importer only keeps recent RSS items (default 7 days) and marks OSM items not seen for 14 days as resolved. This avoids an ever-growing list of stale external reports.
