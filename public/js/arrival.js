// Arrival detection. Pure: feed it GPS fixes, it tells you when the player has arrived.
//
// Rules (all tunable per travel mode):
//  - Fixes worse than `maxAccuracy` are ignored for arrival (but reported as "weak").
//  - A fix is "inside" if its distance to any target is within
//    arrivalRadius + min(accuracy, arrivalRadius)   (GPS slack, but bounded).
//  - Automatic arrival needs the player to stay inside for `dwellMs`, over at least
//    two fixes, while moving slower than `maxDwellSpeed`. Driving past doesn't count.
//  - An explicit check-in (player taps "I'm here") only needs one good inside fix,
//    since the intent is unambiguous.

import { haversine, isValidCoord } from './geo.js';

export function createArrivalDetector({
  targets,
  arrivalRadius,
  maxAccuracy,
  dwellMs,
  maxDwellSpeed,
}) {
  if (!Array.isArray(targets) || !targets.some(isValidCoord)) {
    throw new Error('Arrival detector needs at least one valid target');
  }
  const pts = targets.filter(isValidCoord);
  let insideSince = null;
  let insideFixes = 0;
  let lastFix = null;
  let travelled = 0;
  let goodFixes = 0;

  const distanceTo = (fix) => Math.min(...pts.map((t) => haversine(fix, t)));
  const effectiveRadius = (acc) => arrivalRadius + Math.min(acc, arrivalRadius);

  function classify(fix) {
    if (!isValidCoord(fix) || !Number.isFinite(fix.accuracy)) return { quality: 'invalid' };
    const quality = fix.accuracy <= maxAccuracy ? 'good' : 'weak';
    const distance = distanceTo(fix);
    const inside = quality === 'good' && distance <= effectiveRadius(fix.accuracy);
    return { quality, distance, inside };
  }

  function speedOf(fix) {
    if (Number.isFinite(fix.speed) && fix.speed >= 0) return fix.speed;
    if (lastFix && fix.time > lastFix.time) {
      return haversine(lastFix, fix) / ((fix.time - lastFix.time) / 1000);
    }
    return 0;
  }

  return {
    /** Feed a fix {lat, lon, accuracy, speed?, time}. Returns status object. */
    update(fix) {
      const c = classify(fix);
      if (c.quality === 'invalid') return { arrived: false, quality: 'invalid' };

      if (c.quality === 'good') {
        // Odometer: only count movement that's clearly larger than the noise.
        if (lastFix) {
          const step = haversine(lastFix, fix);
          if (step > Math.max(fix.accuracy, lastFix.accuracy, 5)) {
            travelled += step;
            lastFix = fix;
          }
        } else {
          lastFix = fix;
        }
        goodFixes++;
      }

      const speed = c.quality === 'good' ? speedOf(fix) : 0;
      if (c.inside && speed <= maxDwellSpeed) {
        if (insideSince == null) insideSince = fix.time;
        insideFixes++;
      } else if (c.quality === 'good') {
        // Left the zone or moving too fast: reset dwell. Weak fixes neither help nor hurt.
        insideSince = null;
        insideFixes = 0;
      }

      const dwell = insideSince == null ? 0 : fix.time - insideSince;
      const arrived = insideFixes >= 2 && dwell >= dwellMs;
      return { arrived, quality: c.quality, inside: c.inside, dwell, accuracy: fix.accuracy };
    },

    /** Explicit "I'm here" check with a single fresh fix. */
    checkIn(fix) {
      const c = classify(fix);
      if (c.quality === 'invalid') return { arrived: false, reason: 'invalid' };
      if (c.quality === 'weak') return { arrived: false, reason: 'weak', accuracy: fix.accuracy };
      return { arrived: c.inside, reason: c.inside ? 'ok' : 'not-here' };
    },

    /** Distance travelled according to good fixes; null if we don't have enough data to trust it. */
    get distanceTravelled() {
      return goodFixes >= 5 ? travelled : null;
    },

    reset() {
      insideSince = null;
      insideFixes = 0;
    },
  };
}
