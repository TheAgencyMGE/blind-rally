// Rally generation: find real, public, routable destinations around the start point.

import { MODES, SERVICES, MIN_RADIUS_FRACTION, MAX_ROUTE_DETOUR, MAX_ROUTE_ATTEMPTS, MAX_ROUTE_STEPS, POI_CACHE_TTL_MS } from './config.js';
import { buildOverpassQuery, parseOverpass, rankCandidates, attachLandmarks, wikiGeosearchUrl, parseWikiGeosearch } from './destinations.js';
import { buildRouteUrl, parseRoute } from './routing.js';
import { fetchFromMirrors, ServiceError } from './net.js';
import { gridKey, isValidCoord, destinationPoint } from './geo.js';

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
 * `onProgress(stage)` receives 'places' | 'routing'.
 */
export async function generateRally({
  start,
  mode,
  difficulty,
  radius,
  avoidIds = [],
  signal,
  onProgress = () => {},
  fetchJson = fetchFromMirrors,
  rng = Math.random,
  now = Date.now,
  lang = 'en',
}) {
  if (!isValidCoord(start)) throw new ServiceError('invalid', 'That starting point is not a valid location.');
  const cfg = MODES[mode];
  if (!cfg) throw new ServiceError('invalid', `Unknown travel mode: ${mode}`);
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
    throw new ServiceError('empty', 'No public landmarks found in range. Try a larger radius in Settings, or a different start point.');
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
      id: `${now().toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`,
      mode,
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
    throw new ServiceError('start', `Your start point is too far from any ${mode === 'walk' ? 'path' : 'road'}. Move closer to a street and try again.`);
  }
  if (lastServiceErr) {
    throw new ServiceError(lastServiceErr.kind, `Routing service unavailable: ${lastServiceErr.message} Please try again shortly.`);
  }
  throw new ServiceError('empty', 'Couldn\'t find a reachable destination nearby. Try a larger radius or a different start point.');
}
