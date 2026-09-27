const express = require("express");
const router = express.Router();

const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
let lastRequestAt = 0;

router.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2 || q.length > 180) return res.json([]);

  // Be polite to the public Nominatim service: one proxied request per
  // ~1.1s per process, with browser-side debounce on top.
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = new URL(NOMINATIM);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(Math.min(8, Math.max(1, Number(req.query.limit) || 6))));
  url.searchParams.set("q", q);
  url.searchParams.set("accept-language", req.query.lang === "en" ? "en" : "ru");
  if (req.query.country === "ru") url.searchParams.set("countrycodes", "ru");

  try {
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "SafetyRoad/2.1 (address-search; contact via project admin)"
      }
    });
    if (!r.ok) return res.status(502).json({ error: "Geocoding service unavailable." });
    const data = await r.json();
    res.set("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch (err) {
    console.error("[geocode]", err);
    res.status(502).json({ error: "Geocoding service unavailable." });
  }
});

module.exports = router;
