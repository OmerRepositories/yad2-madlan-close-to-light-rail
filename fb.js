// Content script לפייסבוק (קבוצות ופיד): מזהה פוסטים של דירות ומציג מרחק לרכבת הקלה ומחיר למ"ר.
// הפוסטים כתובים בטקסט חופשי, ולכן הניתוח נעשה ב-parse.js (extractPriceSqmFree / parseFreeAddress).
(() => {
  const DEFAULTS = {
    maxPpsm: 0,
    belowMedianPct: 10,
    requireRail: true,
    nearM: 800,
    highlight: true,
  };
  const CFG = { ...DEFAULTS, MIN_SAMPLES: 5, ROOT_MARGIN: "600px" };

  // פוסט נחשב "מודעת דירה" רק אם יש בו סימנים של נדל"ן וגם מחיר או שטח
  const RE_PROPERTY =
    /דירה|דירת|חדרים|חד'|פנטהאוז|דופלקס|גן|מ"ר|מ'ר|\bמר\b|למכירה|להשכרה|נכס|קוטג|בית\b/;

  const entries = new Map(); // article -> entry
  let scanTimer = null;
  let refreshTimer = null;
  let pageBias = null;

  const fmtNum = (n) => Math.round(n).toLocaleString("he-IL");
  const fmtDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳");

  // ---------- הקשר מהקבוצה (שם הקבוצה לעיתים כולל עיר) ----------
  function groupContext() {
    const h1 = document.querySelector("h1");
    const sources = [h1 ? h1.textContent : "", document.title || ""];
    for (const s of sources) {
      const c = LR.findCity(s || "");
      if (c) return c;
    }
    return null;
  }

  // ---------- קריאת טקסט ----------
  function textOf(root, limit = 5000) {
    if (!root) return "";
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".lr-wrap")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue.replace(/\s+/g, " ").trim();
      out.push(v);
      len += v.length;
      if (len > limit) break;
    }
    // מחברים ברווח: בפוסט חופשי אין משמעות לשבירות שורה, ומספרים צמודים נשארים מופרדים
    return out.join(" \n ");
  }

  // ---------- זיהוי פוסטים ----------
  function messageEl(article) {
    return (
      article.querySelector('[data-ad-preview="message"]') ||
      article.querySelector('[data-ad-comet-preview="message"]') ||
      null
    );
  }

  function findPosts() {
    const list = [];
    document.querySelectorAll('[role="article"]').forEach((a) => {
      // תגובות הן article בתוך article – מדלגים עליהן
      if (a.parentElement && a.parentElement.closest('[role="article"]')) return;
      list.push(a);
    });
    return list;
  }

  function postText(article) {
    const msg = messageEl(article);
    // אם אין אלמנט הודעה מוכר, לוקחים את תחילת הפוסט (בלי התגובות שבסופו)
    return msg ? textOf(msg) : textOf(article, 1800);
  }

  // ---------- תגים ----------
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

  function createEntry(article) {
    const wrap = document.createElement("div");
    wrap.className = "lr-wrap lr-fb";
    const rail = mkBadge("lr-rail", "מרחק מהרכבת");
    const ppsm = mkBadge("lr-ppsm", "מחיר למ״ר");
    const deal = mkBadge("lr-dealtag", "");
    deal.hidden = true;
    deal._v.textContent = "⭐ שווה בדיקה";
    setBadge(rail, "loading", "ממתין…");
    setBadge(ppsm, "loading", "…");
    wrap.append(rail, ppsm, deal);
    return {
      article, wrap, rail, ppsm, deal,
      info: null, parsed: null, res: null, tried: [], tries: 0,
      started: false, priceTries: 0, lastTry: 0, delta: null, text: "", relevant: null,
    };
  }

  function place(entry) {
    if (entry.wrap.isConnected) return;
    const msg = messageEl(entry.article);
    if (msg) msg.insertAdjacentElement("afterend", entry.wrap);
    else entry.article.insertBefore(entry.wrap, entry.article.firstChild);
  }

  function renderRail(entry, res) {
    const b = entry.rail;
    entry.res = res;
    b._open = null;
    if (!res || !res.ok) {
      const err = res && res.reason === "error";
      const tried = entry.tried.length ? "ניסינו לחפש: " + entry.tried.join(" | ") : "בפוסט לא זוהתה כתובת (רחוב ועיר).";
      setBadge(b, "none", err ? "שגיאה בחישוב" : "לא זוהתה כתובת", "", (err && res.error ? res.error + "\n" : "") + tried);
      return;
    }
    const m = res.meters;
    const state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    const walk = m > 4000 ? "" : `🚶 ~${res.walkMin} דק׳ הליכה · `;
    b._open = () => {
      const url =
        "https://www.google.com/maps/dir/?api=1&travelmode=walking" +
        `&origin=${res.origin.lat},${res.origin.lon}` +
        `&destination=${res.station.lat},${res.station.lon}`;
      window.open(url, "_blank", "noopener");
    };
    setBadge(
      b, state, `${res.approx ? "≈" : ""}${fmtDistance(m)}`, `${walk}🚉 ${res.station.name}`,
      (res.approx ? "הערכה בלבד (" + res.matched + "). " : "") +
        "קו אווירי לתחנה הקרובה. לחיצה פותחת כרטיסייה בגוגל מפות עם מסלול הליכה."
    );
  }

  function startLookup(entry) {
    if (entry.started) return;
    entry.started = true;
    const { queries } = LR.parseFreeAddress(postText(entry.article), groupContext());
    if (!queries.length) {
      renderRail(entry, { ok: false, reason: "not-found" });
      scheduleRefresh();
      return;
    }
    entry.tried = queries.map((q) => q.q);
    setBadge(entry.rail, "loading", "מחשב…");
    try {
      chrome.runtime.sendMessage({ type: "lookup", queries, bias: pageBias }, (res) => {
        if (chrome.runtime.lastError) {
          renderRail(entry, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
        } else {
          if (res && res.ok && !res.approx) pageBias = res.origin;
          renderRail(entry, res);
        }
        scheduleRefresh();
      });
    } catch {
      renderRail(entry, { ok: false, reason: "error", error: "התוסף עודכן – רענן את הדף" });
    }
  }

  const io = new IntersectionObserver(
    (list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const entry = entries.get(e.target);
        if (entry && entry.relevant) startLookup(entry);
      }
    },
    { rootMargin: CFG.ROOT_MARGIN }
  );

  // ---------- חציון, מחיר למ"ר והדגשה ----------
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function refreshAll() {
    refreshTimer = null;
    const now = Date.now();

    for (const [art, entry] of entries) {
      if (!art.isConnected) {
        io.unobserve(art);
        entry.wrap.remove();
        entries.delete(art);
        continue;
      }
      if (entry.relevant) place(entry);
      if (!entry.info && entry.relevant && entry.priceTries < 6 && now - entry.lastTry > 1500) {
        entry.priceTries++;
        entry.lastTry = now;
        entry.parsed = LR.extractPriceSqmFree(postText(art));
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      }
    }

    const values = [];
    for (const e of entries.values()) if (e.relevant && e.info) values.push(e.info.ppsm);
    const med = values.length >= CFG.MIN_SAMPLES ? median(values) : null;

    for (const entry of entries.values()) {
      if (!entry.relevant) continue;
      const { info, ppsm, deal, res, parsed } = entry;
      entry.delta = null;

      if (info) {
        let sub = "";
        let state = "neutral";
        if (med) {
          entry.delta = (info.ppsm - med) / med;
          const pct = Math.round(Math.abs(entry.delta) * 100);
          if (pct >= 3) sub = `${entry.delta < 0 ? "−" : "+"}${pct}% מהחציון`;
          state = entry.delta <= -0.05 ? "good" : entry.delta >= 0.05 ? "bad" : "neutral";
        }
        if (CFG.maxPpsm > 0) state = info.ppsm <= CFG.maxPpsm ? "good" : "neutral";
        setBadge(
          ppsm, state, `₪${fmtNum(info.ppsm)}`, sub,
          `מחיר שזוהה: ₪${fmtNum(info.price)} · שטח שזוהה: ${info.sqm} מ״ר.` +
            (med
              ? ` חציון הפוסטים שנטענו בדף: ₪${fmtNum(med)} (${values.length} פוסטים).`
              : ` צריך לפחות ${CFG.MIN_SAMPLES} פוסטים עם מחיר ושטח כדי להשוות לחציון.`)
        );
      } else if (parsed && parsed.reason) {
        setBadge(
          ppsm, "none", "—", parsed.reason,
          `מחיר שזוהה: ${parsed.price ? "₪" + fmtNum(parsed.price) : "אין"} · שטח שזוהה: ${parsed.sqm ? parsed.sqm + " מ״ר" : "אין"}`
        );
      }

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
      const hasRule = CFG.requireRail || CFG.maxPpsm > 0 || CFG.belowMedianPct > 0;
      const isDeal = Boolean(CFG.highlight && hasRule && ok);
      deal.hidden = !isDeal;
      if (isDeal) deal.title = reasons.join(" · ");
      entry.wrap.classList.toggle("lr-deal-card", isDeal);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refreshAll, 300);
  }

  // ---------- סריקה ----------
  function isPropertyPost(text) {
    if (!text || text.length < 25) return false;
    if (!RE_PROPERTY.test(text)) return false;
    const p = LR.extractPriceSqmFree(text);
    return Boolean(p.price || p.sqm);
  }

  function scan() {
    scanTimer = null;
    try {
      for (const art of findPosts()) {
        let entry = entries.get(art);
        if (!entry) {
          const text = postText(art);
          if (!text) continue;
          // פוסט שעוד לא נטען במלואו ייבדק שוב בסריקה הבאה
          if (!isPropertyPost(text)) {
            const tries = (art._lrTries = (art._lrTries || 0) + 1);
            if (tries > 4) entries.set(art, { relevant: false, wrap: document.createElement("i") });
            continue;
          }
          entry = createEntry(art);
          entry.relevant = true;
          entry.text = text;
          entries.set(art, entry);
          place(entry);
          io.observe(art);
          setTimeout(scheduleRefresh, 800);
        }
      }
      scheduleRefresh();
    } catch (e) {
      console.warn("[lightrail-ext/fb] scan failed", e);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 900);
  }

  function start() {
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
  }

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
    start();
  }
})();
