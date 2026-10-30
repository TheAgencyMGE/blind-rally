import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArrivalDetector } from '../public/js/arrival.js';
import { BASE, offset } from './helpers.js';

const walkCfg = { arrivalRadius: 35, maxAccuracy: 60, dwellMs: 6000, maxDwellSpeed: 3 };
const dest = offset(BASE, 800, 300);
const fix = (p, t, extra = {}) => ({ ...p, accuracy: 10, speed: 0, time: t, ...extra });

test('requires at least one valid target', () => {
  assert.throws(() => createArrivalDetector({ ...walkCfg, targets: [] }));
  assert.throws(() => createArrivalDetector({ ...walkCfg, targets: [{ lat: 0, lon: 0 }] }));
});

test('arrives after dwelling inside the zone', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  const near = offset(dest, 10, 5);
  assert.equal(d.update(fix(near, 0)).arrived, false);
  assert.equal(d.update(fix(near, 3000)).arrived, false);
  assert.equal(d.update(fix(near, 6500)).arrived, true);
});

test('passing by quickly does not count (speed too high)', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  for (let t = 0; t <= 20000; t += 1000) {
    assert.equal(d.update(fix(offset(dest, 5, 0), t, { speed: 12 })).arrived, false);
  }
});

test('brief touch of the zone then leaving resets dwell', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  d.update(fix(dest, 0));
  d.update(fix(dest, 4000));
  d.update(fix(offset(dest, 200, 0), 5000)); // left the zone
  assert.equal(d.update(fix(dest, 7000)).arrived, false, 'dwell restarted');
  assert.equal(d.update(fix(dest, 13500)).arrived, true);
});

test('outside the zone never arrives', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  for (let t = 0; t < 60000; t += 2000) assert.equal(d.update(fix(offset(dest, 120, 0), t)).arrived, false);
});

test('GPS slack widens the zone, but only up to arrivalRadius', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  // 60 m away with ±40 m accuracy: effective radius 35 + 35 = 70 → inside
  assert.equal(d.update(fix(offset(dest, 60, 0), 0, { accuracy: 40 })).inside, true);
  // 80 m away: outside even with maximum slack
  assert.equal(d.update(fix(offset(dest, 80, 0), 1000, { accuracy: 55 })).inside, false);
});

test('weak fixes never trigger arrival and never reset dwell', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  d.update(fix(dest, 0));
  const weak = d.update(fix(offset(dest, 500, 0), 2000, { accuracy: 300 }));
  assert.equal(weak.quality, 'weak');
  assert.equal(weak.inside, false);
  assert.equal(d.update(fix(dest, 6500)).arrived, true);
});

test('a weak fix sitting right on the destination does not complete the rally', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  for (let t = 0; t < 30000; t += 1000) assert.equal(d.update(fix(dest, t, { accuracy: 150 })).arrived, false);
});

test('invalid fixes are rejected', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  assert.equal(d.update({ lat: NaN, lon: 1, accuracy: 5, time: 0 }).quality, 'invalid');
  assert.equal(d.update({ lat: 1, lon: 1, time: 0 }).quality, 'invalid');
});

test('any of several targets counts (POI centre or routed arrival point)', () => {
  const routedEnd = offset(dest, -150, 0); // e.g. a park entrance
  const d = createArrivalDetector({ ...walkCfg, targets: [dest, routedEnd] });
  d.update(fix(routedEnd, 0));
  assert.equal(d.update(fix(routedEnd, 7000)).arrived, true);
});

test('explicit check-in: a single good fix inside is enough', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  assert.deepEqual(d.checkIn(fix(offset(dest, 20, 0), 0)), { arrived: true, reason: 'ok' });
  assert.equal(d.checkIn(fix(offset(dest, 300, 0), 0)).reason, 'not-here');
  assert.equal(d.checkIn(fix(dest, 0, { accuracy: 200 })).reason, 'weak');
  assert.equal(d.checkIn({ lat: 'x' }).reason, 'invalid');
});

test('odometer ignores jitter and needs enough fixes before reporting', () => {
  const d = createArrivalDetector({ ...walkCfg, targets: [dest] });
  let t = 0;
  for (let i = 0; i < 10; i++) d.update(fix(offset(BASE, (i % 2) * 3, 0), (t += 1000)));
  assert.ok(d.distanceTravelled < 1, `jitter counted: ${d.distanceTravelled}`);
  for (let n = 50; n <= 500; n += 50) d.update(fix(offset(BASE, n, 0), (t += 30000), { speed: 1.4 }));
  assert.ok(Math.abs(d.distanceTravelled - 500) < 15, `got ${d.distanceTravelled}`);

  const fresh = createArrivalDetector({ ...walkCfg, targets: [dest] });
  fresh.update(fix(BASE, 0));
  assert.equal(fresh.distanceTravelled, null);
});
