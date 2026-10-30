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
  location: {
    pathname: "/realestate/item/center-and-sharon/v3y00p91",
    href: "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91?source=test",
  },
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

test("Yad2 first-hand project detail pages are recognized", () => {
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636"), true);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636/"), true);
  assert.equal(context.LRYad2.isProjectPage("/realestate/item/center-and-sharon/v3y00p91"), false);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/"), false);
  assert.equal(
    context.LRYad2.listingUrl(context.document),
    "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91?source=test"
  );
});

test("Madlan project detail pages are recognized", () => {
  const projectAddress = {
    innerText: "יהושע שטמפפר 81, פתח תקווה",
  };
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector(selector) {
        return selector === '[data-testid="project-address"]'
          ? projectAddress
          : null;
      },
    },
    URL,
    location: {
      pathname: "/listings/ad-456",
      href: "https://www.madlan.co.il/listings/ad-456",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );

  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/example_project"), true);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/example_project/"), true);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/listing-id"), false);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/"), false);
  assert.equal(
    madlanContext.LRMadlan.listingUrl(madlanContext.document),
    "https://www.madlan.co.il/listings/ad-456"
  );
  madlanContext.location.pathname = "/projects/example_project";
  madlanContext.location.href = "https://www.madlan.co.il/projects/example_project";
  const address = madlanContext.LRMadlan.readAddress(
    madlanContext.document,
    "",
    null,
    true
  );
  assert.equal(address.street, "יהושע שטמפפר 81");
  assert.equal(address.city, "פתח תקווה");
  assert.ok(address.queries.some((query) => query.q === "יהושע שטמפפר 81, פתח תקווה"));
});

test("Madlan project pages never geocode the full page text as an address", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/projects/example_project",
      href: "https://www.madlan.co.il/projects/example_project",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );

  const address = madlanContext.LRMadlan.readAddress(
    madlanContext.document,
    "פרויקטים חדשים יהודה | פרויקט שטמפפר 81 פתח תקווה ועוד טקסטים",
    null,
    true
  );
  assert.deepEqual(address.queries, []);
});
