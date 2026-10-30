const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LR = require("../parse.js");
const context = {
  LR,
  URL,
  document: { querySelector: () => null },
  location: { pathname: "/realestate/item/center-and-sharon/v3y00p91" },
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
  context
);

function readCardAddress(address, text) {
  const root = {
    querySelector(selector) {
      if (selector === 'a[href*="/realestate/item/"]') {
        return { href: "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91" };
      }
      if (selector.includes('data-testid="ad-card-address"')) {
        return { innerText: address };
      }
      return null;
    },
  };
  return context.LRYad2.readAddress(root, text, null, false);
}

test("Yad2 search cards use locality shown outside the address line", () => {
  const text = [
    "2,310,000 ₪",
    "ביאליק 2",
    "דירה, מחנה יהודה, פתח תקווה",
    "4 חדרים • קומה 1 • 103 מ״ר",
  ].join("\n");
  const parsed = readCardAddress("ביאליק 2", text);

  assert.equal(parsed.street, "ביאליק 2");
  assert.equal(parsed.city, "פתח תקווה");
  assert.equal(parsed.hood, "מחנה יהודה");
  assert.deepEqual(parsed.queries[0], {
    q: "ביאליק 2, פתח תקווה",
    approx: false,
    bias: false,
  });
});

test("Yad2 does not replace a focused address with a conflicting house number", () => {
  const text = [
    "ביאליק 3",
    "דירה, מחנה יהודה, פתח תקווה",
  ].join("\n");
  const parsed = readCardAddress("ביאליק 2", text);

  assert.equal(parsed.street, "ביאליק 2");
  assert.equal(parsed.queries.some((query) => query.q === "ביאליק 3, פתח תקווה"), false);
});

test("city-only geocoding queries are explicitly marked as not being an address", () => {
  const parsed = LR.parseAddress("", "פתח תקווה");

  assert.equal(parsed.queries.length, 1);
  assert.deepEqual(parsed.queries[0], {
    q: "פתח תקווה",
    approx: true,
    bias: false,
    cityOnly: true,
  });
});

test("Yad2 first-hand project detail pages are recognized and excluded", () => {
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636"), true);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636/"), true);
  assert.equal(context.LRYad2.isProjectPage("/realestate/item/center-and-sharon/v3y00p91"), false);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/"), false);
});
