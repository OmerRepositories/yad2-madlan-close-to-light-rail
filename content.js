// Content script: מזהה כרטיסי מודעות (ודף מודעה בודדת) ביד2 ובמדלן, ומציג:
//  - מרחק מהרכבת הקלה + דקות הליכה + שם התחנה
//  - מחיר למ"ר והשוואה לחציון
//  - הדגשה למודעות שוות
// תלוי ב-parse.js (משתנה גלובלי LR).
(() => {
  // ===== הגדרות =====
  // ברירות המחדל זהות ל-popup.js. המשתמש משנה אותן דרך חלון ההגדרות של התוסף.
  const DEFAULTS = {
    maxPpsm: 0, // מחיר מקסימלי למ"ר שנחשב "שווה" (0 = לא פעיל)
    belowMedianPct: 10, // כמה אחוזים זול מחציון הדף (0 = לא פעיל)
    requireRail: true, // לדרוש קרבה לרכבת
    nearM: 800, // מרחק מקסימלי מהרכבת במטרים
    highlight: true, // להדגיש מודעות שוות (מסגרת + תג)
    requiredAmenities: ["secureRoom"],
  };
  const CFG = {
    ...DEFAULTS,
    MIN_SAMPLES: 5, // מינימום מודעות עם מחיר למ"ר בדף כדי לחשב חציון
    ROOT_MARGIN: "700px", // מתחילים לחשב מודעות שנמצאות עד כמה פיקסלים מהמסך
  };

  const IS_YAD2 = location.hostname.includes("yad2.co.il");

  // קישורים שמזהים מודעה בודדת
  const LISTING_HREF = IS_YAD2
    ? /\/realestate\/item\//
    : /\/(listings|bulletin)\/[^/?#]+/;

  // בדף מודעה בודדת: מכאן והלאה זה "מודעות דומות", לא המודעה עצמה
  const SIMILAR_MARKERS =
    /דירות דומות|מודעות דומות|נכסים דומים|נכסים נוספים|מודעות נוספות|עוד מודעות|אולי יעניין|דירות נוספות|דירות באזור|מומלצים/;

  // ---------- מצב ----------
  const entries = new Map(); // מפתח (כרטיס / פאנל) -> entry
  let main = null; // { entry, path } – המודעה של דף מודעה בודדת
  let scanTimer = null;
  let refreshTimer = null;
  let pageBias = null; // המיקום האחרון שנמצא בדיוק, לעזרה בכתובות בלי עיר
  let storedMedian = null; // חציון מחיר למ"ר מחיפוש אחרון (לדפי מודעה בודדת)

  const io = new IntersectionObserver(
    (list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const entry = entries.get(e.target);
        if (entry) startLookup(entry);
      }
    },
    { rootMargin: CFG.ROOT_MARGIN }
  );

  // ---------- הקשר עיר מהדף ----------
  // כשהמשתמש מסנן לפי עיר, כל המודעות בה גם אם הכרטיס לא מציין עיר.
  // קודי יישוב (למ"ס) שיד2 משתמש בהם בפרמטר city בכתובת:
  const CITY_CODES = {
    5000: "תל אביב יפו", 3000: "ירושלים", 4000: "חיפה", 8300: "ראשון לציון",
    7900: "פתח תקווה", 70: "אשדוד", 7400: "נתניה", 9000: "באר שבע",
    6600: "חולון", 6100: "בני ברק", 8600: "רמת גן", 7100: "אשקלון",
    8400: "רחובות", 6200: "בת ים", 6400: "הרצליה", 6900: "כפר סבא",
    1200: "מודיעין מכבים רעות", 8700: "רעננה", 6500: "חדרה", 7000: "לוד",
    8500: "רמלה", 7200: "נס ציונה", 6300: "גבעתיים", 9700: "הוד השרון",
    2620: "קריית אונו", 2400: "אור יהודה", 9400: "יהוד מונוסון", 6700: "טבריה",
    9100: "נהריה", 7800: "פרדס חנה כרכור", 2630: "קריית גת", 1034: "מגדל העמק",
  };

  function ctxCity() {
    // 1) סגמנט בעברית בנתיב (מדלן: /for-sale/פתח-תקווה-ישראל)
    try {
      const segs = decodeURIComponent(location.pathname).split("/").filter(Boolean);
      const seg = segs.find((s) => /[֐-׿]/.test(s));
      if (seg) return seg.replace(/-ישראל$/, "").replace(/-/g, " ").trim();
    } catch {}

    // 2) פרמטרים בכתובת: city=7900 (קוד) או שם בעברית
    try {
      const sp = new URLSearchParams(location.search);
      const raw = sp.get("city") || sp.get("cityName") || sp.get("city_name");
      if (raw) {
        if (/^\d+$/.test(raw)) {
          if (CITY_CODES[Number(raw)]) return CITY_CODES[Number(raw)];
        } else if (/[֐-׿]/.test(raw)) {
          return raw.replace(/-/g, " ").trim();
        }
      }
    } catch {}

    // 3) כותרת הדף / h1: "דירות למכירה בפתח תקווה"
    const h1 = document.querySelector("h1");
    const sources = [h1 ? h1.innerText : "", document.title || ""];
    for (const t of sources) {
      const m = t.match(/(?:למכירה|להשכרה)\s+ב([^|\n,–\-]+)/);
      if (m && m[1].trim().length >= 2) return m[1].trim();
    }
    return null;
  }

  // ---------- קריאת טקסט ----------
  // innerText לא מפריד בין אלמנטים שאין ביניהם שבירת שורה, ולכן "קומה 7" ו-"95 מ״ר" נקראו
  // כ-"קומה 795 מ״ר". כאן כל צומת טקסט נקרא בנפרד, כל אחד בשורה משלו,
  // והתגים של התוסף עצמו (.lr-wrap) לא נכללים.
  function textOf(root, limit = 8000) {
    if (!root) return "";
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".lr-wrap")) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue.replace(/\s+/g, " ").trim();
      out.push(v);
      len += v.length;
      if (len > limit) break;
    }
    return out.join("\n");
  }

  // ---------- טקסט של מודעה בודדת ----------
  function mainText() {
    const h1 = document.querySelector("h1");
    const meta = (n) => {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      return el ? el.getAttribute("content") || "" : "";
    };
    const root = document.querySelector("main") || document.body;
    let body = textOf(root, 12000);
    const idx = body.slice(200).search(SIMILAR_MARKERS);
    if (idx >= 0) body = body.slice(0, 200 + idx);
    // כותרת, תיאור ו-meta נותנים לעיתים קרובות כתובת מלאה כולל עיר
    const head = [h1 ? textOf(h1) : "", document.title, meta("og:title"), meta("og:description")]
      .filter(Boolean)
      .join("\n");
    return (head + "\n" + body).slice(0, 8000);
  }

  // ---------- זיהוי כרטיסים ----------
  function findCards() {
    const byHref = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      let path;
      try {
        path = new URL(a.href, location.href).pathname;
      } catch {
        return;
      }
      if (!LISTING_HREF.test(path)) return;
      if (!byHref.has(path)) byHref.set(path, []);
      byHref.get(path).push(a);
    });

    const cards = [];
    for (const [path, anchors] of byHref) {
      let el = anchors[0];
      // עולים עד לאב הגדול ביותר שעדיין מכיל מודעה אחת בלבד
      while (el.parentElement && el.parentElement !== document.body) {
        const parent = el.parentElement;
        if ((parent.textContent || "").length > 1500) break; // לא לטפס עד כל הרשימה
        const others = new Set();
        parent.querySelectorAll("a[href]").forEach((x) => {
          try {
            const p = new URL(x.href, location.href).pathname;
            if (LISTING_HREF.test(p) && p !== path) others.add(p);
          } catch {}
        });
        if (others.size > 0) break;
        el = parent;
      }
      cards.push(el);
    }
    return cards;
  }

  // ---------- תגים ----------
  const fmtNum = (n) => Math.round(n).toLocaleString("he-IL");
  const fmtDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳");

  function mkBadge(extraClass, label) {
    const b = document.createElement("div");
    b.className = "lr-badge " + extraClass;
    const l = document.createElement("span");
    l.className = "lr-label";
    l.textContent = label;
    l.hidden = !label;
    const v = document.createElement("span");
    v.className = "lr-val";
    const s = document.createElement("span");
    s.className = "lr-sub";
    s.hidden = true;
    b.append(l, v, s);
    b._v = v;
    b._s = s;
    b._open = null;
    // כל הטיפול בקליק במקום אחד. stopPropagation כאן לא חוסם את _open,
    // כי אנחנו קוראים לו ישירות (ולא דרך onclick נפרד).
    b.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof b._open === "function") b._open();
      },
      true
    );
    return b;
  }

  function setBadge(b, state, val, sub, title) {
    b.dataset.state = state;
    b._v.textContent = val;
    b._s.textContent = sub || "";
    b._s.hidden = !sub;
    b.title = title || "";
    b.style.cursor = b._open ? "pointer" : "default";
  }

  function createEntry(card, kind) {
    const wrap = document.createElement("div");
    wrap.className = "lr-wrap" + (kind === "single" ? " lr-float" : "");

    const rail = mkBadge("lr-rail", "מרחק מהרכבת");
    const ppsm = mkBadge("lr-ppsm", "מחיר למ״ר");
    const deal = mkBadge("lr-dealtag", "");
    const amenityAlert = document.createElement("div");
    amenityAlert.className = "lr-amenity-alert";
    amenityAlert.setAttribute("role", "alert");
    amenityAlert.hidden = true;
    deal.hidden = true;
    deal._v.textContent = "⭐ שווה בדיקה";
    setBadge(rail, "loading", "ממתין…");
    setBadge(ppsm, "loading", "…");
    wrap.append(amenityAlert, rail, ppsm, deal);

    if (kind === "single") {
      document.body.appendChild(wrap);
      card = wrap;
    } else {
      card.appendChild(wrap);
    }

    return {
      kind,
      card,
      wrap,
      rail,
      ppsm,
      deal,
      amenityAlert,
      amenities: null,
      getText: kind === "single" ? mainText : () => textOf(card, 3000),
      info: null,
      parsed: null,
      res: null,
      tried: [],
      tries: 0,
      started: false,
      priceTries: 0,
      lastTry: 0,
      delta: null,
    };
  }

  function renderRail(entry, res) {
    const b = entry.rail;
    entry.res = res;
    b._open = null;

    if (!res || !res.ok) {
      const err = res && res.reason === "error";
      const tried = entry.tried.length ? "ניסינו לחפש: " + entry.tried.join(" | ") : "לא זוהתה כתובת בכרטיס.";
      setBadge(
        b,
        "none",
        err ? "שגיאה בחישוב" : "לא נמצאה כתובת",
        "",
        (err && res.error ? res.error + "\n" : "") + tried
      );
      return;
    }

    const m = res.meters;
    const state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    const walk = m > 4000 ? "" : `🚶 ~${res.walkMin} דק׳ הליכה · `;
    const sub = `${walk}🚉 ${res.station.name}`;
    const title =
      (res.approx
        ? "הערכה בלבד – לא נמצאה כתובת מדויקת (" +
          res.matched +
          "). Google Maps לא ייפתח כדי לא להציג נקודה מטעה. "
        : "") +
      (res.approx
        ? "קו אווירי משוער לתחנה הקרובה."
        : "קו אווירי לתחנה הקרובה. לחיצה תפתח כרטיסייה חדשה בגוגל מפות עם מסלול הליכה מהכתובת לתחנה.");

    if (!res.approx) {
      b._open = () => {
        const url = LRLocation.mapsDirectionsUrl(res.origin, res.station);
        window.open(url, "_blank", "noopener");
      };
    }
    setBadge(b, state, `${res.approx ? "≈" : ""}${fmtDistance(m)}`, sub, title);
  }

  // ---------- חישוב רכבת (רק למודעות שנראות / קרובות למסך) ----------
  function startLookup(entry) {
    if (entry.started) return;
    entry.started = true;
    const maxTries = entry.kind === "single" ? 5 : 3;

    const attempt = () => {
      const text = entry.getText();
      const root = entry.kind === "single" ? document : entry.card;
      const siteParser = IS_YAD2 ? LRYad2 : LRMadlan;
      const parsed = siteParser.readAddress(root, text, ctxCity(), entry.kind === "single");
      const { queries } = parsed;
      if (!queries.length && !LRLocation.validCoordinates(parsed.coordinates)) {
        // ייתכן שהכרטיס עוד לא נטען במלואו – מנסים שוב כמה פעמים
        if (++entry.tries < maxTries) return setTimeout(attempt, 1000);
        renderRail(entry, { ok: false, reason: "not-found" });
        scheduleRefresh();
        return;
      }
      entry.tried = queries.map((q) => q.q);
      setBadge(entry.rail, "loading", "מחשב…");
      try {
        const coordinates = LRLocation.validCoordinates(parsed.coordinates)
          ? parsed.coordinates
          : null;
        chrome.runtime.sendMessage({ type: "lookup", queries, bias: pageBias, coordinates }, (res) => {
          if (chrome.runtime.lastError) {
            renderRail(entry, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
          } else {
            if (res && res.ok && !res.approx) pageBias = res.origin;
            renderRail(entry, res);
          }
          scheduleRefresh();
        });
      } catch (err) {
        renderRail(entry, { ok: false, reason: "error", error: "התוסף עודכן – רענן את הדף" });
      }
    };
    attempt();
  }

  // ---------- מחיר למ"ר, חציון והדגשה ----------
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function refreshAll() {
    refreshTimer = null;
    const now = Date.now();

    // ניקוי כרטיסים שנעלמו, וניסיון חוזר לחלץ מחיר/שטח מכרטיסים שעוד נטענים
    for (const [key, entry] of entries) {
      if (!key.isConnected) {
        io.unobserve(key);
        entries.delete(key);
        continue;
      }
      if (!entry.info && entry.priceTries < 8 && now - entry.lastTry > 1500) {
        entry.priceTries++;
        entry.lastTry = now;
        const text = entry.getText();
        entry.parsed = IS_YAD2
          ? LR.extractPriceSqm(text)
          : LRMadlan.extractPriceSqm(entry.kind === "single" ? document : entry.card, text);
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      }
      const root = entry.kind === "single" ? document : entry.card;
      entry.amenities = (IS_YAD2 ? LRYad2 : LRMadlan).readAmenities(root);
      if (entry.kind === "single") {
        const missing = CFG.requiredAmenities
          .filter((amenity) => entry.amenities && entry.amenities[amenity] === false)
          .map((amenity) => AMENITY_LABELS[amenity] || amenity);
        const unknown = CFG.requiredAmenities
          .filter((amenity) => !entry.amenities || entry.amenities[amenity] === undefined)
          .map((amenity) => AMENITY_LABELS[amenity] || amenity);
        const notices = [];
        if (missing.length) notices.push(`אין בדירה: ${missing.join(", ")}`);
        if (unknown.length) notices.push(`לא ניתן לאמת: ${unknown.join(", ")}`);
        entry.amenityAlert.hidden = notices.length === 0;
        if (notices.length) {
          entry.amenityAlert.textContent = `שים לב! ${notices.join(" · ")}`;
        }
      }
    }

    // חציון מחיר למ"ר של המודעות ברשימה
    const values = [];
    for (const e of entries.values()) if (e.kind === "list" && e.info) values.push(e.info.ppsm);
    const med = values.length >= CFG.MIN_SAMPLES ? median(values) : null;

    // שומרים את החציון לשימוש בדף מודעה בודדת (רק כשנמצאים בדף רשימה)
    if (med && !main && (!storedMedian || Math.abs(storedMedian.value - med) / med > 0.01)) {
      storedMedian = { value: med, n: values.length, at: now };
      try {
        chrome.storage.local.set({ lastMedian: storedMedian });
      } catch {}
    }

    for (const entry of entries.values()) {
      const { info, ppsm, deal, res, parsed } = entry;

      // איזה חציון להשוות אליו
      let refMed = med;
      let refLabel = `חציון הדף (${values.length} מודעות)`;
      if (entry.kind === "single") {
        if (storedMedian) {
          refMed = storedMedian.value;
          refLabel = `חציון החיפוש האחרון (${storedMedian.n} מודעות)`;
        } else if (med) {
          refLabel = `חציון מודעות דומות בדף (${values.length})`;
        }
      }

      // ---- מחיר למ"ר ----
      entry.delta = null;
      if (info) {
        let sub = "";
        let state = "neutral";
        if (refMed) {
          entry.delta = (info.ppsm - refMed) / refMed;
          const pct = Math.round(Math.abs(entry.delta) * 100);
          if (pct >= 3) sub = `${entry.delta < 0 ? "−" : "+"}${pct}% מהחציון`;
          state = entry.delta <= -0.05 ? "good" : entry.delta >= 0.05 ? "bad" : "neutral";
        }
        // אם המשתמש קבע תקרת מחיר למ"ר – הצבע נקבע לפיה
        if (CFG.maxPpsm > 0) state = info.ppsm <= CFG.maxPpsm ? "good" : "neutral";

        setBadge(
          ppsm,
          state,
          `₪${fmtNum(info.ppsm)}`,
          sub,
          `מחיר ₪${fmtNum(info.price)} ÷ ${info.sqm} מ״ר.` +
            (refMed
              ? ` ${refLabel}: ₪${fmtNum(refMed)}.`
              : ` צריך לפחות ${CFG.MIN_SAMPLES} מודעות בדף כדי להשוות לחציון.`)
        );
      } else if (parsed && parsed.reason) {
        setBadge(
          ppsm,
          "none",
          "—",
          parsed.reason,
          `מחיר שזוהה: ${parsed.price ? "₪" + fmtNum(parsed.price) : "אין"} · שטח שזוהה: ${
            parsed.sqm ? parsed.sqm + " מ״ר" : "אין"
          }`
        );
      }

      // ---- הדגשת מודעה שווה: כל התנאים שהמשתמש הפעיל צריכים להתקיים ----
      const reasons = [];
      let ok = true;

      const nearRail = Boolean(res && res.ok && !res.approx && res.meters <= CFG.nearM);
      if (CFG.requireRail) {
        ok = ok && nearRail;
        if (nearRail) reasons.push(`עד ${CFG.nearM} מ׳ מהרכבת הקלה`);
      }
      if (CFG.maxPpsm > 0) {
        const pass = Boolean(info && info.ppsm <= CFG.maxPpsm);
        ok = ok && pass;
        if (pass) reasons.push(`עד ₪${fmtNum(CFG.maxPpsm)} למ״ר`);
      }
      if (CFG.belowMedianPct > 0) {
        const pass = entry.delta !== null && entry.delta <= -CFG.belowMedianPct / 100;
        ok = ok && pass;
        if (pass) reasons.push(`${Math.round(-entry.delta * 100)}% מתחת לחציון`);
      }
      for (const amenity of CFG.requiredAmenities) {
        if (!entry.amenities || entry.amenities[amenity] !== true) ok = false;
      }
      // בלי אף תנאי פעיל לא מדגישים כלום
      const hasRule =
        CFG.requireRail ||
        CFG.maxPpsm > 0 ||
        CFG.belowMedianPct > 0 ||
        CFG.requiredAmenities.length > 0;
      const isDeal = Boolean(CFG.highlight && hasRule && ok);

      deal.hidden = !isDeal;
      if (isDeal) deal.title = reasons.join(" · ");
      (entry.kind === "single" ? entry.wrap : entry.card).classList.toggle("lr-deal-card", isDeal);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refreshAll, 250);
  }

  // ---------- סריקה ----------
  function processCard(card) {
    if (entries.has(card)) return;
    const entry = createEntry(card, "list");
    entries.set(card, entry);
    io.observe(card);
    setTimeout(scheduleRefresh, 1500); // לתפוס כרטיסים שנטענים בהדרגה
  }

  // דף מודעה בודדת: פאנל צף עם אותם נתונים
  function ensureMain() {
    const isItem = LISTING_HREF.test(location.pathname);
    if (main && (!isItem || main.path !== location.pathname)) {
      main.entry.wrap.remove();
      entries.delete(main.entry.card);
      main = null;
    }
    if (!isItem || main) return;
    if (!document.querySelector("h1") && (document.body.innerText || "").length < 300) return; // עוד לא נטען

    const entry = createEntry(null, "single");
    entries.set(entry.card, entry);
    main = { entry, path: location.pathname };
    setTimeout(() => startLookup(entry), 800);
    setTimeout(scheduleRefresh, 1200);
  }

  function scan() {
    scanTimer = null;
    try {
      ensureMain();
      findCards().forEach(processCard);
      scheduleRefresh();
    } catch (e) {
      console.warn("[lightrail-ext] scan failed", e);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 600);
  }

  function start() {
    new MutationObserver(scheduleScan).observe(document.body, {
      childList: true,
      subtree: true,
    });
    scan();
  }

  // טוענים את ההגדרות לפני שמתחילים, ומעדכנים את הדף מיד כשהמשתמש משנה הגדרה
  const NUM_KEYS = ["maxPpsm", "belowMedianPct", "nearM"];
  const AMENITY_LABELS = {
    parking: "חניה",
    secureRoom: "ממ״ד",
    elevator: "מעלית",
    storage: "מחסן",
    airConditioner: "מיזוג אוויר",
    accessible: "נגיש לנכים",
    balcony: "מרפסת",
    sunBoiler: "דוד שמש",
    grating: "סורגים",
    garden: "גינה",
    pool: "בריכה",
  };
  function applySettings(s) {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      if (k === "requiredAmenities") {
        CFG[k] = Array.isArray(s[k])
          ? s[k].filter((amenity) => Object.prototype.hasOwnProperty.call(AMENITY_LABELS, amenity))
          : [...DEFAULTS.requiredAmenities];
      } else {
        CFG[k] = NUM_KEYS.includes(k) ? Math.max(0, Number(s[k]) || 0) : Boolean(s[k]);
      }
    }
  }

  try {
    chrome.storage.local.get("lastMedian", (r) => {
      const m = r && r.lastMedian;
      if (m && Date.now() - m.at < 14 * 24 * 3600 * 1000) storedMedian = m;
    });
    chrome.storage.sync.get(DEFAULTS, (s) => {
      applySettings(s || {});
      start();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const next = {};
      for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
      applySettings(next);
      scheduleRefresh();
    });
  } catch {
    start(); // אם האחסון לא זמין, ממשיכים עם ברירות המחדל
  }
})();
