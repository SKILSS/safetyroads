# Daily external road-problem import

SafetyRoad can import public, machine-readable road/civic-problem data once every 24 hours.
It does **not** and cannot literally crawl "the entire internet": there is no universal index/API of every Russian road report, and many sites prohibit scraping. This importer therefore uses public sources and configurable RSS/Atom feeds.

## Included sources

1. OpenStreetMap via Overpass — coordinates + tags for hazards, mud surfaces, very bad/horrible/impassable smoothness, road construction/roadworks.
2. Default Google News RSS searches for Russian road-problem topics.
3. Add official regional RSS/Atom feeds with `EXTERNAL_RSS_FEEDS` (one URL per line).

Imported records have `source_type`, `source_name`, `source_url`, `external_id`, and `imported_at`, and are deduplicated.

## Render Cron Job

Create a separate Render **Cron Job** using the same repository and set:

- Build command: `npm install`
- Command: `npm run sync-external-problems`
- Schedule: `0 2 * * *` (02:00 UTC, once daily)

Render cron schedules use UTC. The cron service should have the same `DATABASE_URL` as the web service. It can also have `GEMINI_API_KEY` if you later enable AI classification of external articles.

## Optional custom feeds

Set:

`EXTERNAL_RSS_FEEDS=https://example.gov/feed.xml\nhttps://another-region.example/rss`

Prefer official/public RSS or APIs over scraping pages.


The importer only keeps recent RSS items (default 7 days) and marks OSM items not seen for 14 days as resolved. This avoids an ever-growing list of stale external reports.
