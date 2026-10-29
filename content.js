// Content script: מזהה כרטיסי מודעות ביד2 ובמדלן, מחלץ כתובת ומציג תג מרחק לרכבת הקלה.
(() => {
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

  const done = new WeakSet();
  let scanTimer = null;

  // ---------- זיהוי כרטיסים ----------
  function findCards() {
    const byHref = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      let path;
      try {
        const u = new URL(a.href, location.href);
        path = u.pathname;
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
      // מוצאים עיר אפשרית מכל שורה עם פסיק שהיא לא סוג נכס
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

  // ---------- תג ----------
  function makeBadge() {
    const b = document.createElement("div");
    b.className = "lr-badge";
    b.dataset.state = "loading";
    b.textContent = "🚆 מחשב מרחק לרכבת…";
    // שלא ינווט למודעה בלחיצה על התג
    b.addEventListener("click", (e) => e.stopPropagation(), true);
    return b;
  }

  function fmtDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳";
  }

  function render(badge, res) {
    if (!res || !res.ok) {
      badge.dataset.state = "none";
      badge.textContent =
        res && res.reason === "error"
          ? "🚆 שגיאה בחישוב"
          : "🚆 לא נמצאה כתובת לחישוב";
      badge.title = res && res.error ? res.error : "";
      return;
    }
    const m = res.meters;
    const state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    badge.dataset.state = state;
    badge.textContent = "";

    const main = document.createElement("span");
    main.textContent = `🚆 ${res.approx ? "≈" : ""}${fmtDistance(m)}`;
    const sub = document.createElement("span");
    sub.className = "lr-sub";
    sub.textContent =
      m > 4000
        ? `· ${res.station.name}`
        : `· ~${res.walkMin} דק׳ הליכה · ${res.station.name}`;
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

  function processCard(card) {
    if (done.has(card)) return;
    done.add(card);

    const queries = extractQueries(card);
    const badge = makeBadge();
    card.appendChild(badge);

    if (!queries.length) {
      render(badge, { ok: false, reason: "not-found" });
      return;
    }
    chrome.runtime.sendMessage({ type: "lookup", queries }, (res) => {
      if (chrome.runtime.lastError) {
        render(badge, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
        return;
      }
      render(badge, res);
    });
  }

  function scan() {
    scanTimer = null;
    try {
      findCards().forEach(processCard);
    } catch (e) {
      console.warn("[lightrail-ext] scan failed", e);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 600);
  }

  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
  });
  scan();
})();
