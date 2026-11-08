# Все АЗС России

SafetyRoad stores gas-station locations from OpenStreetMap (`amenity=fuel`).

## Full Russia import

Run from `backend/safetyroads-main`:

```bash
npm run sync-stations-russia
```

The importer splits Russia into geographic tiles, queries the RU administrative
boundary on Overpass, and upserts nodes/ways/relations. It never intentionally
queries neighbouring countries. `osm_id` prevents duplicates and prices are not
overwritten.

The web map uses `GET /stations?country=RU` below zoom 8, so the complete
Russia-only station cache can be clustered and displayed on the map. At higher
zoom it uses the viewport endpoint to keep interaction fast.

### Important

This is an OpenStreetMap-derived dataset, not a government registry. “All”
therefore means all Russian fuel stations currently mapped in the OSM data
available to the Overpass service at the time of synchronization. Unmapped or
newly opened stations can be absent until the next sync.

For live prices, configure the existing `sync-prices.js` provider separately;
station locations and prices are different data sources.
