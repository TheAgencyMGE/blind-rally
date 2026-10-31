// Speed limit of the road you're on, from OpenStreetMap `maxspeed` tags via Overpass.
// Best effort: when Overpass is busy or the road has no tag, there's simply no limit shown.

import { SERVICES } from './config.js';
import { fetchFromMirrors } from './net.js';
import { haversine } from './geo.js';
import { parseMaxspeed } from './score.js';

export function buildSpeedQuery(p, radius = 25) {
  return `[out:json][timeout:6];way(around:${radius},${p.lat.toFixed(5)},${p.lon.toFixed(5)})[highway][maxspeed];out tags center 5;`;
}

/** Pick the closest tagged way's limit in km/h, or null. */
export function parseSpeedLimit(json, p) {
  let best = null;
  for (const el of json?.elements ?? []) {
    const kmh = parseMaxspeed(el.tags?.maxspeed);
    if (kmh == null) continue;
    const d = el.center ? haversine(p, { lat: el.center.lat, lon: el.center.lon }) : Infinity;
    if (!best || d < best.d) best = { kmh, d, mph: /mph/i.test(el.tags.maxspeed) };
  }
  return best && { kmh: best.kmh, mph: best.mph };
}

export async function fetchSpeedLimit(p, { signal, fetchJson = fetchFromMirrors } = {}) {
  const json = await fetchJson('overpass', SERVICES.overpass, {
    signal,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildSpeedQuery(p))}`,
    },
  });
  return parseSpeedLimit(json, p);
}
