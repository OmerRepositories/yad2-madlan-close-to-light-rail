// Madlan exposes listing address and map-point data in its hydrated listing payload.
var LRMadlan = (() => {
  function listingId(root) {
    if (root === document) {
      const pageMatch = location.pathname.match(/\/(?:listings|bulletin)\/([^/]+)/);
      if (pageMatch) return pageMatch[1];
    }
    const listingLink = root.querySelector
      ? root.querySelector('a[data-auto="listed-bulletin-clickable"][href], a[href*="/listings/"]')
      : null;
    const links = listingLink
      ? [listingLink]
      : root.querySelectorAll
        ? root.querySelectorAll("a[href]")
        : [];
    for (const link of links) {
      try {
        const path = new URL(link.href, location.href).pathname;
        const match = path.match(/\/(?:listings|bulletin)\/([^/]+)/);
        if (match) return match[1];
      } catch {}
    }
    const match = location.pathname.match(/\/(?:listings|bulletin)\/([^/]+)/);
    return match ? match[1] : null;
  }

  function isProjectPage(path) {
    return /^\/projects\/[^/]+\/?$/.test(path);
  }

  function decodeJsonString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value;
    }
  }

  function listingData(root) {
    const id = listingId(root);
    if (!id) return null;
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scripts = [...document.scripts].map((script) => script.textContent || "");
    for (const source of scripts) {
      const directMarker = new RegExp(
        `["']id["']\\s*:\\s*["']${escapedId}["']\\s*,\\s*["']locationPoint["']\\s*:\\s*\\{\\s*["']lat["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*["']lng["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`
      );
      const directPoint = directMarker.exec(source);
      if (directPoint) {
        const addressStart = source.indexOf('"addressDetails"', directPoint.index);
        const addressTail =
          addressStart >= 0 ? source.slice(addressStart, addressStart + 5000) : "";
        const address = addressTail.match(
          /["']addressDetails["']\s*:\s*\{[\s\S]{0,3000}?["']city["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1000}?["']streetName["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,500}?["']streetNumber["']\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        return {
          coordinates: { lat: Number(directPoint[1]), lon: Number(directPoint[2]) },
          city: address ? decodeJsonString(address[1]) : null,
          street: address ? decodeJsonString(address[2]) : null,
          number: address ? decodeJsonString(address[3]) : null,
        };
      }
      const marker = new RegExp(`["']id["']\\s*:\\s*["']${escapedId}["']`, "g");
      let match;
      while ((match = marker.exec(source))) {
        const tail = source.slice(match.index, match.index + 5000);
        const point = tail.match(
          /["']locationPoint["']\s*:\s*\{\s*["']lat["']\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*["']lng["']\s*:\s*(-?\d+(?:\.\d+)?)/
        );
        if (!point) {
          marker.lastIndex = match.index + match[0].length;
          continue;
        }
        const address = tail.match(
          /["']addressDetails["']\s*:\s*\{[\s\S]{0,3000}?["']city["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1000}?["']streetName["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,500}?["']streetNumber["']\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        return {
          coordinates: { lat: Number(point[1]), lon: Number(point[2]) },
          city: address ? decodeJsonString(address[1]) : null,
          street: address ? decodeJsonString(address[2]) : null,
          number: address ? decodeJsonString(address[3]) : null,
        };
      }
    }
    return null;
  }

  function readAddress(root, text, ctxCity, single) {
    const data = listingData(root);
    const addressElement = root.querySelector(
      '[data-auto="primary_address_text"], [data-testid="address"]'
    );
    const addressText = addressElement ? addressElement.innerText : text;
    const parsed = single
      ? LR.parseAny(addressText, ctxCity)
      : LR.parseAddress(addressText, ctxCity);
    if (!data) return { ...parsed, coordinates: null };
    if (data.street && data.number && data.city) {
      const structured = LR.parseAddress(
        `${data.street} ${data.number}, ${data.city}`,
        ctxCity
      );
      return { ...structured, coordinates: data.coordinates };
    }
    return { ...parsed, coordinates: data.coordinates };
  }

  function extractPriceSqm(root, text) {
    const areaElement = root.querySelector('[data-auto="area"]');
    if (!areaElement) return LR.extractPriceSqm(text);

    const areaMatch = areaElement.innerText.match(/^\s*(\d{2,4}(?:[.,]\d+)?)\s*$/);
    if (!areaMatch) return LR.extractPriceSqm(text);

    const sqm = Number(areaMatch[1].replace(",", "."));
    if (!Number.isFinite(sqm) || sqm < 15 || sqm > 1000) return LR.extractPriceSqm(text);

    const priceElement = root.querySelector('[data-auto="current-price"]');
    const sourceText = priceElement
      ? `${priceElement.innerText}\n${sqm} מ״ר`
      : `${text}\n${sqm} מ״ר`;
    return LR.extractPriceSqm(sourceText);
  }

  const AMENITY_KEYS = [
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

  function readAmenities(root) {
    const checklist = root.querySelector('[data-auto="amenities-checklist-block"]');
    if (!checklist) return null;
    const result = {};
    for (const key of AMENITY_KEYS) {
      const item = checklist.querySelector(`[data-auto-checklist-amenity-item="${key}"]`);
      if (!item) {
        result[key] = false;
        continue;
      }
      const rect = item.querySelector("svg rect");
      result[key] = Boolean(rect && rect.getAttribute("fill") === "#018489");
    }
    return result;
  }

  return { listingId, readAddress, extractPriceSqm, readAmenities, isProjectPage };
})();
