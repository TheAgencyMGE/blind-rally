// Realistic OSRM / Overpass fixtures for tests.
import { BASE, offset } from './helpers.js';

export function osrmStep(type, modifier, name, loc, distance = 200, extra = {}) {
  return {
    name,
    distance,
    maneuver: { type, modifier, location: [loc.lon, loc.lat], bearing_after: 0, ...extra },
  };
}

/** A route from `start` to `end` with a couple of turns. */
export function osrmRoute(start, end, { distance = 1100, endSnap = 12, startSnap = 4 } = {}) {
  const mid1 = offset(start, 400, 0);
  const mid2 = offset(mid1, 0, 300);
  return {
    code: 'Ok',
    routes: [
      {
        distance,
        duration: distance / 1.4,
        geometry: { type: 'LineString', coordinates: [start, mid1, mid2, end].map((p) => [p.lon, p.lat]) },
        legs: [
          {
            steps: [
              osrmStep('depart', undefined, 'Pike Street', start, 400),
              osrmStep('turn', 'right', '1st Avenue', mid1, 300),
              osrmStep('new name', 'straight', '1st Avenue', offset(mid1, 0, 100), 50),
              osrmStep('turn', 'left', 'Pine Street', mid2, 400),
              osrmStep('notification', 'straight', '', mid2, 0),
              osrmStep('arrive', 'right', 'Pine Street', end, 0),
            ],
          },
        ],
      },
    ],
    waypoints: [
      { location: [start.lon, start.lat], distance: startSnap },
      { location: [end.lon, end.lat], distance: endSnap },
    ],
  };
}

export function overpassResponse() {
  const el = (id, p, tags, type = 'node') =>
    type === 'node' ? { type, id, lat: p.lat, lon: p.lon, tags } : { type, id, center: { lat: p.lat, lon: p.lon }, tags };
  return {
    elements: [
      el(101, offset(BASE, 800, 300), { name: 'Hidden Viewpoint', tourism: 'viewpoint', wikidata: 'Q1' }),
      el(102, offset(BASE, -700, -400), { name: 'Lakeside Park', leisure: 'park' }, 'way'),
      el(103, offset(BASE, 300, 0), { name: 'Corner Coffee', amenity: 'cafe' }),
      el(104, offset(BASE, 400, 5), { name: 'Big Bank', amenity: 'bank' }),
    ],
  };
}
