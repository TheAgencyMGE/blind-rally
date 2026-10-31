import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, snapToRoute, cumulative, simplify, shrink, speedSeries } from '../public/js/track.js';
import { BASE, offset } from './helpers.js';

// An L-shaped route: 400 m north, then 400 m east.
const corner = offset(BASE, 400, 0);
const route = [BASE, offset(BASE, 200, 0), corner, offset(corner, 0, 200), offset(corner, 0, 400)];

let t = 0;
const fix = (p, accuracy = 8) => ({ ...p, accuracy, speed: 1.4, time: (t += 15000) });

function walk(tracker, points) {
  let s;
  for (const p of points) s = tracker.update(fix(p));
  return s;
}

test('snapToRoute measures distance off the route and progress along it', () => {
  const cum = cumulative(route);
  const s = snapToRoute(offset(BASE, 100, 30), route, cum);
  assert.ok(Math.abs(s.dist - 30) < 1);
  assert.ok(Math.abs(s.along - 100) < 1);
});

test('following the route exactly: no wrong turns, 100% accuracy', () => {
  const tr = createTracker(route);
  const pts = [];
  for (let n = 0; n <= 400; n += 25) pts.push(offset(BASE, n, 0));
  for (let e = 25; e <= 400; e += 25) pts.push(offset(corner, 0, e));
  const s = walk(tr, pts);
  assert.equal(s.wrongTurns, 0);
  assert.equal(s.accuracy, 100);
  assert.ok(Math.abs(s.travelled - 800) < 5);
  assert.ok(s.progress > 790);
});

test('a single stray fix is forgiven; two in a row is a wrong turn', () => {
  const tr = createTracker(route);
  walk(tr, [BASE, offset(BASE, 50, 0), offset(BASE, 100, 60), offset(BASE, 150, 0)]);
  assert.equal(tr.summary().wrongTurns, 0);
  walk(tr, [offset(BASE, 200, 80), offset(BASE, 200, 160)]);
  const s = tr.summary();
  assert.equal(s.wrongTurns, 1);
  assert.equal(s.offRoute, true);
  assert.ok(s.accuracy < 100);
});

test('rejoining the route clears off-route; leaving again counts again', () => {
  const tr = createTracker(route);
  walk(tr, [BASE, offset(BASE, 0, 80), offset(BASE, 0, 160)]); // wrong way
  assert.equal(tr.summary().wrongTurns, 1);
  walk(tr, [offset(BASE, 0, 80), offset(BASE, 30, 5), offset(BASE, 100, 0)]); // back on
  assert.equal(tr.summary().offRoute, false);
  walk(tr, [offset(BASE, 150, -70), offset(BASE, 150, -140)]);
  assert.equal(tr.summary().wrongTurns, 2);
});

test('inaccurate fixes, jitter and teleports are ignored', () => {
  const tr = createTracker(route);
  tr.update(fix(BASE));
  tr.update(fix(offset(BASE, 0, 300), 200)); // weak
  tr.update(fix(offset(BASE, 3, 0))); // jitter
  tr.update({ ...offset(BASE, 0, 5000), accuracy: 5, time: t + 1000 }); // 5 km in 1 s
  const s = tr.summary();
  assert.equal(s.travelled, 0);
  assert.equal(s.wrongTurns, 0);
});

test('snapshot restores the exact state (refresh recovery)', () => {
  const tr = createTracker(route);
  walk(tr, [BASE, offset(BASE, 0, 80), offset(BASE, 0, 160)]);
  const again = createTracker(route, { state: tr.snapshot() });
  assert.deepEqual(again.summary(), tr.summary());
  assert.equal(again.track.length, tr.track.length);
});

test('simplify keeps corners and drops collinear points; shrink caps the count', () => {
  const line = [];
  for (let n = 0; n <= 400; n += 10) line.push(offset(BASE, n, 0));
  for (let e = 10; e <= 400; e += 10) line.push(offset(corner, 0, e));
  const s = simplify(line, 2);
  assert.equal(s.length, 3);
  assert.ok(shrink(line, 2).length <= 2 || shrink(line, 2).length === 3);
  assert.ok(shrink(line, 10).length <= 10);
});

test('speedSeries buckets speeds over time', () => {
  const track = [];
  for (let i = 0; i < 20; i++) track.push([BASE.lat + i * 1e-4, BASE.lon, i * 10_000, 0, i < 10 ? 1 : 3]);
  const s = speedSeries(track, 4);
  assert.equal(s.length, 4);
  assert.ok(s[0].v < s[3].v);
});
