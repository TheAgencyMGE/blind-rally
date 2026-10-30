// Timers are derived from wall-clock timestamps, never from tick counts, so they survive
// tab throttling, backgrounding and page reloads without drifting.

export function remainingMs(endsAt, now = Date.now()) {
  return Math.max(0, endsAt - now);
}

export function elapsedMs(startedAt, now = Date.now(), endedAt = null) {
  return Math.max(0, (endedAt ?? now) - startedAt);
}

/** 754321 -> "12:34.3"; 4000123 -> "1:06:40.1" */
export function formatElapsed(ms, { tenths = true } = {}) {
  const safe = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return tenths ? `${base}.${Math.floor((safe % 1000) / 100)}` : base;
}

/** Countdown display: whole seconds rounded up, so "1" shows until the very end. */
export function formatCountdown(ms) {
  return String(Math.ceil(Math.max(0, ms) / 1000));
}

/**
 * Small scheduler around requestAnimationFrame/setInterval that calls `onTick(now)`.
 * Accepts injected clock functions so tests can drive it deterministically.
 */
export function createTicker(onTick, { interval = 100, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now } = {}) {
  let id = null;
  return {
    start() {
      if (id != null) return;
      onTick(now());
      id = setIntervalFn(() => onTick(now()), interval);
    },
    stop() {
      if (id == null) return;
      clearIntervalFn(id);
      id = null;
    },
    get running() {
      return id != null;
    },
  };
}
