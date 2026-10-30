// Route generation end to end, with the network mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateRally, rejectRoute, clearPoiCache } from '../public/js/rally.js';
import { ServiceError } from '../public/js/net.js';
import { haversine } from '../public/js/geo.js';
import { BASE, offset, fakeRng } from './helpers.js';
import { osrmRoute, overpassResponse } from './fixtures.js';

beforeEach(() => clearPoiCache());

function mockNet({ overpass = overpassResponse(), route = (s, e) => osrmRoute(s, e) } = {}) {
  const calls = { overpass: 0, routing: 0 };
  const fetchJson = async (service, urls) => {
    calls[service]++;
    if (service === 'overpass') {
      if (overpass instanceof Error) throw overpass;
      return overpass;
    }
    const m = urls[0].match(/\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/);
    const s = { lon: +m[1], lat: +m[2] };
    const e = { lon: +m[3], lat: +m[4] };
    const r = route(s, e, calls.routing);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchJson, calls };
}

const base = { start: BASE, mode: 'walk', difficulty: 'pro', radius: 1500, rng: fakeRng(3), now: () => 1_000 };

test('generates a rally to a real public destination within the radius', async () => {
  const { fetchJson, calls } = mockNet();
  const stages = [];
  const r = await generateRally({ ...base, fetchJson, onProgress: (s) => stages.push(s) });
  assert.deepEqual(stages, ['places', 'routing']);
  assert.ok(['Hidden Viewpoint', 'Lakeside Park'].includes(r.destination.name));
  const d = haversine(BASE, r.destination);
  assert.ok(d >= 1500 * 0.35 && d <= 1500);
  assert.equal(r.mode, 'walk');
  assert.equal(r.difficulty, 'pro');
  assert.equal(r.arrivalTargets.length, 2);
  assert.ok(r.route.steps.length >= 2);
  assert.equal(calls.overpass, 1);
  // Landmarks come from the same POI set, never the destination itself.
  assert.ok(r.route.steps.every((s) => s.landmark !== r.destination.name));
  assert.ok(!r.route.steps.some((s) => s.text.includes(r.destination.name)), 'directions never name the destination');
});

test('cafes and banks too close to start are never destinations', async () => {
  const { fetchJson } = mockNet();
  for (let i = 0; i < 10; i++) {
    clearPoiCache();
    const r = await generateRally({ ...base, rng: fakeRng(i + 10), fetchJson });
    assert.ok(!['Corner Coffee', 'Big Bank'].includes(r.destination.name));
  }
});

test('discards unroutable candidates and tries the next', async () => {
  let n = 0;
  const { fetchJson, calls } = mockNet({
    route: (s, e) => (n++ === 0 ? { code: 'NoRoute', message: 'nope' } : osrmRoute(s, e)),
  });
  const r = await generateRally({ ...base, fetchJson });
  assert.ok(r.destination);
  assert.equal(calls.routing, 2);
});

test('discards destinations too far from any path (snap distance)', async () => {
  const { fetchJson } = mockNet({ route: (s, e) => osrmRoute(s, e, { endSnap: 5000 }) });
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => e.kind === 'empty');
});

test('discards absurd detours', async () => {
  const { fetchJson } = mockNet({ route: (s, e) => osrmRoute(s, e, { distance: 50_000 }) });
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => e.kind === 'empty');
});

test('start far from any road gives a specific message', async () => {
  const { fetchJson } = mockNet({ route: (s, e) => osrmRoute(s, e, { startSnap: 2000 }) });
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => e.kind === 'start' && /too far from any path/.test(e.message));
});

test('no places nearby → empty error suggesting a larger radius', async () => {
  const { fetchJson } = mockNet({ overpass: { elements: [] } });
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => e.kind === 'empty' && /larger radius/.test(e.message));
});

test('routing service outage surfaces as a service error after limited retries', async () => {
  const { fetchJson, calls } = mockNet({ route: () => new ServiceError('http', 'routing returned HTTP 503.') });
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => e.kind === 'http' && /Routing service unavailable/.test(e.message));
  assert.equal(calls.routing, 2, 'stops hammering after two failures');
});

test('invalid start coordinates are rejected before any network call', async () => {
  const { fetchJson, calls } = mockNet();
  await assert.rejects(generateRally({ ...base, start: { lat: 999, lon: 0 }, fetchJson }), (e) => e.kind === 'invalid');
  assert.equal(calls.overpass + calls.routing, 0);
});

