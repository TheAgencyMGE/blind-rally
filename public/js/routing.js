// OSRM route parsing and turn-instruction formatting. Network calls live in rally.js.

import { compass } from './geo.js';

export function buildRouteUrl(base, start, end) {
  const c = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
  return `${base}/${c(start)};${c(end)}?overview=full&geometries=geojson&steps=true&alternatives=false`;
}

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

function roadName(step) {
  const name = step.name?.trim();
  const ref = step.ref?.trim();
  if (name && ref) return `${name} (${ref})`;
  return name || ref || '';
}

function turnWord(modifier) {
  switch (modifier) {
    case 'uturn': return 'Make a U-turn';
    case 'sharp right': return 'Turn sharp right';
    case 'right': return 'Turn right';
    case 'slight right': return 'Bear right';
    case 'straight': return 'Go straight';
    case 'slight left': return 'Bear left';
    case 'left': return 'Turn left';
    case 'sharp left': return 'Turn sharp left';
    default: return 'Continue';
  }
}

/** Human sentence for one OSRM step. Never mentions the destination's name. */
export function describeStep(step) {
  const m = step.maneuver ?? {};
  const type = m.type;
  const mod = m.modifier;
  const road = roadName(step);
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';

  switch (type) {
    case 'depart':
      return `Head ${compass(m.bearing_after ?? 0)}${on}`;
    case 'arrive': {
      const side = mod === 'left' || mod === 'right' ? ` — it's on your ${mod}` : '';
      return `Arrive at the destination${side}`;
    }
    case 'roundabout':
    case 'rotary': {
      const exit = m.exit && ORDINAL[m.exit] ? `take the ${ORDINAL[m.exit]} exit` : 'take your exit';
      return `At the roundabout, ${exit}${onto}`;
    }
    case 'roundabout turn':
      return `At the roundabout, ${turnWord(mod).toLowerCase()}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'fork':
      return `Keep ${mod?.includes('left') ? 'left' : mod?.includes('right') ? 'right' : 'straight'} at the fork${onto}`;
    case 'merge':
      return `Merge${onto}`;
    case 'on ramp':
      return `Take the ramp${onto}`;
    case 'off ramp':
      return `Take the exit${onto}`;
    case 'end of road':
      return `At the end of the road, ${turnWord(mod).toLowerCase()}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      return mod && mod !== 'straight' ? `${turnWord(mod)} to stay${on}` : `Continue${on}`;
    case 'turn':
    default:
      return `${turnWord(mod)}${onto}`;
  }
}

/**
 * Parse an OSRM /route response into what the game needs.
 * Throws an Error with a `kind` of 'no-route' when there's nothing usable.
 */
export function parseRoute(json) {
  if (json?.code !== 'Ok' || !json.routes?.length) {
    const e = new Error(json?.message || 'No route found');
    e.kind = 'no-route';
    throw e;
  }
  const route = json.routes[0];
  const geometry = (route.geometry?.coordinates ?? []).map(([lon, lat]) => ({ lat, lon }));
  const raw = (route.legs ?? []).flatMap((l) => l.steps ?? []);
  const steps = [];
  for (const s of raw) {
    const type = s.maneuver?.type;
    // Drop silent bookkeeping steps that make the list longer without helping memory.
    if (type === 'notification' || (type === 'new name' && !s.name && !s.ref)) continue;
    const [lon, lat] = s.maneuver?.location ?? [];
    steps.push({
      text: describeStep(s),
      type,
      modifier: s.maneuver?.modifier ?? null,
      street: roadName(s),
      distance: s.distance ?? 0,
      location: Number.isFinite(lat) ? { lat, lon } : null,
    });
  }
  // Merge consecutive "Continue onto X" duplicates for the same street.
  const merged = [];
  for (const s of steps) {
    const prev = merged[merged.length - 1];
    if (prev && s.type === 'new name' && s.street && prev.street === s.street) {
      prev.distance += s.distance;
      continue;
    }
    merged.push(s);
  }
  const wps = json.waypoints ?? [];
  const end = wps[wps.length - 1];
  return {
    distance: route.distance,
    duration: route.duration,
    geometry,
    steps: merged,
    endSnapDistance: end?.distance ?? null,
    endPoint: end?.location ? { lat: end.location[1], lon: end.location[0] } : geometry[geometry.length - 1] ?? null,
    startSnapDistance: wps[0]?.distance ?? null,
  };
}
