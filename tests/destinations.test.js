import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverpassQuery, parseOverpass, rankCandidates, attachLandmarks } from '../public/js/destinations.js';
import { haversine } from '../public/js/geo.js';
import { BASE, offset, fakeRng } from './helpers.js';

const el = (id, p, tags, type = 'node') =>
  type === 'node' ? { type, id, lat: p.lat, lon: p.lon, tags } : { type, id, center: { lat: p.lat, lon: p.lon }, tags };

test('query targets the right area and requires names', () => {
  const q = buildOverpassQuery(BASE, 1500);
  assert.match(q, /\[out:json\]/);
  assert.match(q, /around:1500,47\.609700,-122\.342200/);
  assert.match(q, /\[name\]\["leisure"~"\^\(park\|/);
  assert.match(q, /out center tags/);
});

test('parse keeps public named places, drops private/unnamed/plaques/invalid', () => {
  const pois = parseOverpass({
    elements: [
      el(1, offset(BASE, 600, 0), { name: 'Victor Steinbrueck Park', leisure: 'park', wikidata: 'Q7926570' }, 'way'),
      el(2, offset(BASE, 700, 0), { leisure: 'park' }),
      el(3, offset(BASE, 800, 0), { name: 'Private Garden', leisure: 'garden', access: 'private' }),
      el(4, offset(BASE, 900, 0), { name: 'Plaque', historic: 'memorial', memorial: 'plaque' }),
      el(5, { lat: 0, lon: 0 }, { name: 'Null Island Museum', tourism: 'museum' }),
      el(6, offset(BASE, 500, 200), { name: 'Shell', amenity: 'fuel' }),
      el(7, offset(BASE, 650, 100), { name: 'Pier 62', man_made: 'pier' }),
      el(8, offset(BASE, 650, 100), { name: 'Random Shop', shop: 'shoes' }),
    ],
  });
  const byName = Object.fromEntries(pois.map((p) => [p.name, p]));
  assert.ok(byName['Victor Steinbrueck Park'].destination);
  assert.equal(byName['Victor Steinbrueck Park'].area, true);
  assert.equal(byName['Victor Steinbrueck Park'].tags.wikidata, 'Q7926570');
  assert.equal(byName['Private Garden'].destination, false, 'private kept only as a landmark');
  assert.equal(byName.Plaque.destination, false);
  assert.equal(byName.Shell.destination, false, 'fuel stations are landmarks only');
  assert.ok(byName['Pier 62'].destination);
  assert.equal(byName['Null Island Museum'], undefined);
  assert.equal(byName['Random Shop'], undefined);
  assert.equal(pois.length, 5);
});

test('parse tolerates empty or malformed responses', () => {
  assert.deepEqual(parseOverpass(null), []);
  assert.deepEqual(parseOverpass({}), []);
  assert.deepEqual(parseOverpass({ elements: [{ type: 'node', id: 1 }] }), []);
});

test('rankCandidates enforces distance band and avoid list, de-dupes names', () => {
  const pois = parseOverpass({
    elements: [
      el(1, offset(BASE, 100, 0), { name: 'Too Close Park', leisure: 'park' }),
      el(2, offset(BASE, 800, 0), { name: 'Good Park', leisure: 'park' }),
      el(3, offset(BASE, 0, 900), { name: 'Good Museum', tourism: 'museum' }),
      el(4, offset(BASE, 5000, 0), { name: 'Too Far Viewpoint', tourism: 'viewpoint' }),
      el(5, offset(BASE, -900, 0), { name: 'Starbucks', amenity: 'cafe' }),
      el(6, offset(BASE, -950, 100), { name: 'Starbucks', amenity: 'cafe' }),
      el(7, offset(BASE, 700, 700), { name: 'Visited Fountain', amenity: 'fountain' }),
    ],
  });
  const ranked = rankCandidates(pois, BASE, { minR: 500, maxR: 1500, avoidIds: ['n7'], rng: fakeRng(1) });
  assert.deepEqual(ranked.map((p) => p.name).sort(), ['Good Museum', 'Good Park', 'Starbucks']);
  for (const p of ranked) {
    const d = haversine(BASE, p);
    assert.ok(d >= 500 && d <= 1500);
    assert.ok(Math.abs(p.straightDistance - d) < 0.001);
  }
});

test('rankCandidates favours higher-weight places over many draws', () => {
  const pois = parseOverpass({
    elements: [
      el(1, offset(BASE, 800, 0), { name: 'Big Viewpoint', tourism: 'viewpoint' }), // weight 5
      el(2, offset(BASE, 0, 800), { name: 'Corner Cafe', amenity: 'cafe' }), // weight 1.5
    ],
  });
  const rng = fakeRng(7);
  let viewFirst = 0;
  for (let i = 0; i < 500; i++) {
    if (rankCandidates(pois, BASE, { minR: 100, maxR: 2000, rng })[0].name === 'Big Viewpoint') viewFirst++;
  }
  assert.ok(viewFirst > 300, `viewpoint first ${viewFirst}/500`);
});

test('attachLandmarks adds nearby names but never the destination', () => {
  const corner = offset(BASE, 300, 0);
  const pois = [
    { id: 'n1', name: "Joe's Coffee", ...offset(corner, 10, 10) },
    { id: 'n2', name: 'SECRET DESTINATION', ...offset(corner, 2, 2) },
  ];
  const steps = [
    { type: 'depart', location: BASE },
    { type: 'turn', location: corner },
    { type: 'turn', location: offset(BASE, 900, 900) },
    { type: 'arrive', location: corner },
  ];
  const out = attachLandmarks(steps, pois, 'n2');
  assert.equal(out[1].landmark, "Joe's Coffee");
  assert.equal(out[2].landmark, undefined);
  assert.equal(out[0].landmark, undefined);
  assert.equal(out[3].landmark, undefined);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('parseWikiGeosearch filters admin areas and private-ish buildings, strips disambiguators', async () => {
  const { parseWikiGeosearch, wikiGeosearchUrl } = await import('../public/js/destinations.js');
  const pois = parseWikiGeosearch({
    query: {
      geosearch: [
        { pageid: 1, title: 'Maíz (restaurant)', lat: 47.61, lon: -122.34, type: 'landmark' },
        { pageid: 2, title: 'Colonnade Hotel (Seattle)', lat: 47.61, lon: -122.34, type: null },
        { pageid: 3, title: 'Belltown', lat: 47.61, lon: -122.34, type: 'city' },
        { pageid: 4, title: 'Victor Steinbrueck Park', lat: 47.61, lon: -122.34, type: null },
        { pageid: 5, title: 'Broken', lat: 999, lon: 0 },
        { pageid: 6, title: 'Central Saloon', lat: 47.61, lon: -122.34, type: 'landmark' },
      ],
    },
  }, 'en');
  const by = Object.fromEntries(pois.map((p) => [p.name, p.destination]));
  assert.deepEqual(by, { 'Maíz': false, 'Colonnade Hotel': false, Belltown: false, 'Victor Steinbrueck Park': true, 'Central Saloon': false });
  assert.equal(pois[0].tags.wikipedia, 'en:Maíz (restaurant)');
  assert.equal(pois[0].destination, false, 'restaurants are landmarks, not destinations');
  assert.match(wikiGeosearchUrl('https://en.wikipedia.org/w/api.php', BASE, 50_000), /gsradius=10000/);
});

test('areas, roads and scenic spots are destinations too', () => {
  const pois = parseOverpass({
    elements: [
      el(1, offset(BASE, 800, 0), { name: 'Golden Gardens Beach', natural: 'beach' }, 'way'),
      el(2, offset(BASE, 0, 800), { name: 'Post Alley', highway: 'pedestrian' }, 'way'),
      el(3, offset(BASE, -800, 0), { name: 'Belltown', place: 'neighbourhood' }),
      el(4, offset(BASE, 0, -800), { name: 'Alki Drive', highway: 'secondary', scenic: 'yes' }, 'way'),
      el(5, offset(BASE, 500, 500), { name: 'Snoqualmie Falls', natural: 'waterfall' }),
      el(6, offset(BASE, 500, -500), { name: 'Some Cliff', natural: 'cliff' }),
    ],
  });
  const labels = Object.fromEntries(pois.map((p) => [p.name, p.destination && p.label]));
  assert.deepEqual(labels, {
    'Golden Gardens Beach': 'Beach',
    'Post Alley': 'Street',
    Belltown: 'Neighbourhood',
    'Alki Drive': 'Scenic road',
    'Snoqualmie Falls': 'Waterfall',
  });
  assert.match(buildOverpassQuery(BASE, 1000), /"natural"~"\^\(beach\|peak\|waterfall/);
});
