// Rally generation: find real, public, routable destinations around the start point.

import { MODES, SERVICES, MIN_RADIUS_FRACTION, MAX_ROUTE_DETOUR, MAX_ROUTE_ATTEMPTS, MAX_ROUTE_STEPS, POI_CACHE_TTL_MS, RANDOM_ATTEMPTS, CITY, TARGETS } from './config.js';
import { buildOverpassQuery, parseOverpass, rankCandidates, attachLandmarks, wikiGeosearchUrl, parseWikiGeosearch, buildCityQuery, parseCities, parseWikiCities } from './destinations.js';
import { buildRouteUrl, parseRoute } from './routing.js';
import { fetchFromMirrors, ServiceError } from './net.js';
import { gridKey, isValidCoord, destinationPoint, haversine, bearing, compass } from './geo.js';

const poiCache = new Map(); // memory only

export function clearPoiCache() {
  poiCache.clear();
}

export async function fetchPois(start, radius, { signal, fetchJson = fetchFromMirrors, now = Date.now, rng = Math.random, lang = 'en' } = {}) {
  const key = `${gridKey(start, 3)}:${radius}`;
  const hit = poiCache.get(key);
  if (hit && now() - hit.at < POI_CACHE_TTL_MS) return hit.pois;
  let pois;
  try {
    const query = buildOverpassQuery(start, radius);
    const json = await fetchJson('overpass', SERVICES.overpass, {
      signal,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      },
    });
    pois = parseOverpass(json);
  } catch (err) {
    if (err.kind === 'aborted' || err.kind === 'offline') throw err;
    pois = await fetchWikiPois(start, radius, { signal, fetchJson, rng, lang });
  }
  poiCache.set(key, { at: now(), pois });
  return pois;
}

/**
 * Fallback: Wikipedia geosearch only returns the nearest N articles, so we sample the
 * start area (for landmarks) plus a few points out in the destination ring.
 */
export async function fetchWikiPois(start, radius, { signal, fetchJson = fetchFromMirrors, rng = Math.random, lang = 'en' } = {}) {
  const api = SERVICES.wikipediaApi(lang);
  const minR = radius * MIN_RADIUS_FRACTION;
  const ringDist = (minR + radius) / 2;
  const ringRadius = Math.min(10000, (radius - minR) / 2 + 100);
  const spin = rng() * 360;
  const centers = [{ c: start, r: Math.min(radius, 10000) }];
  for (let i = 0; i < 4; i++) centers.push({ c: destinationPoint(start, spin + i * 90, ringDist), r: ringRadius });
  const all = new Map();
  let failures = 0;
  for (const { c, r } of centers) {
    try {
      const json = await fetchJson('wiki', [wikiGeosearchUrl(api, c, r)], { signal });
      for (const p of parseWikiGeosearch(json, lang)) all.set(p.id, p);
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      failures++;
    }
  }
  if (failures === centers.length) {
    throw new ServiceError('http', 'The map data services are busy right now. Please try again in a minute.');
  }
  return [...all.values()];
}

/** Remove the destination's name from directions (e.g. when the destination is itself a road). */
export function hideName(steps, name) {
  const n = name.trim().toLowerCase();
  const leaks = (v) => Boolean(v) && (v.toLowerCase().includes(n) || n.includes(v.toLowerCase()));
  return steps.map((s) => {
    const out = { ...s };
    if (leaks(out.street)) {
      out.text = out.text.split(out.street).join('the road');
      out.street = '';
    }
    if (leaks(out.landmark)) delete out.landmark;
    return out;
  });
}

/** Validate a parsed route against the rules for a mode. Returns null if OK, else a reason. */
export function rejectRoute(route, candidate, { mode, minR, maxR }) {
  const cfg = MODES[mode];
  const snapLimit = candidate.area ? cfg.maxSnapDistance * 2.5 : cfg.maxSnapDistance;
  if (route.endSnapDistance != null && route.endSnapDistance > snapLimit) return 'unreachable';
  if (route.distance > maxR * MAX_ROUTE_DETOUR) return 'too-far';
  if (route.distance < minR * 0.7) return 'too-close';
  if (route.steps.length < 2) return 'trivial';
  if (route.steps.length > MAX_ROUTE_STEPS) return 'too-complex'; // unmemorable maze
  if (!isValidCoord(route.endPoint)) return 'invalid';
  return null;
}

