// Polite networking for free public services: per-service spacing, timeouts, mirror fallback,
// and errors that the UI can turn into a human sentence.

import { MIN_REQUEST_GAP_MS, REQUEST_TIMEOUT_MS } from './config.js';

export class ServiceError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'ServiceError';
    this.kind = kind; // 'offline' | 'network' | 'timeout' | 'http' | 'rate' | 'parse' | 'empty' | 'aborted'
    this.cause = cause;
  }
}

const lastCallAt = {};
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ServiceError('aborted', 'Cancelled'));
    }, { once: true });
  });

/**
 * fetch() with per-service spacing and a timeout. `fetchImpl` is injectable for tests.
 */
export async function politeFetch(service, url, { signal, fetchImpl = globalThis.fetch, init = {}, now = Date.now, timeoutMs } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ServiceError('offline', 'You appear to be offline.');
  }
  const gap = MIN_REQUEST_GAP_MS[service] ?? 0;
  const wait = (lastCallAt[service] ?? 0) + gap - now();
  if (wait > 0) await sleep(wait, signal);
  lastCallAt[service] = now();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS[service] ?? 15000);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (signal?.aborted) throw new ServiceError('aborted', 'Cancelled', err);
    if (ctrl.signal.aborted) throw new ServiceError('timeout', `${service} took too long to respond.`, err);
    throw new ServiceError('network', `Couldn't reach the ${service} service.`, err);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
  if (res.status === 429) throw new ServiceError('rate', `The ${service} service is busy. Try again in a minute.`);
  if (!res.ok) throw new ServiceError('http', `${service} returned HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch (err) {
    throw new ServiceError('parse', `${service} sent an unreadable response.`, err);
  }
}

/** Try each mirror in order; return the first success. Aborts propagate immediately. */
export async function fetchFromMirrors(service, urls, opts = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      return await politeFetch(service, url, opts);
    } catch (err) {
      if (err.kind === 'aborted' || err.kind === 'offline') throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new ServiceError('http', `No ${service} servers available.`);
}

/** Test hook. */
export function _resetSpacing() {
  for (const k of Object.keys(lastCallAt)) delete lastCallAt[k];
}
