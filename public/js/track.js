// Silent route tracking during a rally: records your path, notices when you leave the
// memorized route (wrong turns) and how much of what you covered was on it (accuracy).
// Nothing here is shown while driving/walking — it's revealed on the results screen.

import { haversine } from './geo.js';

const M_PER_DEG = 111_320;

/** Local flat projection in metres around `ref` (accurate enough at city scale). */
function project(p, ref) {
  return { x: (p.lon - ref.lon) * M_PER_DEG * Math.cos((ref.lat * Math.PI) / 180), y: (p.lat - ref.lat) * M_PER_DEG };
}

/** Cumulative distance (m) at each vertex of a polyline. */
export function cumulative(geom) {
  const out = [0];
  for (let i = 1; i < geom.length; i++) out.push(out[i - 1] + haversine(geom[i - 1], geom[i]));
  return out;
}

/**
 * Nearest point on the polyline to `p`, searching segments [from, to).
 * Returns { index, dist, along } — dist is metres off the route, along is metres from the start.
 */
export function snapToRoute(p, geom, cum, from = 0, to = geom.length - 1) {
  let best = null;
  const lo = Math.max(0, from);
  const hi = Math.min(geom.length - 1, to);
  for (let i = lo; i < hi; i++) {
    const a = project(geom[i], p);
    const b = project(geom[i + 1], p);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const dist = Math.hypot(x, y);
    if (!best || dist < best.dist) best = { index: i, dist, along: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  if (!best && geom.length === 1) best = { index: 0, dist: haversine(p, geom[0]), along: 0 };
  return best;
}

/** Douglas–Peucker simplification with a tolerance in metres. Keeps extra fields on points. */
export function simplify(points, tol = 5) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = project(points[s], points[s]);
    const b = project(points[e], points[s]);
    let max = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const c = project(points[i], points[s]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const d = len ? Math.abs(dy * c.x - dx * c.y + b.x * a.y - b.y * a.x) / len : Math.hypot(c.x, c.y);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplify until at most `max` points remain (for storage). */
export function shrink(points, max = 250) {
  let tol = 3;
  let out = simplify(points, tol);
  while (out.length > max && tol < 500) out = simplify(points, (tol *= 2));
  return out;
}

/**
 * Track a rally against the memorized route.
 * Off-route needs two accurate fixes in a row beyond the threshold (GPS jitter forgives one),
 * and you're back on as soon as one fix is close again. Each on→off flip is one wrong turn.
 */
export function createTracker(geometry, { offRouteM = 40, backOnM = 25, minMoveM = 8, maxAccuracy = 50, maxSpeed = 70, state } = {}) {
  const cum = cumulative(geometry);
  const s = state
    ? structuredClone(state)
    : { travelled: 0, onRoute: 0, progress: 0, index: 0, off: false, streak: 0, wrongTurns: 0, last: null, track: [] };

  function update(fix) {
    if (!fix || !(fix.accuracy <= maxAccuracy)) return summary();
    const p = { lat: fix.lat, lon: fix.lon };
    const t = fix.time ?? Date.now();

    if (s.last) {
      const d = haversine(s.last, p);
      if (d < minMoveM) return summary(); // jitter while standing still
      const dt = (t - s.last.t) / 1000;
      if (dt > 0 && d / dt > maxSpeed) return summary(); // teleport: bad fix
    }

    const threshold = Math.max(offRouteM, fix.accuracy);
    // Normally search just around where we last were; when lost, search the whole route.
    const snap = s.off
      ? snapToRoute(p, geometry, cum)
      : snapToRoute(p, geometry, cum, s.index - 3, s.index + 40) ?? snapToRoute(p, geometry, cum);
    const dist = snap?.dist ?? Infinity;

    if (!s.off) {
      if (dist > threshold) {
        s.streak += 1;
        if (s.streak >= 2) {
          s.off = true;
          s.wrongTurns += 1;
        }
      } else {
        s.streak = 0;
      }
    } else if (dist <= backOnM) {
      s.off = false;
      s.streak = 0;
    }

    if (snap && dist <= threshold) {
      s.index = snap.index;
      s.progress = Math.max(s.progress, snap.along);
    }

    if (s.last) {
      const d = haversine(s.last, p);
      s.travelled += d;
      if (!s.off && s.streak === 0) s.onRoute += d;
    }
    const speed = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    s.last = { ...p, t };
    s.track.push([round(p.lat), round(p.lon), t, s.off ? 1 : 0, speed == null ? null : Math.round(speed * 10) / 10]);
    if (s.track.length > 4000) s.track = s.track.filter((_, i) => i % 2 === 0 || i === s.track.length - 1);
    return summary();
  }

  function summary() {
    return {
      travelled: s.travelled,
      progress: s.progress,
      routeLength: cum[cum.length - 1] ?? 0,
      offRoute: s.off,
      wrongTurns: s.wrongTurns,
      accuracy: s.travelled > 0 ? Math.round((100 * s.onRoute) / s.travelled) : 100,
    };
  }

  return {
    update,
    summary,
    get track() { return s.track; },
    snapshot: () => structuredClone(s),
  };
}

const round = (n) => Math.round(n * 1e5) / 1e5;

/**
 * Speed over time for a chart: [{ t (s since start), v (m/s) }], `buckets` evenly spaced samples.
 * Uses GPS-reported speed when present, otherwise distance/time between points.
 */
export function speedSeries(track, buckets = 40) {
  if (track.length < 2) return [];
  const t0 = track[0][2];
  const span = track[track.length - 1][2] - t0;
  if (span <= 0) return [];
  const raw = [];
  for (let i = 1; i < track.length; i++) {
    const [lat, lon, t, , v] = track[i];
    const [plat, plon, pt] = track[i - 1];
    const dt = (t - pt) / 1000;
    const derived = dt > 0 ? haversine({ lat: plat, lon: plon }, { lat, lon }) / dt : 0;
    // Some devices report 0 while clearly moving; trust the distance then.
    raw.push({ t: (t - t0) / 1000, v: v == null || (v === 0 && derived > 1) ? derived : v });
  }
  const out = [];
  const step = span / 1000 / buckets;
  for (let b = 0; b < buckets; b++) {
    const lo = b * step;
    const hi = lo + step;
    const inB = raw.filter((r) => r.t >= lo && r.t < hi);
    const v = inB.length ? inB.reduce((a, r) => a + r.v, 0) / inB.length : out[out.length - 1]?.v ?? 0;
    out.push({ t: lo + step / 2, v });
  }
  return out;
}
