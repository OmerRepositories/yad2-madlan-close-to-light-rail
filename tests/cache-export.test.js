const assert = require("node:assert/strict");
const test = require("node:test");

const CacheExport = require("../cache-export.js");

function parseCsvRow(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      value += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

test("CSV export includes every amenity flag, coordinates, URL, and arbitrary record data", async () => {
  const updatedAt = Date.UTC(2026, 9, 30);
  const csv = await CacheExport.buildCsv(
    {
      "yad2:ad-123": {
        amenities: { parking: true, secureRoom: false, newFlag: true },
        coordinates: { lat: 32.1, lon: 34.8 },
        updatedAt,
        url: "https://www.yad2.co.il/realestate/item/center-and-sharon/ad-123",
        sourceNote: "owner said \"renovated\"",
      },
      "madlan:ad-456": {
        amenities: { parking: false },
        updatedAt,
        legacyField: "kept",
      },
    },
    () => {},
    updatedAt + 1000
  );
  const rows = csv.slice(1).trimEnd().split("\r\n").map(parseCsvRow);
  const headers = rows[0];
  const yad2 = Object.fromEntries(headers.map((header, index) => [header, rows[1][index]]));
  const madlan = Object.fromEntries(headers.map((header, index) => [header, rows[2][index]]));

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(yad2.cache_key, "yad2:ad-123");
  assert.equal(yad2.listing_url, "https://www.yad2.co.il/realestate/item/center-and-sharon/ad-123");
  assert.equal(yad2.amenity_parking, "true");
  assert.equal(yad2.amenity_secureRoom, "false");
  assert.equal(yad2.amenity_newFlag, "true");
  assert.equal(yad2.latitude, "32.1");
  assert.equal(yad2.longitude, "34.8");
  assert.equal(yad2.record_sourceNote, 'owner said "renovated"');
  assert.equal(JSON.parse(yad2.record_json).amenities.secureRoom, false);
  assert.equal(madlan.listing_url, "https://www.madlan.co.il/listings/ad-456");
  assert.equal(madlan.record_legacyField, "kept");
});

test("CSV export includes a safe Yad2 fallback URL and guards spreadsheet formulas", async () => {
  const csv = await CacheExport.buildCsv(
    {
      "yad2:token-1": {
        amenities: {},
        updatedAt: 1,
        note: "\n=HYPERLINK(\"https://example.com\")",
      },
    },
    () => {},
    2
  );
  const [headers, values] = csv.slice(1).trimEnd().split("\r\n").map(parseCsvRow);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));

  assert.equal(
    row.listing_url,
    "https://www.yad2.co.il/realestate/item/token-1"
  );
  assert.equal(row.record_note, '\'\n=HYPERLINK("https://example.com")');
});

test("CSV generation yields progress while processing a large cache", async () => {
  const progress = [];
  const cache = Object.fromEntries(
    Array.from({ length: 450 }, (_, index) => [
      `madlan:${index}`,
      { amenities: { parking: index % 2 === 0 }, updatedAt: 100 },
    ])
  );

  await CacheExport.buildCsv(cache, (complete, total) => progress.push([complete, total]), 200);

  assert.deepEqual(progress, [
    [0, 450],
    [200, 450],
    [400, 450],
    [450, 450],
  ]);
});
