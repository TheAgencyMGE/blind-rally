// Shared test helpers.
export const BASE = { lat: 47.6097, lon: -122.3422 };

/** Offset a point by metres north/east (good enough at city scale). */
export function offset(p, north, east) {
  const dLat = north / 111_320;
  const dLon = east / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

export function fakeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
