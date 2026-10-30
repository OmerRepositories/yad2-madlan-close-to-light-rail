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

  function mapsDirectionsUrl(origin, destination) {
    const params = new URLSearchParams({
      api: "1",
      travelmode: "walking",
      origin: `${origin.lat},${origin.lon}`,
      destination: `${destination.lat},${destination.lon}`,
    });
    return `https://www.google.com/maps/dir/?${params}`;
  }

  return { validCoordinates, mapsDirectionsUrl };
})();
