// Service worker: גיאוקוד כתובות (Nominatim) + רשימת תחנות רכבת קלה (Overpass / OpenStreetMap)

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const STATIONS_TTL_MS = 7 * 24 * 3600 * 1000; // שבוע
const GEO_MIN_GAP_MS = 1050; // Nominatim: מקסימום בקשה בשנייה
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

  // שאילתה לפי bbox (מהירה בהרבה משאילתת area של כל המדינה)
  const query = `
[out:json][timeout:40][bbox:29.3,34.2,33.5,36.0];
(
  node["railway"="station"]["station"="light_rail"];
  node["railway"="station"]["light_rail"="yes"];
  node["railway"="tram_stop"];
  node["public_transport"="station"]["light_rail"="yes"];
);
out body;`;

  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
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

// טעינה מוקדמת של התחנות, כדי שלא יחכו להן כשנכנסים לאתר
chrome.runtime.onInstalled.addListener(() => getStations().catch(() => {}));
chrome.runtime.onStartup.addListener(() => getStations().catch(() => {}));

// ---------- גיאוקוד ----------
let geoCache = null;
let lastGeoCall = 0;
const netQueue = []; // תור בקשות רשת; הבקשה האחרונה שנכנסה (מה שעל המסך) נענית ראשונה
const inflight = new Map(); // כתובת -> Promise, כדי לא לשאול פעמיים את אותה כתובת
let pumping = false;

async function ensureGeoCache() {
  if (geoCache) return;
  const { geo } = await chrome.storage.local.get("geo");
  geoCache = geo || {};
}

let saveTimer = null;
function scheduleGeoSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const keys = Object.keys(geoCache);
    if (keys.length > 4000) {
      for (const k of keys.slice(0, keys.length - 3000)) delete geoCache[k];
    }
    await chrome.storage.local.set({ geo: geoCache });
  }, 1000);
}

async function fetchGeo(q, attempt = 0) {
  const wait = GEO_MIN_GAP_MS - (Date.now() - lastGeoCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeoCall = Date.now();

  const url =
    NOMINATIM +
    "?format=jsonv2&limit=1&countrycodes=il&accept-language=he&q=" +
    encodeURIComponent(q);
  const res = await fetch(url);
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 4000));
    return fetchGeo(q, attempt + 1);
  }
  if (!res.ok) throw new Error("Nominatim HTTP " + res.status);
  const arr = await res.json();
  const hit = arr && arr[0] ? { lat: +arr[0].lat, lon: +arr[0].lon } : null;
  geoCache[q] = hit;
  scheduleGeoSave();
  return hit;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (netQueue.length) {
      const job = netQueue.pop(); // LIFO: קודם מה שהמשתמש רואה עכשיו
      try {
        job.resolve(await fetchGeo(job.q));
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    pumping = false;
  }
}

async function geocode(q) {
  await ensureGeoCache();
  if (q in geoCache) return geoCache[q]; // מהמטמון: מיידי, בלי לחכות בתור
  if (inflight.has(q)) return inflight.get(q);
  const p = new Promise((resolve, reject) => netQueue.push({ q, resolve, reject }));
  inflight.set(q, p);
  p.then(
    () => inflight.delete(q),
    () => inflight.delete(q)
  );
  pump();
  return p;
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
