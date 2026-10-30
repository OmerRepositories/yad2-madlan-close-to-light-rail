(() => {
  const posts = new Map();
  const articleKeys = new WeakMap();
  const seenArticles = new WeakSet();
  let nextFallbackId = 1;
  let scanTimer = null;

  function topLevelArticles() {
    return [...document.querySelectorAll('[role="article"]')].filter(
      (article) => !article.parentElement?.closest('[role="article"]')
    );
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function textForArticle(article) {
    const message = article.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"]'
    );
    if (message) {
      const text = normalizeText(message.innerText || message.textContent);
      if (text) return text;
    }

    const clone = article.cloneNode(true);
    clone.querySelectorAll(
      '[role="article"], button, [role="button"], time, script, style, svg'
    ).forEach((element) => element.remove());
    return normalizeText(clone.innerText || clone.textContent);
  }

  function postUrlForArticle(article) {
    for (const link of article.querySelectorAll("a[href]")) {
      try {
        const url = new URL(link.href, location.href);
        const isPostLink =
          /\/(?:posts|permalink|photo|videos)\//.test(url.pathname) ||
          (url.pathname.includes("/groups/") &&
            (url.searchParams.has("story_fbid") || url.searchParams.has("multi_permalinks")));
        if (!isPostLink) continue;

        const normalized = new URL(url.origin + url.pathname);
        for (const key of ["story_fbid", "id", "multi_permalinks"]) {
          if (url.searchParams.has(key)) normalized.searchParams.set(key, url.searchParams.get(key));
        }
        return normalized.href;
      } catch {
        continue;
      }
    }
    return "";
  }

  function keyForArticle(article, text, url) {
    if (url) return url;
    let key = articleKeys.get(article);
    if (!key) {
      key = `local-post-${nextFallbackId++}`;
      articleKeys.set(article, key);
    }
    return key;
  }

  function hasEnteredViewport(article) {
    const bounds = article.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.top < window.innerHeight;
  }

  function capture(article) {
    const text = textForArticle(article);
    if (text.length < 2) return;
    const url = postUrlForArticle(article);
    const key = keyForArticle(article, text, url);
    const existing = posts.get(key);
    if (existing) {
      existing.text = text;
      existing.url = url || existing.url;
      return;
    }
    posts.set(key, { text, url, capturedAt: new Date().toISOString() });
  }

  function scan() {
    scanTimer = null;
    for (const article of topLevelArticles()) {
      if (seenArticles.has(article)) {
        capture(article);
      } else if (hasEnteredViewport(article)) {
        seenArticles.add(article);
        capture(article);
      }
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(scan, 150);
  }

  window.addEventListener("scroll", scheduleScan, { passive: true });
  window.addEventListener("resize", scheduleScan, { passive: true });
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scan();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "getCollectedPosts") {
      scan();
      sendResponse({ posts: [...posts.values()] });
      return false;
    }
    return false;
  });
})();
