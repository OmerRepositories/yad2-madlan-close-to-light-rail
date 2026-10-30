const assert = require("node:assert/strict");
const test = require("node:test");

const LRLocation = require("../location.js");

test("Google Maps directions use the listing address and station name", () => {
  const url = new URL(
    LRLocation.mapsDirectionsUrl("ביאליק 2, פתח תקווה", "תחנת הרכבת הקלה בילינסון")
  );

  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/maps/dir/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("origin"), "ביאליק 2, פתח תקווה");
  assert.equal(url.searchParams.get("destination"), "תחנת הרכבת הקלה בילינסון");
});

test("Google Maps directions retain coordinate fallback for listings without address text", () => {
  const url = new URL(
    LRLocation.mapsDirectionsUrl({ lat: 32.08, lon: 34.78 }, {
      name: "תחנת הרכבת הקלה בילינסון",
      lat: 32.09,
      lon: 34.79,
    })
  );

  assert.equal(url.searchParams.get("origin"), "32.08,34.78");
  assert.equal(url.searchParams.get("destination"), "תחנת הרכבת הקלה בילינסון");
});

test("Google Maps station queries do not duplicate an existing station label", () => {
  assert.equal(
    LRLocation.stationMapsQuery("תחנת בילינסון"),
    "תחנת בילינסון"
  );
  assert.equal(
    LRLocation.stationMapsQuery("Bilinson"),
    "תחנת הרכבת הקלה Bilinson"
  );
});
