// CSV serialization and download helpers for the locally cached listing records.
var LRCacheExport = (() => {
  const BATCH_SIZE = 200;
  const AMENITY_COLUMNS = [
    "parking",
    "secureRoom",
    "elevator",
    "storage",
    "airConditioner",
    "accessible",
    "balcony",
    "sunBoiler",
    "grating",
    "garden",
    "pool",
  ];
  const BASE_COLUMNS = [
    "cache_key",
    "site",
    "listing_id",
    "listing_url",
    "updated_at",
    "updated_at_iso",
    "is_expired",
    "latitude",
    "longitude",
  ];

  function parseCacheKey(key) {
    const separator = key.indexOf(":");
    return separator < 0
      ? { site: "unknown", listingId: key }
      : { site: key.slice(0, separator), listingId: key.slice(separator + 1) };
  }

  function fallbackUrl(site, id) {
    const encodedId = encodeURIComponent(id);
    if (site === "madlan") return `https://www.madlan.co.il/listings/${encodedId}`;
    if (site === "yad2") return `https://www.yad2.co.il/realestate/item/${encodedId}`;
    return "";
  }

  function recordUrl(site, id, record) {
    return (
      record.url ||
      record.listingUrl ||
      record.href ||
      record.link ||
      fallbackUrl(site, id)
    );
  }

  function cell(value) {
    if (value === undefined || value === null) return "";
    const isString = typeof value === "string";
    let text =
      isString
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (isString && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function getRecords(cache) {
    return Object.entries(cache && typeof cache === "object" ? cache : {}).filter(
      ([, record]) => record && typeof record === "object" && !Array.isArray(record)
    );
  }

  async function buildCsv(cache, onProgress = () => {}, now = Date.now()) {
    const records = getRecords(cache);
    const amenityKeys = new Set(AMENITY_COLUMNS);
    const extraFields = new Set();
    for (const [, record] of records) {
      for (const key of Object.keys(record.amenities || {})) amenityKeys.add(key);
      for (const key of Object.keys(record)) {
        if (!["amenities", "coordinates", "updatedAt", "url", "listingUrl", "href", "link"].includes(key)) {
          extraFields.add(key);
        }
      }
    }

    const amenities = [...amenityKeys];
    const extras = [...extraFields].sort();
    const headers = [
      ...BASE_COLUMNS,
      ...amenities.map((key) => `amenity_${key}`),
      "amenities_json",
      "coordinates_json",
      ...extras.map((key) => `record_${key}`),
      "record_json",
    ];
    const lines = [headers.map(cell).join(",")];
    onProgress(0, records.length);

    for (let index = 0; index < records.length; index++) {
      const [key, record] = records[index];
      const { site, listingId } = parseCacheKey(key);
      const coordinates = record.coordinates || {};
      const timestamp = Number.isFinite(record.updatedAt) ? record.updatedAt : "";
      const row = [
        key,
        site,
        listingId,
        recordUrl(site, listingId, record),
        timestamp,
        timestamp ? new Date(timestamp).toISOString() : "",
        timestamp ? now - timestamp >= 60 * 24 * 60 * 60 * 1000 : "",
        coordinates.lat,
        coordinates.lon,
        ...amenities.map((amenity) => record.amenities && record.amenities[amenity]),
        record.amenities,
        record.coordinates,
        ...extras.map((field) => record[field]),
        record,
      ];
      lines.push(row.map(cell).join(","));

      if ((index + 1) % BATCH_SIZE === 0 && index + 1 < records.length) {
        onProgress(index + 1, records.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    onProgress(records.length, records.length);
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function downloadCsv(csv, date = new Date()) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `listing-cache-${date.toISOString().slice(0, 10)}.csv`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return { buildCsv, downloadCsv, parseCacheKey, recordUrl };
})();

if (typeof module !== "undefined") module.exports = LRCacheExport;
