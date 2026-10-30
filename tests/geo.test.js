import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, isValidCoord, bearing, compass, formatDistance, pathLength, gridKey } from '../public/js/geo.js';

test('haversine: known distance (Paris → London ≈ 343.5 km)', () => {
  const d = haversine({ lat: 48.8566, lon: 2.3522 }, { lat: 51.5074, lon: -0.1278 });
  assert.ok(Math.abs(d - 343_500) < 1500, `got ${d}`);
});

test('haversine: zero for identical points and symmetric', () => {
  const a = { lat: 47.6, lon: -122.3 };
  const b = { lat: 47.61, lon: -122.31 };
  assert.equal(haversine(a, a), 0);
  assert.equal(haversine(a, b), haversine(b, a));
});

test('isValidCoord rejects garbage and null island', () => {
  assert.equal(isValidCoord({ lat: 47.6, lon: -122.3 }), true);
  assert.equal(isValidCoord({ lat: 0, lon: 0 }), false);
  assert.equal(isValidCoord({ lat: 91, lon: 0 }), false);
  assert.equal(isValidCoord({ lat: 10, lon: 181 }), false);
  assert.equal(isValidCoord({ lat: NaN, lon: 1 }), false);
  assert.equal(isValidCoord(null), false);
  assert.equal(isValidCoord({ lat: '47', lon: '-122' }), false);
});

test('bearing and compass', () => {
  const b = bearing({ lat: 0, lon: 0.001 }, { lat: 1, lon: 0.001 });
  assert.ok(b < 1 || b > 359);
  assert.equal(compass(0), 'north');
  assert.equal(compass(92), 'east');
  assert.equal(compass(225), 'southwest');
  assert.equal(compass(359), 'north');
});

test('formatDistance metric and imperial', () => {
  assert.equal(formatDistance(234), '230 m');
  assert.equal(formatDistance(1530), '1.5 km');
  assert.equal(formatDistance(15300), '15 km');
  assert.equal(formatDistance(100, 'imperial'), '330 ft');
  assert.equal(formatDistance(1609.344 * 2.04, 'imperial'), '2.0 mi');
  assert.equal(formatDistance(NaN), '—');
});

test('pathLength sums segments; gridKey rounds', () => {
  const pts = [{ lat: 0, lon: 0.1 }, { lat: 0, lon: 0.2 }, { lat: 0, lon: 0.3 }];
  assert.ok(Math.abs(pathLength(pts) - haversine(pts[0], pts[2])) < 1);
  assert.equal(gridKey({ lat: 47.61234, lon: -122.34567 }, 2), '47.61,-122.35');
});
