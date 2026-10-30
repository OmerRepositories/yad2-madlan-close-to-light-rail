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
    avoidBrokerage: false,
    removeBrokerage: false,
    removeProjects: false,
    requiredAmenities: ["secureRoom"],
  };
  const CFG = {
    ...DEFAULTS,
    MIN_SAMPLES: 5, // מינימום מודעות עם מחיר למ"ר בדף כדי לחשב חציון
    ROOT_MARGIN: "700px", // מתחילים לחשב מודעות שנמצאות עד כמה פיקסלים מהמסך
  };

  const LISTING_CACHE_KEY = "yad2AmenityCache_v1";
  const LISTING_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
  const LISTING_CACHE_MAX_ITEMS = 2500;
  const IS_YAD2 = location.hostname.includes("yad2.co.il");
  let listingCache = {};
  let cacheSaveTimer = null;
  const cacheWriteSuppressedIds = new Set();

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
  let removeBrokerageForPage = false;
  let removeProjectsForPage = false;
  let brokerageFilterBar = null;
  const projectCards = new Set();

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

  function highlightBrokerage(root, enabled) {
    if (!root) return;
    const existing = root.querySelectorAll(".lr-brokerage-highlight, .lr-brokerage-positive");
    if (!enabled) {
      existing.forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            ".lr-wrap, .lr-brokerage-highlight, .lr-brokerage-positive, script, style, noscript, textarea"
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return (
          /תיווך|נדל(?:[״"'׳]?ן)/.test(node.nodeValue) ||
          Boolean(parent.closest('[data-testid="ad-card-above-price"]'))
        )
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const brokerageTerms =
      /((?:ללא|בלי|לא)(?:\s+(?:(?:צורך\s+)?(?:ב|דרך|באמצעות)))?\s*תיווך)|תיווך|נדל(?:[״"'׳]?ן)/g;
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      const text = node.nodeValue;
      if (node.parentElement.closest('[data-testid="ad-card-above-price"]')) {
        const mark = document.createElement("span");
        mark.className = "lr-brokerage-highlight";
        mark.textContent = text;
        node.replaceWith(mark);
        continue;
      }
      let cursor = 0;
      for (const match of text.matchAll(brokerageTerms)) {
        const index = match.index;
        if (index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        const mark = document.createElement("span");
        mark.className = match[1] ? "lr-brokerage-positive" : "lr-brokerage-highlight";
        mark.textContent = match[0];
        fragment.appendChild(mark);
        cursor = index + match[0].length;
      }
      if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
      node.replaceWith(fragment);
    }
  }

  function hasBrokerageSignal(root) {
    if (!root) return false;
    const agentLabel = root.querySelector('[data-testid="ad-card-above-price"]');
    if (agentLabel && agentLabel.textContent.trim()) return true;

    const text = textOf(root, 6000)
      .replace(/\s+/g, " ")
      .replace(/(?:ללא|בלי|לא)(?:\s+(?:(?:צורך\s+)?(?:ב|דרך|באמצעות)))?\s*תיווך/g, "");
    return /תיווך|נדל(?:[״"'׳]?ן)/.test(text);
  }

  function filterBrokerageEntry(entry) {
    if (entry.kind !== "list") return false;
    const shouldRemove =
      (CFG.removeBrokerage || removeBrokerageForPage) && hasBrokerageSignal(entry.card);
    entry.card.classList.toggle("lr-brokerage-removed", shouldRemove);
    entry.brokerageRemoved = shouldRemove;
    return shouldRemove;
  }

  function updateBrokerageFilterStatus() {
    if (!brokerageFilterBar) return;
    const count = [...entries.values()].filter((entry) => entry.brokerageRemoved).length;
    const status = brokerageFilterBar.querySelector(".lr-brokerage-filter-status");
    status.textContent = count
      ? `הוסרו ${count} מודעות תיווך בעמוד`
      : removeBrokerageForPage || CFG.removeBrokerage
        ? "לא נמצאו מודעות תיווך"
        : "";
    brokerageFilterBar.dataset.active = String(removeBrokerageForPage || CFG.removeBrokerage);

    const projectCount = [...projectCards].filter((card) =>
      card.classList.contains("lr-project-removed")
    ).length;
    const projectStatus = brokerageFilterBar.querySelector(".lr-project-filter-status");
    projectStatus.textContent = projectCount
      ? `הוסרו ${projectCount} פרויקטים בעמוד`
      : removeProjectsForPage || CFG.removeProjects
        ? "לא נמצאו פרויקטים"
        : "";
  }

  function isProjectPath(path) {
    return /\/(?:yad1\/project|projects?)\//i.test(path);
  }

  function findProjectCards() {
    const byHref = new Map();
    document.querySelectorAll("a[href]").forEach((anchor) => {
      let path;
      try {
        path = new URL(anchor.href, location.href).pathname;
      } catch {
        return;
      }
      if (!isProjectPath(path)) return;
      if (!byHref.has(path)) byHref.set(path, anchor);
    });

    const cards = new Set();
    for (const [path, anchor] of byHref) {
      let card = anchor;
      while (card.parentElement && card.parentElement !== document.body) {
        const parent = card.parentElement;
        if ((parent.textContent || "").length > 2500) break;
        const otherProjects = [...parent.querySelectorAll("a[href]")].some((link) => {
          try {
            const linkPath = new URL(link.href, location.href).pathname;
            return linkPath !== path && isProjectPath(linkPath);
          } catch {
            return false;
          }
        });
        if (otherProjects) break;
        card = parent;
      }
      cards.add(card);
    }
    return cards;
  }

  function processProjectCards() {
    for (const card of projectCards) {
      if (!card.isConnected) projectCards.delete(card);
    }
    for (const card of findProjectCards()) projectCards.add(card);
    const shouldRemove = CFG.removeProjects || removeProjectsForPage;
    for (const card of projectCards) {
      card.classList.toggle("lr-project-removed", shouldRemove);
    }
    updateBrokerageFilterStatus();
  }

  function createBrokerageFilterBar() {
    if (brokerageFilterBar || LISTING_HREF.test(location.pathname)) return;
    brokerageFilterBar = document.createElement("div");
    brokerageFilterBar.id = "lr-brokerage-filter";
    const brokerageButton = document.createElement("button");
    brokerageButton.type = "button";
    brokerageButton.textContent = "הסר מודעות תיווך בעמוד זה";
    brokerageButton.addEventListener("click", () => {
      removeBrokerageForPage = true;
      findCards().forEach(processCard);
      for (const entry of entries.values()) filterBrokerageEntry(entry);
      updateBrokerageFilterStatus();
    });
    const brokerageStatus = document.createElement("span");
    brokerageStatus.className = "lr-brokerage-filter-status";
    brokerageStatus.setAttribute("aria-live", "polite");
    const projectButton = document.createElement("button");
    projectButton.type = "button";
    projectButton.textContent = "הסר פרויקטים בעמוד זה";
    projectButton.addEventListener("click", () => {
      removeProjectsForPage = true;
      processProjectCards();
    });
    const projectStatus = document.createElement("span");
    projectStatus.className = "lr-project-filter-status";
    projectStatus.setAttribute("aria-live", "polite");
    brokerageFilterBar.append(brokerageButton, brokerageStatus, projectButton, projectStatus);
    document.body.prepend(brokerageFilterBar);
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
    const cacheNote = document.createElement("div");
    amenityAlert.className = "lr-amenity-alert";
    cacheNote.className = "lr-cache-note";
    amenityAlert.setAttribute("role", "alert");
    amenityAlert.hidden = true;
    cacheNote.hidden = true;
    deal.hidden = true;
    deal._v.textContent = "⭐ שווה בדיקה";
    setBadge(rail, "loading", "ממתין…");
    setBadge(ppsm, "loading", "…");
    wrap.append(amenityAlert, cacheNote, rail, ppsm, deal);

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
      cacheNote,
      brokerageRemoved: false,
      amenities: null,
      listingId: null,
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

  function cacheKeyForListing(id) {
    return `${IS_YAD2 ? "yad2" : "madlan"}:${id}`;
  }

  function validCachedAmenities(record, now = Date.now()) {
    return (
      record &&
      record.amenities &&
      Number.isFinite(record.updatedAt) &&
      now - record.updatedAt < LISTING_CACHE_TTL_MS &&
      Object.values(record.amenities).some((value) => typeof value === "boolean")
    );
  }

  function trimListingCache(cache, now = Date.now()) {
    const fresh = Object.entries(cache || {}).filter(([, record]) =>
      validCachedAmenities(record, now)
    );
    fresh.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    return Object.fromEntries(fresh.slice(0, LISTING_CACHE_MAX_ITEMS));
  }

  function saveListingCache() {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      listingCache = trimListingCache(listingCache);
      chrome.storage.local.set({ [LISTING_CACHE_KEY]: listingCache }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[lightrail-ext] failed to save listing cache", chrome.runtime.lastError.message);
        }
      });
    }, 500);
  }

  function rememberListingAmenities(id, amenities) {
    const key = id ? cacheKeyForListing(id) : null;
    if (
      !id ||
      cacheWriteSuppressedIds.has(key) ||
      !amenities ||
      !Object.values(amenities).every((value) => typeof value === "boolean")
    ) {
      return;
    }
    const existing = listingCache[key];
    if (
      existing &&
      Object.keys(amenities).every((amenity) => existing.amenities[amenity] === amenities[amenity]) &&
      Object.keys(existing.amenities).length === Object.keys(amenities).length
    ) {
      if (Date.now() - existing.updatedAt >= 24 * 60 * 60 * 1000) {
        listingCache[key] = { ...existing, updatedAt: Date.now() };
        saveListingCache();
      }
      return;
    }
    listingCache[key] = { amenities, updatedAt: Date.now() };
    saveListingCache();
  }

  function renderCachedAmenities(entry) {
    if (entry.kind !== "list" || !entry.cacheNote) return;
    const record = entry.listingId ? listingCache[cacheKeyForListing(entry.listingId)] : null;
    if (!validCachedAmenities(record) || CFG.requiredAmenities.length === 0) {
      if (!entry.cacheNote.hidden) entry.cacheNote.hidden = true;
      entry.card.classList.remove("lr-cache-missing");
      return;
    }
    const missing = CFG.requiredAmenities
      .filter((amenity) => record.amenities[amenity] !== true)
      .map((amenity) => AMENITY_LABELS[amenity] || amenity);
    const state = missing.length ? "missing" : "matches";
    const text = missing.length
      ? `נבדקה בעבר · חסר: ${missing.join(", ")}`
      : "נבדקה בעבר · דרישות החובה קיימות";
    const signature = `${record.updatedAt}|${state}|${text}`;
    if (entry.cacheNote.dataset.signature !== signature) {
      entry.cacheNote.dataset.signature = signature;
      entry.cacheNote.dataset.state = state;
      entry.cacheNote.textContent = text;
      entry.cacheNote.title = `המאפיינים נבדקו בתאריך ${new Date(record.updatedAt).toLocaleDateString("he-IL")}`;
    }
    if (entry.cacheNote.hidden) entry.cacheNote.hidden = false;
    entry.card.classList.toggle("lr-cache-missing", missing.length > 0);
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
      entry.listingId = (IS_YAD2 ? LRYad2 : LRMadlan).listingId(root);
      const currentAmenities = (IS_YAD2 ? LRYad2 : LRMadlan).readAmenities(root);
      if (entry.kind === "single" && currentAmenities) {
        entry.amenities = currentAmenities;
        rememberListingAmenities(entry.listingId, currentAmenities);
      } else {
        const cached = entry.listingId ? listingCache[cacheKeyForListing(entry.listingId)] : null;
        entry.amenities = validCachedAmenities(cached) ? cached.amenities : currentAmenities;
      }
      renderCachedAmenities(entry);
      filterBrokerageEntry(entry);
      const listingRoot =
        entry.kind === "single"
          ? document.querySelector("main") || document.body
          : entry.card;
      highlightBrokerage(listingRoot, CFG.avoidBrokerage);
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
        const notice = notices.length ? `שים לב! ${notices.join(" · ")}` : "";
        if (entry.amenityAlert.hidden !== !notice) entry.amenityAlert.hidden = !notice;
        if (notices.length) {
          if (entry.amenityAlert.textContent !== notice) entry.amenityAlert.textContent = notice;
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
    updateBrokerageFilterStatus();
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
      processProjectCards();
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
    createBrokerageFilterBar();
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
    chrome.storage.local.get(["lastMedian", LISTING_CACHE_KEY], (r) => {
      const m = r && r.lastMedian;
      if (m && Date.now() - m.at < 14 * 24 * 3600 * 1000) storedMedian = m;
      if (chrome.runtime.lastError) {
        console.warn("[lightrail-ext] failed to load listing cache", chrome.runtime.lastError.message);
      } else {
        const storedCache = (r && r[LISTING_CACHE_KEY]) || {};
        listingCache = trimListingCache(storedCache);
        if (Object.keys(listingCache).length !== Object.keys(storedCache).length) {
          saveListingCache();
        }
        scheduleRefresh();
      }
    });
    chrome.storage.sync.get(DEFAULTS, (s) => {
      applySettings(s || {});
      start();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[LISTING_CACHE_KEY]) {
        if (!changes[LISTING_CACHE_KEY].newValue) {
          for (const entry of entries.values()) {
            if (entry.listingId) cacheWriteSuppressedIds.add(cacheKeyForListing(entry.listingId));
          }
          if (main && !main.entry.listingId) {
            const id = (IS_YAD2 ? LRYad2 : LRMadlan).listingId(document);
            if (id) cacheWriteSuppressedIds.add(cacheKeyForListing(id));
          }
        }
        listingCache = trimListingCache(changes[LISTING_CACHE_KEY].newValue);
        scheduleRefresh();
        return;
      }
      if (area !== "sync") return;
      const next = {};
      for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
      applySettings(next);
      processProjectCards();
      scheduleRefresh();
    });
  } catch {
    start(); // אם האחסון לא זמין, ממשיכים עם ברירות המחדל
  }
})();
