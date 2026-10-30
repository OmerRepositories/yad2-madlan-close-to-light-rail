// יד2 exposes structured listing data in __NEXT_DATA__; use it before text heuristics.
var LRYad2 = (() => {
  let pageData;
  let pageDataRead = false;

  function getPageData() {
    if (pageDataRead) return pageData;
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script) return null;
    try {
      pageData = JSON.parse(script.textContent);
      pageDataRead = true;
    } catch (error) {
      console.warn("[lightrail-ext] could not read Yad2 listing data", error);
    }
    return pageData || null;
  }

  function listingId(root) {
    if (root === document) {
      const pageMatch = location.pathname.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
      if (pageMatch) return pageMatch[1];
    }
    const links = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];
    for (const link of links) {
      try {
        const path = new URL(link.href, location.href).pathname;
        const match = path.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
        if (match) return match[1];
      } catch {}
    }
    const match = location.pathname.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
    return match ? match[1] : null;
  }

  function findListing(data, id) {
    if (!data || !id) return null;
    if (Array.isArray(data)) {
      for (const value of data) {
        const found = findListing(value, id);
        if (found) return found;
      }
    } else if (typeof data === "object") {
      if (String(data.token || "") === id && data.address) return data;
      for (const value of Object.values(data)) {
        const found = findListing(value, id);
        if (found) return found;
      }
    }
    return null;
  }

  function placeFromData(root) {
    const record = findListing(getPageData(), listingId(root));
    const address = record && record.address;
    if (!address) return null;
    const street = address.street && address.street.text;
    const city = address.city && address.city.text;
    if (!street || !city) return null;
    const number = address.house && address.house.number;
    const coords = address.coords;
    const escapedNumber = String(number || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fullStreet =
      number && !new RegExp(`\\s${escapedNumber}$`).test(street) ? `${street} ${number}` : street;
    return {
      street: fullStreet,
      city,
      hood: address.neighborhood && address.neighborhood.text,
      coordinates:
        coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
          ? { lat: coords.lat, lon: coords.lon }
          : null,
    };
  }

  function readAddress(root, text, ctxCity, single) {
    const place = placeFromData(root);
    if (place) {
      return {
        ...LR.parseAddress(`${place.street}, ${place.hood || ""}, ${place.city}`, ctxCity),
        coordinates: place.coordinates,
      };
    }

    const addressElement = root.querySelector(
      '[data-testid="address"], [data-testid="ad-card-address"]'
    );
    const addressText = addressElement ? addressElement.innerText : text;
    const parsed = single
      ? LR.parseAny(addressText, ctxCity)
      : LR.parseAddress(addressText, ctxCity);
    return { ...parsed, coordinates: null };
  }

  return { readAddress };
})();
