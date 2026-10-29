// Content script: מזהה כרטיסי מודעות ביד2 ובמדלן ומציג מרחק לרכבת הקלה, מחיר למ"ר והדגשה למודעות שוות.
(() => {
  // ===== הגדרות =====
  // ברירות המחדל זהות ל-popup.js. המשתמש משנה אותן דרך חלון ההגדרות של התוסף.
  const DEFAULTS = {
    maxPpsm: 0, // מחיר מקסימלי למ"ר שנחשב "שווה" (0 = לא פעיל)
    belowMedianPct: 10, // כמה אחוזים זול מחציון הדף (0 = לא פעיל)
    requireRail: true, // לדרוש קרבה לרכבת
    nearM: 800, // מרחק מקסימלי מהרכבת במטרים
    highlight: true, // להדגיש מודעות שוות (מסגרת + תג)
  };
  const CFG = {
    ...DEFAULTS,
    MIN_SAMPLES: 5, // מינימום מודעות עם מחיר למ"ר בדף כדי לחשב חציון
    ROOT_MARGIN: "700px", // מתחילים לחשב מודעות שנמצאות עד כמה פיקסלים מהמסך
  };

  const HOST = location.hostname;
  const IS_YAD2 = HOST.includes("yad2.co.il");

  // קישורים שמזהים מודעה בודדת
  const LISTING_HREF = IS_YAD2
    ? /\/realestate\/item\//
    : /\/(listings|bulletin)\/[^/?#]+/;

  // מילים שמתארות סוג נכס ולא מקום
  const TYPE_WORDS =
    /^(דירה|דירת גן|דירת גג|גג\/פנטהאוז|פנטהאוז|דופלקס|טריפלקס|בית פרטי|בית|וילה|קוטג'?|מגרש|יחידת דיור|סטודיו|לופט|משק|נחלה|דירת סטודיו|דו משפחתי|חד משפחתי|בניין|מבנה)(\s|$)/;
  const NOISE_LINE =
    /₪|^\d+(\.\d+)?$|חדרים|חד['׳]|מ["״']ר|קומה|ממתין|חדש|מתווך|תיווך|פרטי$|קבלן|כניסה|עודכן|לפני|פרסם|מבצע|ללא עמלה|מציג|מחיר|טלפון|שמור|מועדפים/;

  // ---------- מצב ----------
  const entries = new Map(); // card -> entry
  let scanTimer = null;
  let refreshTimer = null;

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

  // ---------- חילוץ כתובת ----------
  function extractQueries(card) {
    const lines = (card.innerText || "")
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s && s.length < 90 && /[֐-׿]/.test(s) && !NOISE_LINE.test(s));

    let city = null;
    let hood = null;
    let street = null;

    // שורה בפורמט "סוג נכס, שכונה, עיר" (או "רחוב 5, עיר")
    for (const line of lines) {
      if (!line.includes(",")) continue;
      const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
      const hasDigitFirst = /\d/.test(parts[0]);
      const places = parts.filter((p) => !TYPE_WORDS.test(p));
      if (!places.length) continue;
      if (hasDigitFirst || (!TYPE_WORDS.test(parts[0]) && /\d/.test(parts[0]))) {
        street = street || parts[0];
        const rest = places.slice(1);
        if (rest.length) city = city || rest[rest.length - 1];
        if (rest.length > 1) hood = hood || rest[0];
      } else {
        city = city || places[places.length - 1];
        if (places.length > 1) hood = hood || places[0];
      }
      if (city) break;
    }

    // שורת רחוב ללא פסיקים (למשל "דיזנגוף 10")
    if (!street) {
      street =
        lines.find((l) => !l.includes(",") && /\d/.test(l) && l.length >= 4 && !TYPE_WORDS.test(l)) ||
        null;
    }
    if (!city) {
      const l = lines.find((x) => x.includes(","));
      if (l) city = l.split(",").pop().trim();
    }

    const queries = [];
    const clean = (s) => s.replace(/^רחוב\s+/, "").trim();
    if (street && city) queries.push(`${clean(street)}, ${city}, ישראל`);
    if (street && !city) queries.push(`${clean(street)}, ישראל`);
    if (hood && city) queries.push(`${hood}, ${city}, ישראל`);
    if (!street && city && !hood) queries.push(`${city}, ישראל`);
    return queries;
  }

  // ---------- חילוץ מחיר ושטח ----------
  function extractPriceSqm(card) {
    const text = card.innerText || "";
    const toNum = (s) => Number(String(s).replace(/[^\d.]/g, ""));

    let price = null;
    const pm = text.match(/₪\s*([\d,]{5,})/) || text.match(/([\d,]{5,})\s*₪/);
    if (pm) price = toNum(pm[1]);

    let sqm = null;
    const sm = text.match(/(\d{2,4}(?:\.\d+)?)\s*מ["״”'׳]?ר(?![א-ת])/);
    if (sm) sqm = toNum(sm[1]);

    // מחיר למכירה בלבד (ולא שכירות), ושטח סביר
    if (price && sqm && price >= 100000 && sqm >= 15 && sqm <= 1000) {
      return { price, sqm, ppsm: Math.round(price / sqm) };
    }
    return null;
  }

  // ---------- תגים ----------
  const fmtNum = (n) => Math.round(n).toLocaleString("he-IL");
  const fmtDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳");

  function makeBadge(extraClass) {
    const b = document.createElement("div");
    b.className = "lr-badge" + (extraClass ? " " + extraClass : "");
    // שלא ינווט למודעה בלחיצה על התג
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, true);
    return b;
  }

  function createEntry(card) {
    const wrap = document.createElement("div");
    wrap.className = "lr-wrap";
    const rail = makeBadge();
    rail.dataset.state = "loading";
    rail.textContent = "🚆 ממתין לחישוב…";
    const ppsm = makeBadge("lr-ppsm");
    ppsm.hidden = true;
    const deal = makeBadge("lr-dealtag");
    deal.hidden = true;
    deal.textContent = "⭐ שווה בדיקה";
    wrap.append(rail, ppsm, deal);
    card.appendChild(wrap);
    return { card, rail, ppsm, deal, info: null, res: null, tries: 0, started: false };
  }

  function renderRail(entry, res) {
    const badge = entry.rail;
    entry.res = res;
    if (!res || !res.ok) {
      badge.dataset.state = "none";
      badge.textContent =
        res && res.reason === "error" ? "🚆 שגיאה בחישוב" : "🚆 לא נמצאה כתובת לחישוב";
      badge.title = res && res.error ? res.error : "";
      badge.onclick = null;
      return;
    }
    const m = res.meters;
    badge.dataset.state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    badge.textContent = "";

    const main = document.createElement("span");
    main.textContent = `🚆 ${res.approx ? "≈" : ""}${fmtDistance(m)}`;
    const sub = document.createElement("span");
    sub.className = "lr-sub";
    sub.textContent =
      m > 4000 ? `· ${res.station.name}` : `· ~${res.walkMin} דק׳ הליכה · ${res.station.name}`;
    badge.append(main, sub);

    badge.title =
      (res.approx ? "הערכה לפי שכונה/עיר (לא נמצאה כתובת מדויקת). " : "") +
      "קו אווירי לתחנה הקרובה. לחיצה תפתח מסלול הליכה בגוגל מפות.";

    badge.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url =
        "https://www.google.com/maps/dir/?api=1&travelmode=walking" +
        `&origin=${res.origin.lat},${res.origin.lon}` +
        `&destination=${res.station.lat},${res.station.lon}`;
      window.open(url, "_blank", "noopener");
    };
  }

  // ---------- חישוב רכבת (רק למודעות שנראות / קרובות למסך) ----------
  function startLookup(entry) {
    if (entry.started) return;
    entry.started = true;

    const attempt = () => {
      const queries = extractQueries(entry.card);
      if (!queries.length) {
        // ייתכן שהכרטיס עוד לא נטען במלואו – מנסים שוב כמה פעמים
        if (++entry.tries < 3) return setTimeout(attempt, 1000);
        renderRail(entry, { ok: false, reason: "not-found" });
        scheduleRefresh();
        return;
      }
      entry.rail.textContent = "🚆 מחשב מרחק לרכבת…";
      chrome.runtime.sendMessage({ type: "lookup", queries }, (res) => {
        if (chrome.runtime.lastError) {
          renderRail(entry, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
        } else {
          renderRail(entry, res);
        }
        scheduleRefresh();
      });
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

    // ניקוי כרטיסים שנעלמו מהדף
    for (const [card, entry] of entries) {
      if (!card.isConnected) {
        io.unobserve(card);
        entries.delete(card);
      } else if (!entry.info && entry.priceTries < 5) {
        entry.priceTries++;
        entry.info = extractPriceSqm(card);
      }
    }

    const values = [];
    for (const entry of entries.values()) if (entry.info) values.push(entry.info.ppsm);
    const enough = values.length >= CFG.MIN_SAMPLES;
    const med = enough ? median(values) : null;

    for (const entry of entries.values()) {
      const { info, ppsm, deal, card, res } = entry;

      // מחיר למ"ר
      if (info) {
        ppsm.hidden = false;
        let text = `💰 ₪${fmtNum(info.ppsm)} למ״ר`;
        let state = "neutral";
        let delta = null;
        if (med) {
          delta = (info.ppsm - med) / med;
          const pct = Math.round(Math.abs(delta) * 100);
          if (pct >= 3) text += ` · ${delta < 0 ? "−" : "+"}${pct}% מהחציון`;
          state = delta <= -0.05 ? "good" : delta >= 0.05 ? "bad" : "neutral";
        }
        // אם המשתמש קבע תקרת מחיר למ"ר – הצבע נקבע לפיה
        if (CFG.maxPpsm > 0) state = info.ppsm <= CFG.maxPpsm ? "good" : "neutral";
        ppsm.textContent = text;
        ppsm.dataset.state = state;
        ppsm.title =
          `מחיר ₪${fmtNum(info.price)} ÷ ${info.sqm} מ״ר.` +
          (med
            ? ` חציון מחיר למ״ר בדף: ₪${fmtNum(med)} (מתוך ${values.length} מודעות).`
            : ` צריך לפחות ${CFG.MIN_SAMPLES} מודעות בדף כדי להשוות לחציון.`);
        entry.delta = delta;
      } else {
        ppsm.hidden = true;
        entry.delta = null;
      }

      // הדגשת מודעה שווה: כל התנאים שהמשתמש הפעיל צריכים להתקיים
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
        if (pass) reasons.push(`${Math.round(-entry.delta * 100)}% מתחת לחציון הדף`);
      }
      // בלי אף תנאי פעיל לא מדגישים כלום
      const hasRule = CFG.requireRail || CFG.maxPpsm > 0 || CFG.belowMedianPct > 0;
      const isDeal = Boolean(CFG.highlight && hasRule && ok);

      deal.hidden = !isDeal;
      if (isDeal) deal.title = reasons.join(" · ");
      card.classList.toggle("lr-deal-card", isDeal);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refreshAll, 250);
  }

  // ---------- סריקה ----------
  function processCard(card) {
    if (entries.has(card)) return;
    const entry = createEntry(card);
    entry.priceTries = 0;
    entry.info = extractPriceSqm(card);
    entries.set(card, entry);
    io.observe(card);
    setTimeout(scheduleRefresh, 1500); // לתפוס כרטיסים שנטענים בהדרגה
  }

  function scan() {
    scanTimer = null;
    try {
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
  function applySettings(s) {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      CFG[k] = NUM_KEYS.includes(k) ? Math.max(0, Number(s[k]) || 0) : Boolean(s[k]);
    }
  }

  try {
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
