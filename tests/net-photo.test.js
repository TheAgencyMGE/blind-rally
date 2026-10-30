import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { politeFetch, fetchFromMirrors, _resetSpacing } from '../public/js/net.js';
import { findPhoto, commonsFileFromTags, parseWikipediaTag } from '../public/js/photo.js';

beforeEach(() => _resetSpacing());

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('politeFetch maps HTTP errors and rate limits', async () => {
  await assert.rejects(politeFetch('wiki', 'x', { fetchImpl: async () => ({ ok: false, status: 429 }) }), (e) => e.kind === 'rate');
  _resetSpacing();
  await assert.rejects(politeFetch('wiki', 'x', { fetchImpl: async () => ({ ok: false, status: 500 }) }), (e) => e.kind === 'http');
  _resetSpacing();
  await assert.rejects(politeFetch('wiki', 'x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), (e) => e.kind === 'network');
  _resetSpacing();
  await assert.rejects(politeFetch('wiki', 'x', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } }) }), (e) => e.kind === 'parse');
});

test('politeFetch spaces out calls to the same service', async () => {
  const t0 = Date.now();
  await politeFetch('wiki', 'a', { fetchImpl: okJson(1) });
  await politeFetch('wiki', 'b', { fetchImpl: okJson(2) });
  assert.ok(Date.now() - t0 >= 190, 'second call waited for the gap');
});

test('fetchFromMirrors falls through to the next mirror', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'm1') return { ok: false, status: 504 };
    return { ok: true, status: 200, json: async () => ({ from: url }) };
  };
  const res = await fetchFromMirrors('wiki', ['m1', 'm2'], { fetchImpl });
  assert.deepEqual(res, { from: 'm2' });
  assert.deepEqual(seen, ['m1', 'm2']);
});

test('photo tag parsing', () => {
  assert.equal(commonsFileFromTags({ wikimedia_commons: 'File:Space Needle.jpg' }), 'Space Needle.jpg');
  assert.equal(commonsFileFromTags({ image: 'https://commons.wikimedia.org/wiki/File:Pike%20Place.jpg' }), 'Pike Place.jpg');
  assert.equal(commonsFileFromTags({ image: 'https://example.com/x.jpg' }), null);
  assert.deepEqual(parseWikipediaTag('de:Brandenburger Tor'), { lang: 'de', title: 'Brandenburger Tor' });
  assert.deepEqual(parseWikipediaTag('Space Needle'), { lang: 'en', title: 'Space Needle' });
});

test('findPhoto resolves wikidata image + wikipedia extract', async () => {
  const fetchJson = async (svc, url) => {
    if (url.includes('wikidata')) {
      return { entities: { Q1: { claims: { P18: [{ mainsnak: { datavalue: { value: 'View.jpg' } } }] }, sitelinks: { enwiki: { title: 'Hidden View' } } } } };
    }
    return { type: 'standard', extract: 'A lovely view.', content_urls: { mobile: { page: 'https://en.m.wikipedia.org/wiki/Hidden_View' } } };
  };
  const p = await findPhoto({ wikidata: 'Q1' }, { fetchJson });
  assert.match(p.image, /Special:FilePath\/View\.jpg/);
  assert.equal(p.extract, 'A lovely view.');
  assert.equal(p.link, 'https://en.m.wikipedia.org/wiki/Hidden_View');
});

test('findPhoto never throws and returns null when nothing is available', async () => {
  assert.equal(await findPhoto({}, { fetchJson: async () => ({}) }), null);
  assert.equal(await findPhoto({ wikidata: 'Q1' }, { fetchJson: async () => { throw new Error('down'); } }), null);
});