test('recently visited destinations are avoided, but allowed if nothing else exists', async () => {
  const { fetchJson } = mockNet();
  const r = await generateRally({ ...base, avoidIds: ['n101'], fetchJson });
  assert.equal(r.destination.name, 'Lakeside Park');
  clearPoiCache();
  const r2 = await generateRally({ ...base, avoidIds: ['n101', 'w102'], fetchJson });
  assert.ok(['Hidden Viewpoint', 'Lakeside Park'].includes(r2.destination.name));
});

test('places are cached in memory for play-again in the same area', async () => {
  const { fetchJson, calls } = mockNet();
  await generateRally({ ...base, fetchJson });
  await generateRally({ ...base, fetchJson });
  assert.equal(calls.overpass, 1);
});

test('abort cancels generation', async () => {
  const ctrl = new AbortController();
  const fetchJson = async () => {
    ctrl.abort();
    throw new ServiceError('aborted', 'Cancelled');
  };
  await assert.rejects(generateRally({ ...base, fetchJson, signal: ctrl.signal }), (e) => e.kind === 'aborted');
});

test('rejectRoute rules', () => {
  const route = { endSnapDistance: 10, distance: 1200, steps: [1, 2, 3], endPoint: offset(BASE, 1, 1) };
  const opts = { mode: 'walk', minR: 500, maxR: 1500 };
  assert.equal(rejectRoute(route, { area: false }, opts), null);
  assert.equal(rejectRoute({ ...route, endSnapDistance: 150 }, { area: false }, opts), 'unreachable');
  assert.equal(rejectRoute({ ...route, endSnapDistance: 150 }, { area: true }, opts), null, 'parks get more snap slack');
  assert.equal(rejectRoute({ ...route, distance: 200 }, {}, opts), 'too-close');
  assert.equal(rejectRoute({ ...route, distance: 9000 }, {}, opts), 'too-far');
  assert.equal(rejectRoute({ ...route, steps: [1] }, {}, opts), 'trivial');
});

test('falls back to Wikipedia places when every Overpass mirror fails', async () => {
  const wikiCalls = [];
  const fetchJson = async (service, urls) => {
    if (service === 'overpass') throw new ServiceError('http', 'overpass returned HTTP 504.');
    if (service === 'wiki') {
      wikiCalls.push(urls[0]);
      return {
        query: {
          geosearch: [
            { pageid: 1, title: 'Waterfront Park', lat: offset(BASE, 800, 200).lat, lon: offset(BASE, 800, 200).lon, type: 'landmark' },
            { pageid: 2, title: 'Grand Hotel (Seattle)', lat: offset(BASE, 0, 900).lat, lon: offset(BASE, 0, 900).lon, type: 'landmark' },
            { pageid: 3, title: 'Seattle', lat: offset(BASE, -900, 0).lat, lon: offset(BASE, -900, 0).lon, type: 'city' },
          ],
        },
      };
    }
    const m = urls[0].match(/\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/);
    return osrmRoute({ lon: +m[1], lat: +m[2] }, { lon: +m[3], lat: +m[4] });
  };
  const r = await generateRally({ ...base, fetchJson, lang: 'en' });
  assert.equal(r.destination.name, 'Waterfront Park');
  assert.equal(r.destination.tags.wikipedia, 'en:Waterfront Park');
  assert.equal(wikiCalls.length, 5, 'centre + four ring samples');
  assert.ok(wikiCalls.every((u) => u.startsWith('https://en.wikipedia.org/w/api.php?action=query&list=geosearch')));
});

test('both place sources down → friendly busy error', async () => {
  const fetchJson = async () => { throw new ServiceError('timeout', 'slow'); };
  await assert.rejects(generateRally({ ...base, fetchJson }), (e) => /busy right now/.test(e.message));
});

test('hideName scrubs the destination from directions when it is a road', async () => {
  const { hideName } = await import('../public/js/rally.js');
  const steps = [
    { type: 'turn', text: 'Turn right onto Post Alley', street: 'Post Alley' },
    { type: 'turn', text: 'Turn left onto Pine Street', street: 'Pine Street', landmark: 'Post Alley Market' },
    { type: 'arrive', text: 'Arrive at the destination', street: 'Post Alley' },
  ];
  const out = hideName(steps, 'Post Alley');
  assert.ok(!JSON.stringify(out).includes('Post Alley'));
  assert.equal(out[1].street, 'Pine Street');
});
