// Game flow as an explicit state machine. Illegal jumps throw, which keeps the UI honest:
// e.g. there is no edge from `rally` to `discovered` except through `arrive`.

export const SCREENS = ['home', 'setup', 'scouting', 'countdown', 'briefing', 'rally', 'discovered', 'stats', 'settings'];

const TRANSITIONS = {
  home: { start: 'setup', stats: 'stats', settings: 'settings', resume: 'rally', resumeBriefing: 'briefing' },
  setup: { scout: 'scouting', back: 'home', settings: 'settings' },
  scouting: { ready: 'countdown', fail: 'setup', cancel: 'setup' },
  countdown: { go: 'briefing', cancel: 'setup' },
  briefing: { begin: 'rally', abandon: 'home' },
  rally: { arrive: 'discovered', abandon: 'home' },
  discovered: { again: 'setup', home: 'home', stats: 'stats' },
  stats: { back: 'home', review: 'discovered' },
  settings: { back: 'home', backToSetup: 'setup' },
};

export function nextState(current, event) {
  const to = TRANSITIONS[current]?.[event];
  if (!to) throw new Error(`Illegal transition: ${current} --${event}-->`);
  return to;
}

export function canTransition(current, event) {
  return Boolean(TRANSITIONS[current]?.[event]);
}

/** Tiny observable machine wrapper used by the UI. */
export function createMachine(initial = 'home') {
  let state = initial;
  const listeners = new Set();
  return {
    get state() {
      return state;
    },
    send(event, payload) {
      const from = state;
      state = nextState(state, event);
      listeners.forEach((fn) => fn(state, from, event, payload));
      return state;
    },
    can(event) {
      return canTransition(state, event);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