/**
 * Generate a full rally. Throws ServiceError with a user-facing message on failure.
 * `target` is 'landmark' (default), 'random' or 'city' (see TARGETS in config.js).
 * `onProgress(stage)` receives 'places' | 'routing'.
 */
export async function generateRally(opts) {
  const { start, mode, target = 'landmark' } = opts;
  if (!isValidCoord(start)) throw new ServiceError('invalid', 'That starting point is not a valid location.');
  if (!MODES[mode]) throw new ServiceError('invalid', `Unknown travel mode: ${mode}`);
  if (!TARGETS[target]) throw new ServiceError('invalid', `Unknown destination type: ${target}`);
  const o = { avoidIds: [], onProgress: () => {}, fetchJson: fetchFromMirrors, rng: Math.random, now: Date.now, lang: 'en', ...opts, target };
  if (target === 'random') return generateRandomRally(o);
  if (target === 'city') return generateCityRally(o);
  return generateLandmarkRally(o);
}

const rallyId = (now, rng) => `${now().toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`;
const offNetworkMsg = (mode) => `Your start point is too far from any ${mode === 'walk' ? 'path' : 'road'}. Move closer to a street and try again.`;

async function generateLandmarkRally({ start, mode, difficulty, radius, avoidIds, signal, onProgress, fetchJson, rng, now, lang }) {
  const cfg = MODES[mode];
  const maxR = radius;
  const minR = Math.round(radius * MIN_RADIUS_FRACTION);

  onProgress('places');
  const pois = await fetchPois(start, maxR, { signal, fetchJson, now, rng, lang });
  let candidates = rankCandidates(pois, start, { minR, maxR, avoidIds, rng, limit: MAX_ROUTE_ATTEMPTS });
  if (!candidates.length && avoidIds.length) {
    // Small towns run out of fresh places — allow repeats rather than failing.
    candidates = rankCandidates(pois, start, { minR, maxR, rng, limit: MAX_ROUTE_ATTEMPTS });
  }
  if (!candidates.length) {
    throw new ServiceError('empty', 'No public landmarks found in range. Try a larger radius, or a Random spot instead.');
  }

  onProgress('routing');
  const bases = SERVICES.routing[cfg.osrmProfile];
  let serviceFailures = 0;
  let lastServiceErr = null;
  let startOffNetwork = 0;
  for (const cand of candidates) {
    if (signal?.aborted) throw new ServiceError('aborted', 'Cancelled');
    let route;
    try {
      const json = await fetchJson('routing', bases.map((b) => buildRouteUrl(b, start, cand)), { signal });
      route = parseRoute(json);
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      if (err.kind === 'no-route') continue;
      lastServiceErr = err;
      if (++serviceFailures >= 2) break;
      continue;
    }
    if (route.startSnapDistance != null && route.startSnapDistance > 400) {
      startOffNetwork++;
      continue;
    }
    if (rejectRoute(route, cand, { mode, minR, maxR })) continue;

    return {
      id: rallyId(now, rng),
      mode,
      target: 'landmark',
      difficulty,
      createdAt: now(),
      start: { lat: start.lat, lon: start.lon },
      destination: {
        id: cand.id,
        name: cand.name,
        label: cand.label,
        lat: cand.lat,
        lon: cand.lon,
        tags: cand.tags,
      },
      arrivalTargets: [
        { lat: cand.lat, lon: cand.lon },
        route.endPoint,
      ],
      route: {
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry,
        steps: hideName(attachLandmarks(route.steps, pois, cand.id), cand.name),
      },
    };
  }
  if (startOffNetwork) {
    throw new ServiceError('start', offNetworkMsg(mode));
  }
  if (lastServiceErr) {
    throw new ServiceError(lastServiceErr.kind, `Routing service unavailable: ${lastServiceErr.message} Please try again shortly.`);
  }
  throw new ServiceError('empty', 'Couldn\'t find a reachable destination nearby. Try a larger radius, or a Random spot instead.');
}

// ---------------------------------------------------------------- random spots

/** A uniformly random point in the ring between minR and maxR around `start`. */
export function randomSpot(start, minR, maxR, rng = Math.random) {
  const d = Math.sqrt(rng() * (maxR * maxR - minR * minR) + minR * minR);
  return destinationPoint(start, rng() * 360, d);
}

