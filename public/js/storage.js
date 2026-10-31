// LocalStorage persistence: settings, personal stats, and the in-progress rally.
// The storage object is injectable so tests can pass an in-memory implementation.

import { HISTORY_LIMIT } from './config.js';

const PREFIX = 'blindrally:v1:';

export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = `${PREFIX}probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return memoryStorage(); // private mode / disabled storage: play still works, nothing persists
  }
}

export const DEFAULT_SETTINGS = {
  mode: 'walk',
  difficulty: 'pro',
  walkRadius: 1500,
  bikeRadius: 3000,
  driveRadius: 4000,
  units: 'metric',
  haptics: true,
  keepAwake: true,
};

export function emptyStats() {
  return {
    completed: 0,
    abandoned: 0,
    best: {}, // key `${mode}:${difficulty}` -> ms (GPS-verified only)
    history: [], // newest first
    discovered: [], // OSM ids of unique destinations
  };
}

export const bestKey = (mode, difficulty) => `${mode}:${difficulty}`;

/** Pure: returns new stats and a comparison against the previous best. */
export function recordResult(stats, result) {
  const s = structuredClone(stats);
  s.completed += 1;
  const key = bestKey(result.mode, result.difficulty);
  const previousBest = s.best[key] ?? null;
  const eligible = result.verified === 'gps' && !result.dev;
  let isRecord = false;
  if (eligible && (previousBest == null || result.timeMs < previousBest)) {
    s.best[key] = result.timeMs;
    isRecord = true;
  }
  s.history.unshift({
    date: result.date,
    timeMs: result.timeMs,
    mode: result.mode,
    difficulty: result.difficulty,
    name: result.name,
    label: result.label ?? null,
    routeDistance: result.routeDistance ?? null,
    verified: result.verified,
    record: isRecord,
    // Replay data (optional, present for rallies recorded since scoring was added).
    ...pick(result, ['score', 'grade', 'parts', 'style', 'accuracy', 'wrongTurns', 'peeks', 'speeding', 'travelled', 'etaSec', 'track', 'route', 'dest']),
  });
  s.history = s.history.slice(0, HISTORY_LIMIT);
  if (result.destId && !s.discovered.includes(result.destId)) s.discovered.push(result.destId);
  if (s.discovered.length > 2000) s.discovered = s.discovered.slice(-2000);
  return { stats: s, isRecord, previousBest, eligible };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function recordAbandon(stats) {
  return { ...structuredClone(stats), abandoned: stats.abandoned + 1 };
}

/** Overall best for a mode across difficulties. */
export function bestForMode(stats, mode) {
  let best = null;
  for (const [k, v] of Object.entries(stats.best)) {
    if (k.startsWith(`${mode}:`) && (best == null || v < best)) best = v;
  }
  return best;
}

// The active rally contains the hidden destination. It's lightly scrambled so it isn't
// sitting in DevTools as plain text — a spoiler guard, not security (the code is open source).
const SCRAMBLE_KEY = 'know-the-route-not-the-destination';
export function scramble(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= SCRAMBLE_KEY.charCodeAt(i % SCRAMBLE_KEY.length);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function unscramble(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ SCRAMBLE_KEY.charCodeAt(i % SCRAMBLE_KEY.length);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createStore(storage = safeStorage()) {
  const read = (k, fallback) => {
    try {
      const v = storage.getItem(PREFIX + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  const write = (k, v) => {
    try {
      storage.setItem(PREFIX + k, JSON.stringify(v));
    } catch {
      /* quota or disabled — non-fatal */
    }
  };
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...read('settings', {}) }),
    saveSettings: (s) => write('settings', s),
    getStats: () => ({ ...emptyStats(), ...read('stats', {}) }),
    saveStats: (s) => write('stats', s),
    getActive() {
      const raw = read('active', null);
      if (!raw) return null;
      try {
        return unscramble(raw);
      } catch {
        return null;
      }
    },
    saveActive: (rally) => write('active', scramble(rally)),
    clearActive: () => storage.removeItem(PREFIX + 'active'),
    clearAll() {
      for (const k of ['settings', 'stats', 'active']) storage.removeItem(PREFIX + k);
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
        keys.filter((k) => k?.startsWith(PREFIX)).forEach((k) => storage.removeItem(k));
      } catch {
        /* memory storage has no enumeration */
      }
    },
  };
}
