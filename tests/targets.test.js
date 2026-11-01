// Destination types: random spots and cities (landmarks are covered in rally.test.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateRally, clearPoiCache, randomSpot, spotName, cityHint } from '../public/js/rally.js';
import { buildCityQuery, parseCities, parseWikiCities } from '../public/js/destinations.js';
import { scoreRally } from '../public/js/score.js';
import { recordResult, emptyStats, bestKey, bestForMode } from '../public/js/storage.js';
import { CITY, MIN_RADIUS_FRACTION } from '../public/js/config.js';
import { ServiceError } from '../public/js/net.js';
import { haversine } from '../public/js/geo.js';
import { BASE, offset, fakeRng } from './helpers.js';
import { osrmRoute, osrmStep } from './fixtures.js';

beforeEach(() => clearPoiCache());

function mockNet({ overpass, wiki, route = (s, e) => osrmRoute(s, e) } = {}) {
  const calls = { overpass: 0, routing: 0, wiki: 0, urls: [] };
  const fetchJson = async (service, urls, opts) => {
    calls[service]++;
    calls.urls.push(urls[0]);
    if (service === 'overpass') {
      const r = typeof overpass === 'function' ? overpass(decodeURIComponent(opts.init.body)) : overpass;
      if (r instanceof Error || r == null) throw r ?? new ServiceError('http', 'down');
      return r;
    }
    if (service === 'wiki') {
      if (wiki instanceof Error || wiki == null) throw wiki ?? new ServiceError('http', 'down');
      return wiki;
    }
    const m = urls[0].match(/\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/);
    const r = route({ lon: +m[1], lat: +m[2] }, { lon: +m[3], lat: +m[4] }, calls.routing);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchJson, calls };
}

const base = { start: BASE, mode: 'walk', difficulty: 'pro', radius: 1500, rng: fakeRng(5), now: () => 1_000 };

// ---------------------------------------------------------------- random

test('random spots land in the ring around the start', () => {
  const rng = fakeRng(9);
  for (let i = 0; i < 200; i++) {
    const d = haversine(BASE, randomSpot(BASE, 500, 1500, rng));
    assert.ok(d >= 499 && d <= 1501, `distance ${d}`);
  }
});

test('random rally needs no place data at all', async () => {
  const { fetchJson, calls } = mockNet({ overpass: new ServiceError('http', 'down') });
  const r = await generateRally({ ...base, target: 'random', fetchJson });
  assert.equal(calls.overpass, 0);
  assert.equal(r.target, 'random');
  assert.equal(r.destination.label, 'Random spot');
  assert.equal(r.destination.name, 'Pine Street'); // named after the road it ends on
  assert.equal(r.arrivalTargets.length, 1);
  assert.ok(r.route.steps.length >= 2);
  assert.ok(r.route.steps.some((s) => s.street === 'Pine Street'), 'directions keep the street names');
  const d = haversine(BASE, r.destination);
  assert.ok(d >= 1500 * MIN_RADIUS_FRACTION * 0.99 && d <= 1501);
});

test('random rally retries pins that fall in water or private land', async () => {
  const { fetchJson, calls } = mockNet({ route: (s, e, n) => osrmRoute(s, e, { endSnap: n <= 3 ? 900 : 10 }) });
  const r = await generateRally({ ...base, target: 'random', fetchJson });
  assert.equal(calls.routing, 4);
  assert.equal(r.target, 'random');
});

test('random rally settles for the least-bad route rather than failing', async () => {
  // Every route is a long maze: not ideal, but reachable. Landmark mode would give up here.
  const maze = (s, e) => {
    const json = osrmRoute(s, e);
    const steps = json.routes[0].legs[0].steps;
    for (let i = 0; i < 30; i++) steps.splice(1, 0, osrmStep('turn', i % 2 ? 'left' : 'right', `Street ${i}`, s, 30));
    return json;
  };
  const { fetchJson, calls } = mockNet({ route: maze });
  const r = await generateRally({ ...base, target: 'random', fetchJson });
  assert.equal(calls.routing, 8);
  assert.equal(r.target, 'random');
});

test('random rally still reports a start point off the network', async () => {
  const { fetchJson } = mockNet({ route: (s, e) => osrmRoute(s, e, { startSnap: 900 }) });
  await assert.rejects(generateRally({ ...base, target: 'random', fetchJson }), (e) => e.kind === 'start');
});

test('spotName uses the last named road, without its ref', () => {
  assert.equal(spotName([{ street: 'Pike Street' }, { street: 'Aurora Avenue (SR 99)' }, { street: '' }]), 'Aurora Avenue');
  assert.equal(spotName([{ street: '' }]), 'Somewhere unnamed');
});

// ---------------------------------------------------------------- cities

const cityEl = (id, p, tags) => ({ type: 'node', id, lat: p.lat, lon: p.lon, tags });
const cities = () => ({
  elements: [
    cityEl(1, offset(BASE, 30000, 20000), { name: 'Farville', place: 'town', population: '24,000', wikidata: 'Q9' }),
    cityEl(2, offset(BASE, 2000, 0), { name: 'Hometown', place: 'city', population: '700000' }), // too close
    cityEl(3, offset(BASE, -25000, 5000), { name: 'Tinyburg', place: 'hamlet' }), // not a city type
    cityEl(4, offset(BASE, 0, 90000), { name: 'Outta Range', place: 'city' }),
  ],
});

test('city query asks only for the mode\'s place types', () => {
  const q = buildCityQuery(BASE, 40000, CITY.places.drive);
  assert.match(q, /around:40000/);
  assert.match(q, /"place"~"\^\(city\|town\)\$"/);
  assert.match(q, /out body/, 'nodes need their coordinates: "out tags" drops them');
});

