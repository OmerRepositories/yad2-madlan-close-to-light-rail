var LRWhatsAppMessage = (() => {
  function normalizeFloor(value, isFloorField = false) {
    const text = String(value || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    const afterLabel = text.match(/קומה\s*([0-9]+(?:\.\d+)?|קרקע|מרתף)/);
    if (afterLabel) return `קומה ${afterLabel[1]}`;
    const beforeLabel = text.match(/([0-9]+(?:\.\d+)?|קרקע|מרתף)\s*קומה/);
    if (beforeLabel) return `קומה ${beforeLabel[1]}`;
    if (isFloorField && /^[0-9]+(?:\.\d+)?$/.test(text)) return `קומה ${text}`;
    return null;
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

  return { format, normalizeFloor };
})();

if (typeof module !== "undefined") module.exports = LRWhatsAppMessage;
