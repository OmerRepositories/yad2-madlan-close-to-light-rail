// Shared location helpers used by listing pages and Facebook.
var LRLocation = (() => {
  function validCoordinates(point) {
    return (
      point &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lon) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lon) <= 180
    );
  }

  function stationMapsQuery(name) {
    const station = String(name || "").trim();
    return /תחנ|רכבת קלה|light rail|tram/i.test(station)
      ? station
      : `תחנת הרכבת הקלה ${station}`;
  }

  function mapsDirectionsUrl(origin, destination) {
    const params = new URLSearchParams({
      api: "1",
      travelmode: "walking",
      origin:
        typeof origin === "string"
          ? origin
          : `${origin.lat},${origin.lon}`,
      destination:
        typeof destination === "string"
          ? stationMapsQuery(destination)
          : destination.name
            ? stationMapsQuery(destination.name)
            : `${destination.lat},${destination.lon}`,
    });
    return `https://www.google.com/maps/dir/?${params}`;
  }

  return { validCoordinates, mapsDirectionsUrl, stationMapsQuery };
})();

if (typeof module !== "undefined") module.exports = LRLocation;
