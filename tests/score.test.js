import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRally, styleFor, gradeFor, parseMaxspeed, createSpeedWatch } from '../public/js/score.js';

const perfect = { timeMs: 600_000, etaSec: 600, routeDistance: 800, travelled: 820, accuracy: 100, wrongTurns: 0, peeks: 0, difficulty: 'rookie' };

test('a clean on-par rookie run is an S', () => {
  const r = scoreRally(perfect);
  assert.equal(r.score, 950);
  assert.equal(r.grade, 'S');
  assert.deepEqual(r.parts.map((p) => p.key), ['clean']);
});

test('score is capped at 1000 and never negative', () => {
  assert.equal(scoreRally({ ...perfect, difficulty: 'insane', timeMs: 300_000 }).score, 1000);
  const awful = scoreRally({ ...perfect, timeMs: 6_000_000, accuracy: 0, travelled: 8000, wrongTurns: 20, peeks: 10, speeding: 5 });
  assert.equal(awful.score, 0);
  assert.equal(awful.grade, 'F');
});

test('every penalty is itemised', () => {
  const r = scoreRally({ ...perfect, wrongTurns: 2, peeks: 1, accuracy: 90, travelled: 1200, timeMs: 900_000 });
  const by = Object.fromEntries(r.parts.map((p) => [p.key, p.points]));
  assert.equal(by.wrongTurns, -80);
  assert.equal(by.peeks, -75);
  assert.equal(by.accuracy, -40);
  assert.equal(by.distance, -75); // 50% extra, 20% free → 0.3 × 250
  assert.equal(by.pace, -105); // ratio 1.5 → (1.5 − 1.15) × 300
  assert.equal(by.clean, undefined);
  assert.equal(r.score, 900 + r.parts.reduce((a, p) => a + p.points, 0));
});

test('wrong-turn penalty is capped; missing travelled skips the distance check', () => {
  const r = scoreRally({ ...perfect, wrongTurns: 50, travelled: null });
  const by = Object.fromEntries(r.parts.map((p) => [p.key, p.points]));
  assert.equal(by.wrongTurns, -200);
  assert.equal(by.distance, undefined);
});

test('grades follow thresholds', () => {
  assert.equal(gradeFor(1000), 'S');
  assert.equal(gradeFor(949), 'A');
  assert.equal(gradeFor(750), 'B');
  assert.equal(gradeFor(649), 'D');
  assert.equal(gradeFor(10), 'F');
});

test('style titles', () => {
  const st = (o) => styleFor({ ...perfect, ...o }, scoreRally({ ...perfect, ...o })).id;
  assert.equal(st({ difficulty: 'pro' }), 'human-gps');
  assert.equal(st({ peeks: 2 }), 'peeker');
  assert.equal(st({ wrongTurns: 3 }), 'comeback');
  assert.equal(st({ timeMs: 400_000, wrongTurns: 1 }), 'speedrunner');
  assert.equal(st({ speeding: 2 }), 'lead-foot');
  assert.equal(st({ wrongTurns: 1, travelled: 1500 }), 'scenic');
  assert.equal(st({}), 'precision');
});

test('parseMaxspeed', () => {
  assert.equal(parseMaxspeed('50'), 50);
  assert.ok(Math.abs(parseMaxspeed('25 mph') - 40.2336) < 1e-6);
  assert.equal(parseMaxspeed('RU:urban'), null);
  assert.equal(parseMaxspeed('none'), null);
  assert.equal(parseMaxspeed(undefined), null);
});

test('speed watch counts sustained speeding once per episode', () => {
  const w = createSpeedWatch({ marginKmh: 10, holdMs: 8000 });
  w.update(30, 0); // no limit yet
  assert.equal(w.incidents, 0);
  w.setLimit(50);
  const ms = (kmh) => kmh / 3.6;
  w.update(ms(65), 0);
  w.update(ms(65), 5000);
  assert.equal(w.incidents, 0);
  w.update(ms(65), 9000);
  w.update(ms(70), 20000);
  assert.equal(w.incidents, 1);
  w.update(ms(55), 21000); // still over limit, under margin: not re-armed
  w.update(ms(65), 30000);
  assert.equal(w.incidents, 1);
  w.update(ms(45), 31000); // back under
  w.update(ms(65), 32000);
  w.update(ms(65), 41000);
  assert.equal(w.incidents, 2);
});

test('speed limit lookup picks the nearest tagged road', async () => {
  const { parseSpeedLimit, fetchSpeedLimit, buildSpeedQuery } = await import('../public/js/speedlimit.js');
  const p = { lat: 47.6097, lon: -122.3422 };
  const json = {
    elements: [
      { tags: { maxspeed: '35 mph' }, center: { lat: 47.611, lon: -122.3422 } },
      { tags: { maxspeed: '25 mph' }, center: { lat: 47.6098, lon: -122.3422 } },
      { tags: { maxspeed: 'signals' }, center: { lat: 47.6097, lon: -122.3422 } },
    ],
  };
  const r = parseSpeedLimit(json, p);
  assert.equal(r.mph, true);
  assert.ok(Math.abs(r.kmh - 40.23) < 0.01);
  assert.equal(parseSpeedLimit({ elements: [] }, p), null);
  assert.match(buildSpeedQuery(p), /around:25,47\.60970,-122\.34220/);
  const got = await fetchSpeedLimit(p, { fetchJson: async () => json });
  assert.equal(Math.round(got.kmh), 40);
});
