// Rally scoring: a transparent 0–1000 score, an S–F grade and a one-line "style" title.
// Every point added or taken away is listed, so the results screen can show exactly why.

export const SCORING = {
  base: 900,
  difficultyBonus: { rookie: 0, pro: 50, insane: 100 },
  cleanBonus: 50, // no wrong turns, no peeks
  underParBonus: 50, // beat the router's estimate by 10%+
  parGrace: 1.15, // up to 15% slower than the estimate is free
  pacePerUnit: 300, // points per 1.0 of time ratio beyond the grace
  paceMax: 250,
  accuracyPerPct: 4,
  accuracyMax: 300,
  extraGrace: 0.2, // 20% extra distance is free (GPS noise, crossing streets)
  freeExtraGrace: 0.5, // city rallies: you pick your own way, so more slack
  extraPerUnit: 250,
  extraMax: 200,
  wrongTurn: 40,
  wrongTurnMax: 200,
  peek: 75,
  speeding: 75,
};

export const GRADES = [
  ['S', 950],
  ['A', 850],
  ['B', 750],
  ['C', 650],
  ['D', 500],
  ['F', 0],
];

export const gradeFor = (score) => GRADES.find(([, min]) => score >= min)[0];

/**
 * @param {object} r
 * @param {number} r.timeMs       elapsed time
 * @param {number} r.etaSec       router's duration estimate
 * @param {number} r.routeDistance
 * @param {number} r.travelled    metres actually covered (null if unknown)
 * @param {number} r.accuracy     % of travelled distance that was on the route
 * @param {number} r.wrongTurns
 * @param {number} r.peeks
 * @param {number} [r.speeding]   speeding incidents (drive)
 * @param {string} r.difficulty
 * @param {boolean} [r.freeRoute] city rallies: no briefed route, so no accuracy or wrong-turn scoring
 */
export function scoreRally(r) {
  const S = SCORING;
  const parts = [];
  const add = (key, points) => { if (points) parts.push({ key, points: Math.round(points) }); };

  add('difficulty', S.difficultyBonus[r.difficulty] ?? 0);

  const ratio = r.etaSec > 0 ? r.timeMs / 1000 / r.etaSec : 1;
  if (ratio <= 0.9) add('pace', S.underParBonus);
  else if (ratio > S.parGrace) add('pace', -Math.min(S.paceMax, (ratio - S.parGrace) * S.pacePerUnit));

  if (!r.freeRoute) {
    const acc = Number.isFinite(r.accuracy) ? r.accuracy : 100;
    add('accuracy', -Math.min(S.accuracyMax, (100 - acc) * S.accuracyPerPct));
  }

  if (r.travelled != null && r.routeDistance > 0) {
    const extra = r.travelled / r.routeDistance - 1;
    const grace = r.freeRoute ? S.freeExtraGrace : S.extraGrace;
    if (extra > grace) add('distance', -Math.min(S.extraMax, (extra - grace) * S.extraPerUnit));
  }

  if (!r.freeRoute) add('wrongTurns', -Math.min(S.wrongTurnMax, (r.wrongTurns ?? 0) * S.wrongTurn));
  add('peeks', -(r.peeks ?? 0) * S.peek);
  add('speeding', -(r.speeding ?? 0) * S.speeding);
  if ((r.freeRoute || !r.wrongTurns) && !r.peeks) add('clean', S.cleanBonus);

  const raw = parts.reduce((a, p) => a + p.points, S.base);
  const score = Math.max(0, Math.min(1000, raw));
  return { score, grade: gradeFor(score), parts, paceRatio: ratio };
}

/** A title for how you played. First match wins. */
export function styleFor(r, { score, paceRatio }) {
  const extra = r.travelled != null && r.routeDistance > 0 ? r.travelled / r.routeDistance - 1 : 0;
  if (score >= 980 && !r.peeks) return { id: 'human-gps', name: 'Human GPS', line: 'Didn\'t need the map. Barely needed the briefing.' };
  if ((r.speeding ?? 0) >= 2) return { id: 'lead-foot', name: 'Lead Foot', line: 'Speed limits are more of a suggestion.' };
  if (r.peeks >= 2) return { id: 'peeker', name: 'Peeker', line: 'Trust, but verify. Repeatedly.' };
  if (paceRatio <= 0.85 && r.wrongTurns <= 1) return { id: 'speedrunner', name: 'Speedrunner', line: 'Faster than the router thought possible.' };
  if (r.wrongTurns >= 3) return { id: 'comeback', name: 'Comeback Kid', line: 'Lost the plot. Found the place.' };
  if (extra > 0.6) return { id: 'scenic', name: 'Scenic Route', line: 'Saw every street except the right one.' };
  if (r.freeRoute && !r.peeks && paceRatio <= 1.1) return { id: 'pathfinder', name: 'Pathfinder', line: 'No directions. No problem.' };
  if (r.freeRoute && extra > 0.5) return { id: 'explorer', name: 'Explorer', line: 'Found the place. And a few others on the way.' };
  if (!r.wrongTurns && !r.peeks) return { id: 'precision', name: 'Precision Pilot', line: 'Every turn, exactly as briefed.' };
  if (paceRatio > 1.6) return { id: 'wanderer', name: 'Wanderer', line: 'Not lost. Just taking it in.' };
  return { id: 'veteran', name: 'Rally Veteran', line: 'Knows the streets well enough.' };
}

/** Parse an OSM maxspeed tag to km/h (null when unusable: "signals", "none", country codes). */
export function parseMaxspeed(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!(v > 0 && v < 200)) return null;
  return /mph/i.test(m[2] ?? '') ? v * 1.609344 : v;
}

/**
 * Counts speeding incidents: over the limit by `marginKmh` for at least `holdMs` = one incident,
 * re-armed once you drop back under the limit.
 */
export function createSpeedWatch({ marginKmh = 10, holdMs = 8000 } = {}) {
  let limit = null;
  let overSince = null;
  let counted = false;
  let incidents = 0;
  return {
    setLimit(kmh) { limit = kmh; },
    get limit() { return limit; },
    get incidents() { return incidents; },
    set incidents(n) { incidents = n; },
    update(speedMs, t = Date.now()) {
      if (limit == null || !Number.isFinite(speedMs)) return incidents;
      const kmh = speedMs * 3.6;
      if (kmh > limit + marginKmh) {
        overSince ??= t;
        if (!counted && t - overSince >= holdMs) {
          incidents += 1;
          counted = true;
        }
      } else if (kmh <= limit) {
        overSince = null;
        counted = false;
      }
      return incidents;
    },
  };
}