/** Name a random spot after the road it ends on (the router only ever ends on public ways). */
export function spotName(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const street = steps[i].street?.replace(/\s*\([^)]*\)$/, '');
    if (street) return street;
  }
  return 'Somewhere unnamed';
}

/**
 * Random spot: drop a pin anywhere in range and let the router snap it to the nearest public
 * path or road. No place data needed, so this works where there are no landmarks (or Overpass is down).
 * Bad pins (in a lake, a private estate, a maze) are retried; if every try is imperfect we settle
 * for the least-bad reachable one rather than fail.
 */
async function generateRandomRally({ start, mode, difficulty, radius, signal, onProgress, fetchJson, rng, now }) {
  const cfg = MODES[mode];
  const maxR = radius;
  const minR = Math.round(radius * MIN_RADIUS_FRACTION);
  const bases = SERVICES.routing[cfg.osrmProfile];
  onProgress('routing');
  let fallback = null;
  let serviceFailures = 0;
  let lastServiceErr = null;
  let startOffNetwork = 0;
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    if (signal?.aborted) throw new ServiceError('aborted', 'Cancelled');
    const pin = randomSpot(start, minR, maxR, rng);
    let route;
    try {
      route = parseRoute(await fetchJson('routing', bases.map((b) => buildRouteUrl(b, start, pin)), { signal }));
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      if (err.kind === 'no-route') continue;
      lastServiceErr = err;
      if (++serviceFailures >= 2) break;
      continue;
    }
    if (route.startSnapDistance != null && route.startSnapDistance > 400) {
      startOffNetwork++;
      continue;
    }
    const why = rejectRoute(route, { area: false }, { mode, minR, maxR });
    if (!why) return randomRally(route);
    // Far from any way means the pin was in water or private land: never settle for those.
    if (!fallback && !['unreachable', 'invalid', 'trivial'].includes(why)) fallback = route;
  }
  if (fallback) return randomRally(fallback);
  if (startOffNetwork) throw new ServiceError('start', offNetworkMsg(mode));
  if (lastServiceErr) {
    throw new ServiceError(lastServiceErr.kind, `Routing service unavailable: ${lastServiceErr.message} Please try again shortly.`);
  }
  throw new ServiceError('empty', 'Couldn\'t reach anywhere random from here. Try a different start point.');

  function randomRally(route) {
    const end = route.endPoint;
    return {
      id: rallyId(now, rng),
      mode,
      target: 'random',
      difficulty,
      createdAt: now(),
      start: { lat: start.lat, lon: start.lon },
      destination: {
        id: `rnd:${gridKey(end, 4)}`,
        name: spotName(route.steps),
        label: TARGETS.random.label,
        lat: end.lat,
        lon: end.lon,
        tags: {},
      },
      arrivalTargets: [end],
      route: { distance: route.distance, duration: route.duration, geometry: route.geometry, steps: route.steps },
    };
  }
}

// ---------------------------------------------------------------- cities

/**
 * The vague directions for a city: which way, roughly how far, and the two or three roads that
 * carry most of the trip. `steps` come from parseRoute.
 */
export function cityHint(start, dest, steps, routeDistance) {
  const deg = bearing(start, dest);
  const byRoad = new Map();
  steps.forEach((s, i) => {
    if (!s.street || s.type === 'arrive') return;
    const road = s.street.match(/\(([^)]+)\)$/)?.[1] ?? s.street; // prefer the ref: "I 5" over "Interstate 5 (I 5)"
    const cur = byRoad.get(road) ?? { road, distance: 0, first: i };
    cur.distance += s.distance;
    byRoad.set(road, cur);
  });
  const total = routeDistance || [...byRoad.values()].reduce((a, r) => a + r.distance, 0) || 1;
  const roads = [...byRoad.values()]
    .filter((r) => r.distance / total >= 0.12)
    .sort((a, b) => b.distance - a.distance)
    .slice(0, 3)
    .sort((a, b) => a.first - b.first)
    .map((r) => r.road);
  return { bearing: Math.round(deg), direction: compass(deg), straight: Math.round(haversine(start, dest)), roads };
}

