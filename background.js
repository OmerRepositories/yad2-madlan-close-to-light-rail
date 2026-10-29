// Service worker: גיאוקוד כתובות (Nominatim) + רשימת תחנות רכבת קלה (Overpass / OpenStreetMap)

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const STATIONS_TTL_MS = 7 * 24 * 3600 * 1000; // שבוע
const GEO_MIN_GAP_MS = 1100; // Nominatim: מקסימום בקשה בשנייה
const WALK_DETOUR = 1.3; // מקדם המרה מקו אווירי למרחק הליכה משוער
const WALK_M_PER_MIN = 80;

// ---------- עזרי מרחק ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- תחנות ----------
let stationsPromise = null;

async function loadStations() {
  const { stations, stationsAt } = await chrome.storage.local.get([
    "stations",
    "stationsAt",
  ]);
  if (stations && stations.length && Date.now() - (stationsAt || 0) < STATIONS_TTL_MS) {
    return stations;
  }

  const query = `
[out:json][timeout:90];
area["ISO3166-1"="IL"][admin_level=2]->.il;
(
  node["railway"="station"]["station"="light_rail"](area.il);
  node["railway"="station"]["light_rail"="yes"](area.il);
  node["railway"="tram_stop"](area.il);
  node["public_transport"="station"]["light_rail"="yes"](area.il);
);
out body;`;

  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error("Overpass HTTP " + res.status);
      const json = await res.json();
      const list = (json.elements || [])
        .filter((e) => typeof e.lat === "number")
        .map((e) => ({
          lat: e.lat,
          lon: e.lon,
          name:
            (e.tags && (e.tags["name:he"] || e.tags.name || e.tags["name:en"])) ||
            "תחנה",
        }));
      if (!list.length) throw new Error("no stations returned");
      await chrome.storage.local.set({ stations: list, stationsAt: Date.now() });
      return list;
    } catch (err) {
      lastErr = err;
    }
  }
  // אם יש מטמון ישן – עדיף ממנו מכלום
  if (stations && stations.length) return stations;
  throw lastErr || new Error("failed to load stations");
}

function getStations() {
  if (!stationsPromise) {
    stationsPromise = loadStations().catch((e) => {
      stationsPromise = null; // לאפשר ניסיון חוזר
      throw e;
    });
  }
  return stationsPromise;
}

// ---------- גיאוקוד ----------
let geoCache = null;
let geoDirty = false;
let lastGeoCall = 0;
let geoChain = Promise.resolve();

async function ensureGeoCache() {
  if (geoCache) return;
  const { geo } = await chrome.storage.local.get("geo");
  geoCache = geo || {};
}

let saveTimer = null;
function scheduleGeoSave() {
  geoDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!geoDirty) return;
    geoDirty = false;
    // הגבלת גודל המטמון
    const keys = Object.keys(geoCache);
    if (keys.length > 4000) {
      for (const k of keys.slice(0, keys.length - 3000)) delete geoCache[k];
    }
    await chrome.storage.local.set({ geo: geoCache });
  }, 2000);
}

function geocode(q) {
  // שרשור כדי לכבד את מגבלת הקצב
  const job = geoChain.then(async () => {
    await ensureGeoCache();
    if (q in geoCache) return geoCache[q];

    const wait = GEO_MIN_GAP_MS - (Date.now() - lastGeoCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeoCall = Date.now();

    const url =
      NOMINATIM +
      "?format=jsonv2&limit=1&countrycodes=il&accept-language=he&q=" +
      encodeURIComponent(q);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Nominatim HTTP " + res.status);
    const arr = await res.json();
    const hit = arr && arr[0] ? { lat: +arr[0].lat, lon: +arr[0].lon } : null;
    geoCache[q] = hit;
    scheduleGeoSave();
    return hit;
  });
  geoChain = job.catch(() => {});
  return job;
}

// ---------- חישוב ----------
function nearest(stations, lat, lon) {
  let best = null;
  for (const s of stations) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (!best || d < best.distance) best = { ...s, distance: d };
  }
  return best;
}

async function lookup(queries) {
  const stations = await getStations();
  for (let i = 0; i < queries.length; i++) {
    const hit = await geocode(queries[i]);
    if (!hit) continue;
    const st = nearest(stations, hit.lat, hit.lon);
    if (!st) return { ok: false, reason: "no-stations" };
    const meters = Math.round(st.distance);
    return {
      ok: true,
      approx: i > 0, // נפלנו חזרה לשכונה/עיר ולא לכתובת מדויקת
      meters,
      walkMin: Math.max(1, Math.round((meters * WALK_DETOUR) / WALK_M_PER_MIN)),
      station: { name: st.name, lat: st.lat, lon: st.lon },
      origin: hit,
    };
  }
  return { ok: false, reason: "not-found" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "lookup" && Array.isArray(msg.queries)) {
    lookup(msg.queries)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: "error", error: String(err) }));
    return true; // תשובה אסינכרונית
  }
});
