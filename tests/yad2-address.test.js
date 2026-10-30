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

test("Yad2 search cards preserve the displayed house number when structured data omits it", () => {
  const parsed = readCardAddress(
    "מיכל לייב כץ 64",
    [
      "₪ 2,650,000",
      "מיכל לייב כץ 64",
      "דירה, כפר גנים ב, פתח תקווה",
      "4.5 חדרים • קומה 2 • 110 מ״ר",
    ].join("\n")
  );

  assert.equal(parsed.street, "מיכל לייב כץ 64");
  assert.equal(parsed.city, "פתח תקווה");
  assert.ok(parsed.queries.some((query) => query.q === "מיכל לייב כץ 64, פתח תקווה"));
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
  assert.equal(context.LRYad2.isProjectListingPage("/yad1"), true);
  assert.equal(context.LRYad2.isProjectListingPage("/yad1/"), true);
  assert.equal(context.LRYad2.isProjectListingPage("/yad1/project/18636"), false);
  assert.equal(
    context.LRYad2.listingUrl(context.document),
    "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91?source=test"
  );
});

test("Yad2 project pages use the project address and exact coordinates", () => {
  const project = {
    id: 18636,
    street: { name: "יהושע שטמפפר" },
    city: { name: "פתח תקווה" },
    houseNumber: "81",
    x: 34.89127731323242,
    y: 32.09439468383789,
  };
  const projectAddress = { innerText: "יהושע שטמפפר 81, פתח תקווה" };
  const projectContext = {
    LR,
    URL,
    location: {
      pathname: "/yad1/project/18636",
      href: "https://www.yad2.co.il/yad1/project/18636",
    },
    document: {
      querySelector(selector) {
        if (selector === 'script#__NEXT_DATA__') {
          return {
            textContent: JSON.stringify({
              props: {
                pageProps: {
                  grayProject: project,
                  project: {
                    token: "18636",
                    projectName: "שטמפפר 81",
                    address: {
                      display: "יהושע שטמפפר 81, פתח תקווה",
                      city: { text: "פתח תקווה" },
                      neighborhood: { text: "שיפר" },
                      coords: { lat: 32.094394, lon: 34.891279 },
                    },
                    additionalDetails: {
                      minPrice: 1790000,
                      maxPrice: 1790000,
                      minSquaremeter: 47,
                      maxSquaremeter: 120,
                      roomsCount: 5,
                    },
                  },
                },
              },
            }),
          };
        }
        return null;
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    projectContext
  );
  const root = {
    querySelector(selector) {
      return selector === '[data-testid="project-address"]' ? projectAddress : null;
    },
  };
  root.querySelector = (selector) => {
    if (selector === '[data-testid="project-address"]') return projectAddress;
    if (selector === '[data-testid="project-title"], h1') {
      return { innerText: "פרויקט שטמפפר 81 פתח תקווה" };
    }
    return null;
  };

  const parsed = projectContext.LRYad2.readAddress(
    root,
    "פרויקט שטמפפר 81 פתח תקווה | פרויקטים חדשים",
    null,
    true
  );
  assert.equal(parsed.street, "יהושע שטמפפר 81");
  assert.equal(parsed.city, "פתח תקווה");
  assert.deepEqual(parsed.queries[0], {
    q: "יהושע שטמפפר 81, פתח תקווה",
    approx: false,
    bias: false,
  });
  assert.equal(parsed.coordinates.lat, 32.09439468383789);
  assert.equal(parsed.coordinates.lon, 34.89127731323242);
  assert.equal(
    parsed.queries.some((query) => query.q.includes("פרויקטים חדשים")),
    false
  );
  const projectExport = projectContext.LRYad2.projectExportData(root, "text");
  assert.equal(projectExport.id, "18636");
  assert.equal(projectExport.recordType, "project");
  assert.equal(projectExport.price, 1790000);
  assert.equal(projectExport.maxPrice, 1790000);
  assert.equal(projectExport.sqm, 47);
  assert.equal(projectExport.maxSqm, 120);
  assert.equal(projectExport.pricePerSqm, Math.round(1790000 / 47));
  assert.equal(projectExport.rooms, 5);
});

test("Madlan project detail pages are recognized", () => {
  const projectAddress = {
    innerText: "יהושע שטמפפר 81, פתח תקווה",
  };
  let hasProjectAddress = false;
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector(selector) {
        return hasProjectAddress && selector === '[data-testid="project-address"]'
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
    madlanContext.LRMadlan.isProjectListingPage("/projects-for-sale/ישראל"),
    true
  );
  assert.equal(
    madlanContext.LRMadlan.isProjectListingPage("/projects-for-rent/ישראל"),
    true
  );
  assert.equal(
    madlanContext.LRMadlan.isProjectListingPage("/projects/example_project"),
    false
  );
  assert.equal(
    madlanContext.LRMadlan.listingUrl(madlanContext.document),
    "https://www.madlan.co.il/listings/ad-456"
  );
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/ad-456"), false);
  hasProjectAddress = true;
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/ad-456"), true);
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
