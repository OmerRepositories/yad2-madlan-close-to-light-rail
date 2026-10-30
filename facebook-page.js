// Scope Facebook listing analysis to a group's main feed, not profiles, pages, or individual posts.
(() => {
  const isGroupFeed = (pathname) => /^\/groups\/[^/]+\/?$/.test(String(pathname || ""));
  globalThis.LRFacebookPage = { isGroupFeed };
  if (typeof module !== "undefined") module.exports = { isGroupFeed };
})();
