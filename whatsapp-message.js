var LRWhatsAppMessage = (() => {
  function normalizeFloor(value, isFloorField = false) {
    const text = String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    const beforeLabel = text.match(/([0-9]+(?:\.\d+)?|קרקע|מרתף)\s*קומה/);
    if (beforeLabel) return `קומה ${beforeLabel[1]}`;
    const afterLabel = text.match(/קומה\s*([0-9]+(?:\.\d+)?|קרקע|מרתף)/);
    if (afterLabel) return `קומה ${afterLabel[1]}`;
    if (isFloorField && /^[0-9]+(?:\.\d+)?$/.test(text)) return `קומה ${text}`;
    return null;
  }

  function readFloor(root, selectors, overviewSelector) {
    if (!root || typeof root.querySelector !== "function") return null;
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = element && String(element.innerText || element.textContent || "").trim();
      const floor = normalizeFloor(text, Boolean(element && /floor|קומה/i.test(selector)));
      if (floor) return floor;
    }

    const overview = overviewSelector && root.querySelector(overviewSelector);
    return overview
      ? normalizeFloor(overview.innerText || overview.textContent || "")
      : null;
  }

  function format(data) {
    const value = (item) => (item === null || item === undefined || item === "" ? "לא זוהה" : item);
    return [
      `כתובת: ${value(data.address)}`,
      `מחיר: ${value(data.price)}`,
      `מ"ר: ${value(data.sqm)}`,
      `חדרים: ${value(data.rooms)}`,
      `קומה: ${value(data.floor)}`,
      `מחיר למ"ר: ${value(data.pricePerSqm)}`,
      `קרבה לרכבת משוערת: ${value(data.railDistance)}`,
    ].join("\n");
  }

  return { format, normalizeFloor, readFloor };
})();

if (typeof module !== "undefined") module.exports = LRWhatsAppMessage;