test('parseCities keeps allowed settlements with a place-sized label', () => {
  const out = parseCities(cities(), CITY.places.drive);
  assert.deepEqual(out.map((c) => c.name).sort(), ['Farville', 'Hometown', 'Outta Range']);
  const far = out.find((c) => c.name === 'Farville');
  assert.equal(far.label, 'Town');
  assert.equal(far.tags.wikidata, 'Q9');
  assert.ok(far.weight > 0);
});

test('city rally picks a town in range and gives only vague directions', async () => {
  const route = (s, e) => {
    const json = osrmRoute(s, e, { distance: 42000 });
    const steps = json.routes[0].legs[0].steps;
    steps[0].distance = 1000;
    steps[1].ref = 'I 5';
    steps[1].name = 'Interstate 5';
    steps[1].distance = 35000;
    return json;
  };
  const { fetchJson, calls } = mockNet({ overpass: cities(), route });
  const r = await generateRally({ ...base, mode: 'drive', radius: 40000, target: 'city', fetchJson });
  assert.equal(calls.overpass, 1);
  assert.equal(r.target, 'city');
  assert.equal(r.destination.name, 'Farville');
  assert.equal(r.route.steps.length, 0, 'no turn-by-turn');
  assert.equal(r.arrivalRadius, CITY.arrivalRadius.town);
  assert.equal(r.hint.direction, 'northeast');
  assert.deepEqual(r.hint.roads, ['I 5']);
  assert.ok(r.route.geometry.length > 1, 'route kept for peeks and the replay');
});

test('city rally falls back to Wikipedia settlements when Overpass is down', async () => {
  const wiki = {
    query: {
      geosearch: [
        { pageid: 7, title: 'Faraway, Washington', lat: offset(BASE, 20000, 0).lat, lon: BASE.lon, type: 'city' },
        { pageid: 8, title: 'Some Mountain', lat: offset(BASE, 21000, 0).lat, lon: BASE.lon, type: 'mountain' },
      ],
    },
  };
  const { fetchJson, calls } = mockNet({ overpass: null, wiki });
  const r = await generateRally({ ...base, mode: 'drive', radius: 40000, target: 'city', fetchJson });
  assert.ok(calls.wiki > 0);
  assert.equal(r.destination.name, 'Faraway');
});

test('city rally with nothing in range says so', async () => {
  const { fetchJson } = mockNet({ overpass: { elements: [] } });
  await assert.rejects(generateRally({ ...base, mode: 'drive', radius: 40000, target: 'city', fetchJson }), (e) => e.kind === 'empty' && /towns or cities/.test(e.message));
});

test('parseWikiCities keeps only settlements and trims the region', () => {
  const out = parseWikiCities({ query: { geosearch: [{ pageid: 1, title: 'Kent, Washington', lat: 47.38, lon: -122.23, type: 'city' }, { pageid: 2, title: 'Mt Si', lat: 47.4, lon: -121.7, type: 'mountain' }] } });
  assert.deepEqual(out.map((c) => c.name), ['Kent']);
});

test('cityHint picks the roads that carry the trip, in travel order', () => {
  const dest = offset(BASE, -20000, 0);
  const steps = [
    { street: 'Pike Street', distance: 500, type: 'depart' },
    { street: 'Interstate 5 (I 5)', distance: 15000, type: 'turn' },
    { street: 'Main Street', distance: 300, type: 'turn' },
    { street: 'Highway 18 (SR 18)', distance: 4000, type: 'turn' },
    { street: 'Elm Street', distance: 0, type: 'arrive' },
  ];
  const h = cityHint(BASE, dest, steps, 19800);
  assert.equal(h.direction, 'south');
  assert.deepEqual(h.roads, ['I 5', 'SR 18']);
  assert.ok(Math.abs(h.straight - 20000) < 50);
});

test('unknown destination type is rejected', async () => {
  const { fetchJson } = mockNet();
  await assert.rejects(generateRally({ ...base, target: 'moon', fetchJson }), (e) => e.kind === 'invalid');
});

// ---------------------------------------------------------------- scoring + stats

test('city scoring ignores route accuracy and wrong turns', () => {
  const inputs = { timeMs: 1_800_000, etaSec: 1800, routeDistance: 30000, travelled: 40000, accuracy: 10, wrongTurns: 9, peeks: 0, difficulty: 'rookie' };
  const free = scoreRally({ ...inputs, freeRoute: true });
  assert.ok(!free.parts.some((p) => p.key === 'accuracy' || p.key === 'wrongTurns'));
  assert.ok(!free.parts.some((p) => p.key === 'distance'), '33% extra is within the city grace');
  assert.ok(free.parts.some((p) => p.key === 'clean'));
  assert.ok(scoreRally(inputs).score < free.score);
});

test('best times are kept per destination type', () => {
  const run = (target, timeMs) => ({ date: 1, timeMs, mode: 'walk', target, difficulty: 'pro', name: 'X', verified: 'gps' });
  let s = recordResult(emptyStats(), run('landmark', 600_000)).stats;
  s = recordResult(s, run('city', 3_600_000)).stats;
  const r = recordResult(s, run('random', 900_000));
  assert.equal(r.isRecord, true, 'first random run is its own record');
  s = r.stats;
  assert.equal(s.best[bestKey('walk', 'pro')], 600_000, 'landmark key unchanged from older versions');
  assert.equal(s.best[bestKey('walk', 'pro', 'city')], 3_600_000);
  assert.equal(bestForMode(s, 'walk'), 600_000);
  assert.equal(bestForMode(s, 'walk', 'city'), 3_600_000);
  assert.equal(s.history[0].target, 'random');
});
