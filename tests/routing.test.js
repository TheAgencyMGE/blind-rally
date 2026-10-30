import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteUrl, parseRoute, describeStep } from '../public/js/routing.js';
import { BASE, offset } from './helpers.js';
import { osrmRoute } from './fixtures.js';

test('route URL uses lon,lat order and asks for steps + geojson', () => {
  const url = buildRouteUrl('https://r.example/route/v1/foot', { lat: 1.5, lon: 2.25 }, { lat: 3, lon: 4 });
  assert.equal(url, 'https://r.example/route/v1/foot/2.250000,1.500000;4.000000,3.000000?overview=full&geometries=geojson&steps=true&alternatives=false');
});

test('parseRoute extracts geometry, steps and snap distances', () => {
  const end = offset(BASE, 800, 300);
  const r = parseRoute(osrmRoute(BASE, end, { endSnap: 25 }));
  assert.equal(r.distance, 1100);
  assert.equal(r.geometry.length, 4);
  assert.deepEqual(r.geometry[0], { lat: BASE.lat, lon: BASE.lon });
  assert.equal(r.endSnapDistance, 25);
  assert.equal(r.startSnapDistance, 4);
  assert.ok(Math.abs(r.endPoint.lat - end.lat) < 1e-9);
  // notification dropped, duplicate "new name" on same street merged into the previous turn
  assert.deepEqual(r.steps.map((s) => s.type), ['depart', 'turn', 'turn', 'arrive']);
  assert.equal(r.steps[1].distance, 350);
  assert.equal(r.steps[1].text, 'Turn right onto 1st Avenue');
  assert.equal(r.steps[2].text, 'Turn left onto Pine Street');
  assert.equal(r.steps[3].text, "Arrive at the destination — it's on your right");
});

test('parseRoute throws no-route for NoRoute / empty responses', () => {
  for (const bad of [{ code: 'NoRoute', message: 'Impossible route' }, { code: 'Ok', routes: [] }, null]) {
    assert.throws(() => parseRoute(bad), (e) => e.kind === 'no-route');
  }
});

test('describeStep covers common maneuvers without naming the destination', () => {
  const s = (type, modifier, name = '', extra = {}) => describeStep({ name, maneuver: { type, modifier, ...extra } });
  assert.equal(s('depart', undefined, 'Main St', { bearing_after: 90 }), 'Head east on Main St');
  assert.equal(s('roundabout', 'right', 'Oak Rd', { exit: 2 }), 'At the roundabout, take the 2nd exit onto Oak Rd');
  assert.equal(s('fork', 'slight left', 'A1'), 'Keep left at the fork onto A1');
  assert.equal(s('end of road', 'right', 'Elm'), 'At the end of the road, turn right onto Elm');
  assert.equal(s('turn', 'sharp left'), 'Turn sharp left');
  assert.equal(s('turn', 'uturn'), 'Make a U-turn');
  assert.equal(s('continue', 'straight', 'Elm'), 'Continue on Elm');
  assert.equal(s('arrive', 'straight'), 'Arrive at the destination');
  assert.equal(describeStep({ name: 'High St', ref: 'B123', maneuver: { type: 'turn', modifier: 'left' } }), 'Turn left onto High St (B123)');
});
