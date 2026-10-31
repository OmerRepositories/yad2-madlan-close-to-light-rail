const assert = require("node:assert/strict");
const test = require("node:test");

const LRWhatsAppMessage = require("../whatsapp-message.js");

test("WhatsApp message lists all requested property fields in Hebrew", () => {
  const message = LRWhatsAppMessage.format({
    address: "קלישר 10, פתח תקווה",
    price: "₪2,200,000",
    sqm: 87,
    rooms: 4,
    floor: "קומה 4",
    pricePerSqm: "₪25,287",
    railDistance: "כ-450 מ׳ (משוער)",
  });

  assert.equal(
    message,
    [
      "כתובת: קלישר 10, פתח תקווה",
      "מחיר: ₪2,200,000",
      'מ"ר: 87',
      "חדרים: 4",
      "קומה: קומה 4",
      'מחיר למ"ר: ₪25,287',
      "קרבה לרכבת משוערת: כ-450 מ׳ (משוער)",
    ].join("\n")
  );
});

test("WhatsApp message clearly marks unavailable listing fields", () => {
  const message = LRWhatsAppMessage.format({});
  assert.equal(message.split("\n").length, 7);
  assert.ok(message.split("\n").every((line) => line.endsWith("לא זוהה")));
});

test("Floor labels are normalized from Madlan's value-first and label-first layouts", () => {
  assert.equal(LRWhatsAppMessage.normalizeFloor("3\nקומה"), "קומה 3");
  assert.equal(LRWhatsAppMessage.normalizeFloor("קומה 4"), "קומה 4");
  assert.equal(LRWhatsAppMessage.normalizeFloor("4", true), "קומה 4");
  assert.equal(LRWhatsAppMessage.normalizeFloor("4 חד׳"), null);
});
