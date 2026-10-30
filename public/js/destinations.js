// Destination discovery from OpenStreetMap via the Overpass API.
// Pure parsing/scoring functions are exported separately so they can be unit tested.

import { haversine, isValidCoord } from './geo.js';

// Each rule: OSM key, allowed values, label (revealed only on arrival), weight (how good a
// destination it is). Destinations fall into four groups: places, areas, roads and scenic spots.
const RULES = [
  // Places
  { key: 'tourism', values: { attraction: 5, viewpoint: 5, museum: 5, gallery: 4, artwork: 3, zoo: 4, aquarium: 4, picnic_site: 2 }, label: { attraction: 'Attraction', viewpoint: 'Viewpoint', museum: 'Museum', gallery: 'Gallery', artwork: 'Public art', zoo: 'Zoo', aquarium: 'Aquarium', picnic_site: 'Picnic spot' } },
  { key: 'historic', values: { monument: 4, memorial: 3, castle: 5, fort: 4, ruins: 4, lighthouse: 5, archaeological_site: 3, landmark: 4 }, label: { monument: 'Monument', memorial: 'Memorial', castle: 'Castle', fort: 'Fort', ruins: 'Ruins', lighthouse: 'Lighthouse', archaeological_site: 'Historic site', landmark: 'Landmark' } },
  { key: 'man_made', values: { lighthouse: 5, pier: 4, windmill: 4, bridge: 4, tower: 2 }, label: { lighthouse: 'Lighthouse', pier: 'Pier', windmill: 'Windmill', bridge: 'Bridge', tower: 'Tower' } },
  { key: 'amenity', values: { fountain: 3, library: 3, theatre: 3, arts_centre: 3, marketplace: 3, townhall: 3, cinema: 2, cafe: 1.5, ice_cream: 2 }, label: { fountain: 'Fountain', library: 'Library', theatre: 'Theatre', arts_centre: 'Arts centre', marketplace: 'Market', townhall: 'Town hall', cinema: 'Cinema', cafe: 'Café', ice_cream: 'Ice cream' } },
  // Areas
  { key: 'leisure', values: { park: 4, garden: 4, nature_reserve: 4, marina: 3, common: 3 }, label: { park: 'Park', garden: 'Garden', nature_reserve: 'Nature reserve', marina: 'Marina', common: 'Common' } },
  { key: 'landuse', values: { recreation_ground: 3, village_green: 3 }, label: { recreation_ground: 'Open space', village_green: 'Village green' } },
  { key: 'place', values: { square: 4, neighbourhood: 2, quarter: 2 }, label: { square: 'Plaza', neighbourhood: 'Neighbourhood', quarter: 'Quarter' } },
  // Roads
  { key: 'highway', values: { pedestrian: 3 }, label: { pedestrian: 'Street' } },
  { key: 'scenic', values: { yes: 4 }, label: { yes: 'Scenic road' } },
  // Scenic
  { key: 'natural', values: { beach: 5, peak: 4, waterfall: 5, spring: 2, cape: 4 }, label: { beach: 'Beach', peak: 'Summit', waterfall: 'Waterfall', spring: 'Spring', cape: 'Headland' } },
];

// Named things that make good landmarks in directions but aren't destinations.
const LANDMARK_ONLY = {
  amenity: ['fuel', 'pharmacy', 'bank', 'restaurant', 'fast_food', 'post_office', 'school', 'hospital', 'place_of_worship', 'pub', 'bar'],
  shop: ['supermarket', 'convenience', 'mall', 'department_store'],
};

const BLOCKED_ACCESS = new Set(['private', 'no', 'customers', 'permit', 'military', 'delivery', 'agricultural', 'forestry']);
const BLOCKED_MEMORIALS = new Set(['plaque', 'stolperstein', 'bench', 'blue_plaque', 'tree', 'grave']);

function regex(values) {
  return `^(${values.join('|')})$`;
}

/** Build one Overpass QL query that returns destination candidates and landmarks. */
export function buildOverpassQuery(center, radius) {
  const r = Math.round(radius);
  const at = `(around:${r},${center.lat.toFixed(6)},${center.lon.toFixed(6)})`;
  const lines = RULES.map((rule) => `  nwr${at}[name]["${rule.key}"~"${regex(Object.keys(rule.values))}"];`);
  for (const [key, vals] of Object.entries(LANDMARK_ONLY)) {
    lines.push(`  node${at}[name]["${key}"~"${regex(vals)}"];`);
  }
  return `[out:json][timeout:7];\n(\n${lines.join('\n')}\n);\nout center tags qt 1500;`;
}

function classify(tags) {
  let best = null;
  for (const rule of RULES) {
    const v = tags[rule.key];
    if (v && rule.values[v] != null) {
      const cand = { kind: `${rule.key}=${v}`, label: rule.label[v], weight: rule.values[v] };
      if (!best || cand.weight > best.weight) best = cand;
    }
  }
  if (best) return { ...best, destination: true };
  for (const [key, vals] of Object.entries(LANDMARK_ONLY)) {
    if (vals.includes(tags[key])) return { kind: `${key}=${tags[key]}`, label: null, weight: 0, destination: false };
  }
  return null;
}

