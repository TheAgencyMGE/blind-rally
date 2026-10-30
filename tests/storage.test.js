import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryStorage, recordResult, recordAbandon, emptyStats, bestForMode, scramble, unscramble, DEFAULT_SETTINGS } from '../public/js/storage.js';

const result = (over = {}) => ({
  date: 1_700_000_000_000,
  timeMs: 600_000,
  mode: 'walk',
  difficulty: 'pro',
  name: 'Hidden Viewpoint',
  label: 'Viewpoint',
  destId: 'n101',
  routeDistance: 1200,
  verified: 'gps',
  ...over,
});

test('first GPS result sets a record', () => {
  const { stats, isRecord, previousBest } = recordResult(emptyStats(), result());
  assert.equal(stats.completed, 1);
  assert.equal(isRecord, true);
  assert.equal(previousBest, null);
  assert.equal(stats.best['walk:pro'], 600_000);
  assert.deepEqual(stats.discovered, ['n101']);
  assert.equal(stats.history[0].record, true);
});

test('faster beats, slower does not; difficulties tracked separately', () => {
  let s = recordResult(emptyStats(), result()).stats;
  const slower = recordResult(s, result({ timeMs: 700_000, destId: 'n2' }));
  assert.equal(slower.isRecord, false);
  assert.equal(slower.previousBest, 600_000);
  s = slower.stats;
  const faster = recordResult(s, result({ timeMs: 500_000, destId: 'n3' }));
  assert.equal(faster.isRecord, true);
  s = faster.stats;
  s = recordResult(s, result({ difficulty: 'insane', timeMs: 900_000 })).stats;
  assert.equal(s.best['walk:pro'], 500_000);
  assert.equal(s.best['walk:insane'], 900_000);
  assert.equal(bestForMode(s, 'walk'), 500_000);
  assert.equal(bestForMode(s, 'drive'), null);
  assert.equal(s.completed, 4);
  assert.equal(s.discovered.length, 3, 'unique destinations only');
});

test('manual verification counts as completed but never as a record', () => {
  const r = recordResult(emptyStats(), result({ verified: 'manual', timeMs: 1 }));
  assert.equal(r.stats.completed, 1);
  assert.equal(r.isRecord, false);
  assert.equal(r.eligible, false);
  assert.equal(r.stats.best['walk:pro'], undefined);
});

test('recordResult does not mutate its input', () => {
  const s = emptyStats();
  recordResult(s, result());
  assert.deepEqual(s, emptyStats());
});

test('abandon increments only abandoned', () => {
  const s = recordAbandon(emptyStats());
  assert.equal(s.abandoned, 1);
  assert.equal(s.completed, 0);
});

test('history is capped', () => {
  let s = emptyStats();
  for (let i = 0; i < 40; i++) s = recordResult(s, result({ destId: `n${i}` })).stats;
  assert.equal(s.history.length, 30);
});

test('store round-trips settings and stats, with defaults', () => {
  const store = createStore(memoryStorage());
  assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS);
  store.saveSettings({ ...DEFAULT_SETTINGS, units: 'imperial' });
  assert.equal(store.getSettings().units, 'imperial');
  const s = recordResult(emptyStats(), result()).stats;
  store.saveStats(s);
  assert.deepEqual(store.getStats(), s);
});

test('active rally is scrambled at rest and survives a round trip', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  const active = { phase: 'rally', startedAt: 123, rally: { destination: { name: 'Café Ümlaut Secret', lat: 1, lon: 2 } } };
  store.saveActive(active);
  const raw = mem.getItem('blindrally:v1:active');
  assert.ok(!raw.includes('Secret'), 'destination name not visible in storage');
  assert.deepEqual(store.getActive(), active);
  store.clearActive();
  assert.equal(store.getActive(), null);
});

test('corrupt storage values fall back gracefully', () => {
  const mem = memoryStorage();
  mem.setItem('blindrally:v1:stats', '{not json');
  mem.setItem('blindrally:v1:active', '"%%%"');
  const store = createStore(mem);
  assert.deepEqual(store.getStats(), emptyStats());
  assert.equal(store.getActive(), null);
});

test('scramble/unscramble are inverses', () => {
  const o = { a: [1, 2, { b: 'ü ✓' }] };
  assert.deepEqual(unscramble(scramble(o)), o);
});