async function fetchCities(start, radius, places, { signal, fetchJson, now, rng, lang }) {
  const key = `city:${gridKey(start, 2)}:${radius}:${places.join(',')}`;
  const hit = poiCache.get(key);
  if (hit && now() - hit.at < POI_CACHE_TTL_MS) return hit.pois;
  let cities;
  try {
    const json = await fetchJson('overpass', SERVICES.overpass, {
      signal,
      timeoutMs: CITY.overpassTimeoutMs, // a 100 km search is slower than the usual neighbourhood one
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(buildCityQuery(start, radius, places))}`,
      },
    });
    cities = parseCities(json, places);
  } catch (err) {
    if (err.kind === 'aborted' || err.kind === 'offline') throw err;
    cities = await fetchWikiCities(start, radius, { signal, fetchJson, rng, lang });
  }
  poiCache.set(key, { at: now(), pois: cities });
  return cities;
}

/** Fallback: Wikipedia geosearch tops out at 10 km, so sample points around the ring. */
async function fetchWikiCities(start, radius, { signal, fetchJson, rng, lang }) {
  const api = SERVICES.wikipediaApi(lang);
  const ring = (radius * (CITY.minFraction + 1)) / 2;
  const spin = rng() * 360;
  const n = 6;
  const all = new Map();
  let failures = 0;
  for (let i = 0; i < n; i++) {
    try {
      const json = await fetchJson('wiki', [wikiGeosearchUrl(api, destinationPoint(start, spin + (i * 360) / n, ring), 10000)], { signal });
      for (const c of parseWikiCities(json, lang)) all.set(c.id, c);
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      failures++;
    }
  }
  if (failures === n) throw new ServiceError('http', 'The map data services are busy right now. Try again in a minute, or pick a Random spot.');
  return [...all.values()];
}

/**
 * City: pick a town or city in a wide radius and route to it only to learn the distance and the
 * major roads. You get a name and vague directions; no turn-by-turn, no route tracking.
 */
async function generateCityRally({ start, mode, difficulty, radius, avoidIds, signal, onProgress, fetchJson, rng, now, lang }) {
  const places = CITY.places[mode];
  const minR = Math.round(radius * CITY.minFraction);
  onProgress('places');
  const cities = await fetchCities(start, radius, places, { signal, fetchJson, now, rng, lang });
  let candidates = rankCandidates(cities, start, { minR, maxR: radius, avoidIds, rng, limit: MAX_ROUTE_ATTEMPTS });
  if (!candidates.length && avoidIds.length) candidates = rankCandidates(cities, start, { minR, maxR: radius, rng, limit: MAX_ROUTE_ATTEMPTS });
  if (!candidates.length) throw new ServiceError('empty', 'No towns or cities found in range. Try a larger distance.');

  onProgress('routing');
  const bases = SERVICES.routing[MODES[mode].osrmProfile];
  let serviceFailures = 0;
  let lastServiceErr = null;
  let startOffNetwork = 0;
  for (const c of candidates) {
    if (signal?.aborted) throw new ServiceError('aborted', 'Cancelled');
    let route;
    try {
      route = parseRoute(await fetchJson('routing', bases.map((b) => buildRouteUrl(b, start, c)), { signal }));
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      if (err.kind === 'no-route') continue;
      lastServiceErr = err;
      if (++serviceFailures >= 2) break;
      continue;
    }
    if (route.startSnapDistance != null && route.startSnapDistance > 400) {
      startOffNetwork++;
      continue;
    }
    // Islands, or the only way there is a huge detour: skip.
    if (route.distance > radius * MAX_ROUTE_DETOUR || route.endSnapDistance > 2000) continue;
    return {
      id: rallyId(now, rng),
      mode,
      target: 'city',
      difficulty,
      createdAt: now(),
      start: { lat: start.lat, lon: start.lon },
      destination: { id: c.id, name: c.name, label: c.label, lat: c.lat, lon: c.lon, tags: c.tags },
      arrivalTargets: [{ lat: c.lat, lon: c.lon }],
      arrivalRadius: CITY.arrivalRadius[c.place] ?? 800,
      hint: cityHint(start, c, route.steps, route.distance),
      route: { distance: route.distance, duration: route.duration, geometry: route.geometry, steps: [] },
    };
  }
  if (startOffNetwork) throw new ServiceError('start', offNetworkMsg(mode));
  if (lastServiceErr) {
    throw new ServiceError(lastServiceErr.kind, `Routing service unavailable: ${lastServiceErr.message} Please try again shortly.`);
  }
  throw new ServiceError('empty', 'Couldn\'t find a reachable town in range. Try a larger distance.');
}