function isPubliclyAccessible(tags) {
  if (BLOCKED_ACCESS.has(tags.access)) return false;
  if (tags.disused === 'yes' || tags.abandoned === 'yes' || tags['disused:amenity']) return false;
  if (tags.military || tags.landuse === 'military') return false;
  if (tags.historic === 'memorial' && BLOCKED_MEMORIALS.has(tags.memorial)) return false;
  if (tags['garden:type'] === 'residential' || tags['garden:type'] === 'private') return false;
  return true;
}

/** Turn an Overpass JSON response into a clean list of POIs. */
export function parseOverpass(json) {
  const out = [];
  const seen = new Set();
  for (const el of json?.elements ?? []) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? '').trim();
    if (!name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const point = { lat, lon };
    if (!isValidCoord(point)) continue;
    const cls = classify(tags);
    if (!cls) continue;
    const accessible = isPubliclyAccessible(tags);
    const id = `${el.type?.[0] ?? 'x'}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      lat,
      lon,
      kind: cls.kind,
      label: cls.label,
      weight: cls.weight,
      destination: cls.destination && accessible,
      area: el.type !== 'node',
      tags: pick(tags, ['wikidata', 'wikipedia', 'image', 'wikimedia_commons', 'addr:street', 'addr:housenumber', 'addr:city', 'description']),
    });
  }
  return out;
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj[k]) o[k] = obj[k];
  return o;
}

// ---- Fallback source: Wikipedia geosearch (used when every Overpass mirror is down/busy).
// Articles with coordinates are notable by definition and usually public; we still drop
// administrative areas and building types that are typically private or restricted.
const WIKI_OK_TYPES = new Set(['landmark', null, undefined]);
const WIKI_BLOCKED_TITLE = /\b(hotel|motel|apartments?|condominiums?|lofts?|residence|house|mansion|school|academy|university|college|hospital|clinic|prison|jail|cemetery|headquarters|offices?|tower|building|neighbou?rhood|district|station|airport|base|plant|reservoir|factory|dam|saloon|tavern|brewery|brewing|pub|bar|grill|lounge|nightclub|casino|distillery)\b/i;

// Disambiguators that mark bars, restaurants and other places that aren't great or all-ages destinations.
const WIKI_BLOCKED_KIND = /\((restaurant|bar|pub|nightclub|club|hotel|company|business|store|shop)/i;

export function wikiGeosearchUrl(api, center, radius, limit = 100) {
  const r = Math.min(10000, Math.max(10, Math.round(radius)));
  return `${api}?action=query&list=geosearch&gscoord=${center.lat.toFixed(6)}|${center.lon.toFixed(6)}&gsradius=${r}&gslimit=${limit}&gsprop=type&format=json&origin=*`;
}

export function parseWikiGeosearch(json, lang = 'en') {
  const out = [];
  for (const g of json?.query?.geosearch ?? []) {
    const p = { lat: g.lat, lon: g.lon };
    if (!isValidCoord(p) || !g.title) continue;
    const ok = WIKI_OK_TYPES.has(g.type) && !WIKI_BLOCKED_TITLE.test(g.title) && !WIKI_BLOCKED_KIND.test(g.title);
    out.push({
      id: `wp${lang}${g.pageid}`,
      name: g.title.replace(/\s*\([^)]*\)\s*$/, ''), // "Maíz (restaurant)" → "Maíz"
      lat: g.lat,
      lon: g.lon,
      kind: 'wikipedia',
      label: 'Landmark',
      weight: 2.5,
      destination: ok,
      area: false,
      tags: { wikipedia: `${lang}:${g.title}` },
    });
  }
  return out;
}

/**
 * Order destination candidates: within [minR, maxR] straight-line distance, not recently used,
 * de-duplicated by name, in weighted-random order (Efraimidis–Spirakis).
 */
export function rankCandidates(pois, start, { minR, maxR, avoidIds = [], rng = Math.random, limit = 12 }) {
  const avoid = new Set(avoidIds);
  const names = new Set();
  const keyed = [];
  for (const p of pois) {
    if (!p.destination || avoid.has(p.id)) continue;
    const d = haversine(start, p);
    if (d < minR || d > maxR) continue;
    const nameKey = p.name.toLowerCase();
    if (names.has(nameKey)) continue; // chains / duplicated features
    names.add(nameKey);
    const u = Math.max(rng(), 1e-12);
    keyed.push({ p: { ...p, straightDistance: d }, k: Math.pow(u, 1 / p.weight) });
  }
  keyed.sort((a, b) => b.k - a.k);
  return keyed.slice(0, limit).map((x) => x.p);
}

/** Landmarks near each maneuver, excluding the destination itself (no spoilers). */
export function attachLandmarks(steps, pois, destinationId, maxDist = 45) {
  const pool = pois.filter((p) => p.id !== destinationId);
  return steps.map((s) => {
    if (s.type === 'depart' || s.type === 'arrive' || !s.location) return s;
    let best = null;
    let bestD = maxDist;
    for (const p of pool) {
      const d = haversine(s.location, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { ...s, landmark: best.name } : s;
  });
}
