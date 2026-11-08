# Russia road-problem map data

SafetyRoad loads public road-problem reports from its API immediately on page startup. The server runs the external-source importer when it starts if the 24-hour cache is due, then checks hourly and performs a new import after 24 hours. The map refreshes its problem data in the browser while the page is open.

## Sources and limitations

- OpenStreetMap Overpass: mapped hazards, roadworks/construction, and tagged poor road conditions inside the OSM Russian Federation boundary. Pins use the actual OSM object coordinates.
- RSS feeds: public news search feeds configured in `EXTERNAL_RSS_FEEDS`. RSS entries are pinned only when the publisher supplies GeoRSS coordinates. Articles without coordinates must not be assigned guessed map locations; they can still be retained as source records but do not appear as map pins.

There is no single public feed that contains **every** pothole, closure, damaged road, or hazard in Russia. Coverage depends on what contributors and publishers have actually reported and geolocated. OpenStreetMap tags are not official verified incident reports. Users should treat external pins as leads and check the linked source.

## Deploy

1. Deploy the `backend` directory as the Node web service (Node 18+).
2. Configure the existing PostgreSQL `DATABASE_URL`.
3. Keep the service running continuously. The in-process scheduler cannot run while the hosting service is stopped/suspended.
4. Check server logs for `[external] daily sync completed` and `[external/osm]` errors. A failed Overpass run is now recorded as a failed sync instead of a false success; the hourly scheduler retries when due.
5. The browser requests `/api/problems` immediately at startup. The API prioritizes geolocated active records and returns up to 5,000 rows so the map is not limited to the previous 500.

The 24-hour interval is a refresh cadence, not a guarantee that every source publishes new data exactly once per day.
