import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingMs, elapsedMs, formatElapsed, formatCountdown, createTicker } from '../public/js/timer.js';

test('remainingMs never goes negative', () => {
  assert.equal(remainingMs(10_000, 4_000), 6_000);
  assert.equal(remainingMs(10_000, 12_000), 0);
});

test('elapsedMs uses end time when given, survives clock oddities', () => {
  assert.equal(elapsedMs(1_000, 5_000), 4_000);
  assert.equal(elapsedMs(1_000, 99_999, 3_500), 2_500);
  assert.equal(elapsedMs(5_000, 1_000), 0);
});

test('formatElapsed', () => {
  assert.equal(formatElapsed(0), '00:00.0');
  assert.equal(formatElapsed(754_321), '12:34.3');
  assert.equal(formatElapsed(4_000_123), '1:06:40.1');
  assert.equal(formatElapsed(59_999, { tenths: false }), '00:59');
  assert.equal(formatElapsed(-5), '00:00.0');
});

test('formatCountdown rounds up so the last second is visible', () => {
  assert.equal(formatCountdown(30_000), '30');
  assert.equal(formatCountdown(29_001), '30');
  assert.equal(formatCountdown(1), '1');
  assert.equal(formatCountdown(0), '0');
});

test('briefing countdown reaches zero exactly once with a fake clock', () => {
  let now = 0;
  let cb = null;
  const endsAt = 15_000;
  const ticks = [];
  const t = createTicker((n) => ticks.push(remainingMs(endsAt, n)), {
    interval: 100,
    now: () => now,
    setIntervalFn: (fn) => { cb = fn; return 1; },
    clearIntervalFn: () => { cb = null; },
  });
  t.start();
  assert.equal(t.running, true);
  for (now = 100; now <= 16_000; now += 100) cb?.();
  assert.equal(ticks[0], 15_000);
  assert.equal(ticks.at(-1), 0);
  assert.ok(ticks.indexOf(0) > 0);
  t.stop();
  assert.equal(t.running, false);
  assert.equal(cb, null);
});

test('timer derived from timestamps is unaffected by missed ticks (backgrounded tab)', () => {
  const startedAt = 1_000_000;
  // Pretend the tab slept for 5 minutes: only two ticks happen.
  assert.equal(formatElapsed(elapsedMs(startedAt, startedAt + 300_000)), '05:00.0');
});
