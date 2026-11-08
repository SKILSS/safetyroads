# SafetyRoad v15 — Russia-only data guard

This version fixes legacy foreign data (including Finland) that could remain in PostgreSQL after earlier rectangular viewport imports.

- Road problems from OSM are collected only through the OSM Russian Federation boundary.
- Legacy external problem rows are no longer exposed on the public map and are retired by the daily sync when their region/source context is foreign.
- Gas-station OSM refreshes are constrained to the Russian Federation and purge stale cached OSM stations inside the refreshed viewport that are not in the fresh RU-only result.
- Gas stations have a `country_code` field; fresh OSM/manual/provider rows created by this version are marked `RU`.
- Address search uses Nominatim `countrycodes=ru`.
- User-created reports still require a Russian region.

The fix does not claim that an RSS feed contains every Russian report; it filters the configured sources to Russian context.


## Full Russia gas-station dataset
The map now supports a complete Russia-only station cache via `scripts/sync-stations-russia.js` and `/stations?country=RU`. The low-zoom map loads the full RU cache with marker clustering; high zoom keeps viewport loading for performance. Foreign station rows are excluded by `country_code='RU'` in country mode.
