// Blind Rally — UI controller. Wires the state machine to the DOM, GPS, maps and storage.

import { DIFFICULTIES, MODES, SERVICES, AVOID_RECENT } from './config.js';
import { createMachine } from './state.js';
import { createStore, recordResult, recordAbandon, bestForMode, bestKey } from './storage.js';
import { generateRally } from './rally.js';
import { createArrivalDetector } from './arrival.js';
import { createGeoProvider, createSimProvider } from './location.js';
import { remainingMs, elapsedMs, formatElapsed, formatCountdown, createTicker } from './timer.js';
import { formatDistance, isValidCoord, haversine } from './geo.js';
import { findPhoto } from './photo.js';
import * as maps from './map.js';

const VERSION = '1.0.0';
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;
const RING_LEN = 276.46;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const DEV = new URLSearchParams(location.search).has('dev');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = createStore();
let settings = store.getSettings();
let stats = store.getStats();
const machine = createMachine('home');
const devAt = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
const loc = DEV ? createSimProvider(devAt?.length === 2 && isValidCoord({ lat: devAt[0], lon: devAt[1] }) ? { lat: devAt[0], lon: devAt[1] } : undefined) : createGeoProvider();

const session = {
  start: null, // { lat, lon, accuracy } — always the player's real current position
  rally: null,
  briefingEndsAt: 0,
  startedAt: 0,
  scoutAbort: null,
  ticker: null,
  detector: null,
  stopWatch: null,
  gpsTrouble: 0,
  weakSince: null,
  result: null,
  settingsReturn: 'home',
  maps: { brief: null, disc: null },
  wakeLock: null,
};

// ---------------------------------------------------------------- helpers

function haptic(pattern) {
  // Browsers ignore (and warn about) vibration before the user has interacted with the page.
  if (settings.haptics && navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
}

let toastTimer;
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function confirmDialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  const okBtn = $('#dialog-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  $('#dialog-cancel').textContent = cancel;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function keepAwake(on) {
  try {
    if (on && settings.keepAwake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!session.wakeLock) {
        session.wakeLock = await navigator.wakeLock.request('screen');
        session.wakeLock.addEventListener('release', () => { session.wakeLock = null; });
      }
    } else if (!on && session.wakeLock) {
      await session.wakeLock.release();
      session.wakeLock = null;
    }
  } catch { /* battery saver or unsupported: not critical */ }
}

const fmtDist = (m) => formatDistance(m, settings.units);

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const min = Math.max(1, Math.round(sec / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

const fmtDelta = (ms) => formatElapsed(Math.abs(ms)).replace(/^00:/, '0:');

function stopTicker() {
  session.ticker?.stop();
  session.ticker = null;
}

function destroyMap(key) {
  if (session.maps[key]) {
    session.maps[key].remove();
    session.maps[key] = null;
  }
}

// ---------------------------------------------------------------- navigation

const onEnter = {};
const onExit = {};

machine.subscribe((to, from, event, payload) => {
  onExit[from]?.(to);
  document.body.dataset.screen = to;
  if (to !== 'countdown' && to !== 'briefing') window.scrollTo(0, 0);
  onEnter[to]?.(payload ?? {}, from);
  const screen = $(`.screen[data-screen="${to === 'countdown' ? 'briefing' : to}"]`);
  if (screen && to !== 'countdown') {
    screen.setAttribute('tabindex', '-1');
    screen.focus({ preventScroll: true });
  }
});

function go(event, payload) {
  if (machine.can(event)) machine.send(event, payload);
}

// ---------------------------------------------------------------- home

onEnter.home = () => {
  const best = bestForMode(stats, settings.mode);
  $('#home-best').textContent = best == null ? '—' : formatElapsed(best, { tenths: false });
  $('#home-count').textContent = String(stats.completed);
  $('#resume-banner').hidden = !store.getActive();
};

// ---------------------------------------------------------------- setup

onEnter.setup = (payload, from) => {
  syncSetupControls();
  const err = $('#setup-error');
  err.textContent = payload.error ?? '';
  err.hidden = !payload.error;
  if (from === 'discovered') clearStart(); // you're somewhere new now
  if (from === 'discovered' || from === 'home') autoLocate();
  updateScoutButton();
};

async function autoLocate() {
  if (session.start) return;
  if ((await loc.permission()) === 'granted') useLocation({ quiet: true });
}

function syncSetupControls() {
  $$('input[name="mode"]').forEach((r) => { r.checked = r.value === settings.mode; });
  $$('input[name="difficulty"]').forEach((r) => { r.checked = r.value === settings.difficulty; });
  $('#drive-safety').hidden = settings.mode !== 'drive';
  renderRadiusChips();
}

function currentRadius() {
  const opts = MODES[settings.mode].radiusOptions;
  const r = settings.mode === 'drive' ? settings.driveRadius : settings.walkRadius;
  return opts.includes(r) ? r : MODES[settings.mode].defaultRadius;
}

function renderRadiusChips() {
  const cur = currentRadius();
  $('#radius-chips').replaceChildren(
    ...MODES[settings.mode].radiusOptions.map((r) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'radius';
      input.value = String(r);
      input.checked = r === cur;
      input.setAttribute('aria-label', `Up to ${fmtDist(r)}`);
      const span = document.createElement('span');
      span.className = 'num';
      const [n, unit] = fmtDist(r).split(' ');
      const small = document.createElement('small');
      small.textContent = unit;
      span.append(n, small);
      label.append(input, span);
      return label;
    }),
  );
}

function updateScoutButton() {
  const needsAck = settings.mode === 'drive' && !$('#drive-ack').checked;
  $('#scout-btn').disabled = !session.start || needsAck;
}

function clearStart() {
  session.start = null;
  $('#opt-gps').setAttribute('aria-pressed', 'false');
  $('#gps-acc').textContent = '';
}

function setStart(start) {
  session.start = start;
  if (loc.simulated) loc.setPosition({ lat: start.lat, lon: start.lon, accuracy: 8 });
  $('#opt-gps').setAttribute('aria-pressed', 'true');
  $('#gps-acc').textContent = `±${Math.round(start.accuracy)} m`;
  if (start.accuracy > 100) toast(`Weak GPS (±${Math.round(start.accuracy)} m)`);
  updateScoutButton();
}

async function useLocation({ quiet = false } = {}) {
  const btn = $('#opt-gps');
  btn.setAttribute('aria-busy', 'true');
  $('#setup-error').hidden = true;
  try {
    const fix = await loc.getCurrent({ timeout: 15000, maximumAge: 30000 });
    if (!isValidCoord(fix)) throw Object.assign(new Error('Invalid location from device.'), { kind: 'unavailable' });
    setStart({ lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
  } catch (err) {
    if (!quiet) {
      const e = $('#setup-error');
      e.textContent = err.message;
      e.hidden = false;
    }
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

// ---------------------------------------------------------------- scouting

function wikiLang() {
  const l = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}

onEnter.scouting = async () => {
  const ctrl = new AbortController();
  session.scoutAbort = ctrl;
  try {
    const rally = await generateRally({
      start: session.start,
      mode: settings.mode,
      difficulty: settings.difficulty,
      radius: currentRadius(),
      avoidIds: stats.discovered.slice(-AVOID_RECENT),
      signal: ctrl.signal,
      lang: wikiLang(),
    });
    if (ctrl.signal.aborted || machine.state !== 'scouting') return;
    session.rally = rally;
    go('ready');
  } catch (err) {
    if (err.kind === 'aborted' || machine.state !== 'scouting') return;
    go('fail', { error: err.message || 'Couldn\'t find a destination.' });
  } finally {
    session.scoutAbort = null;
  }
};

// ---------------------------------------------------------------- countdown + briefing

onEnter.countdown = () => {
  renderBriefing();
  const num = $('#countdown-num');
  let n = 3;
  const show = () => {
    num.textContent = String(n);
    num.classList.remove('tick');
    void num.offsetWidth; // restart animation
    num.classList.add('tick');
    haptic(30);
  };
  show();
  const id = setInterval(() => {
    n -= 1;
    if (machine.state !== 'countdown') return clearInterval(id);
    if (n === 0) {
      clearInterval(id);
      haptic([60, 40, 60]);
      go('go');
    } else show();
  }, 1000);
};

function stepIcon(step) {
  const t = step.type;
  const m = step.modifier ?? '';
  let id = 'm-straight';
  if (t === 'depart') id = 'm-depart';
  else if (t === 'arrive') id = 'm-arrive';
  else if (/roundabout|rotary/.test(t)) id = 'm-roundabout';
  else if (m === 'uturn') id = 'm-uturn';
  else if (m.startsWith('sharp')) id = 'm-sharp-right';
  else if (m.startsWith('slight')) id = 'm-slight-right';
  else if (m === 'left' || m === 'right') id = 'm-right';
  const left = m.includes('left') && !/depart|arrive|roundabout|rotary/.test(t);
  return { id, left };
}

function briefPadding() {
  return innerWidth >= 900
    ? { top: 110, bottom: 60, left: 60, right: 480 }
    : { top: 110, bottom: Math.round(innerHeight * 0.34) + 120, left: 40, right: 40 };
}

function renderBriefing() {
  const r = session.rally;
  $('#brief-dist').textContent = fmtDist(r.route.distance);
  $('#brief-eta').textContent = fmtDuration(r.route.duration);
  $('#brief-count').textContent = String(DIFFICULTIES[r.difficulty].briefingSec);
  $('#ring-fill').style.strokeDashoffset = '0';
  $('#brief-ring').classList.remove('is-urgent');

  $('#brief-dirs').replaceChildren(
    ...r.route.steps.map((s) => {
      const li = document.createElement('li');
      li.setAttribute('aria-label', s.text);
      const { id, left } = stepIcon(s);
      const icon = document.createElement('span');
      icon.className = `dirs__i${left ? ' is-left' : ''}`;
      icon.innerHTML = `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
      const street = document.createElement('span');
      street.className = 'dirs__s';
      street.textContent = s.type === 'arrive' ? '' : s.street || s.landmark || '';
      if (s.landmark && s.street) {
        const lm = document.createElement('small');
        lm.textContent = s.landmark;
        street.append(lm);
      }
      const dist = document.createElement('span');
      dist.className = 'dirs__d';
      dist.textContent = s.distance >= 5 && s.type !== 'arrive' ? fmtDist(s.distance) : '';
      li.append(icon, street, dist);
      return li;
    }),
  );
  $('#brief-dirs').scrollTop = 0;

  destroyMap('brief');
  const geom = r.route.geometry;
  const { map, ready } = maps.createMap($('#brief-map'), { center: [r.start.lon, r.start.lat], zoom: 14 });
  session.maps.brief = map;
  maps.frameRoute(map, geom, briefPadding());
  maps.addMarker(map, r.start, 'start');
  maps.addMarker(map, geom[geom.length - 1], 'finish');
  ready.then(() => {
    if (session.maps.brief !== map) return;
    try { maps.hideLabel(map, r.destination.name); } catch { /* labels are cosmetic */ }
    maps.addRoute(map, geom);
  });
}

onEnter.briefing = (payload) => {
  const r = session.rally;
  if (payload.resume) renderBriefing();
  else session.briefingEndsAt = Date.now() + DIFFICULTIES[r.difficulty].briefingSec * 1000;
  store.saveActive({ phase: 'briefing', rally: r, briefingEndsAt: session.briefingEndsAt });
  keepAwake(true);
  const total = DIFFICULTIES[r.difficulty].briefingSec * 1000;
  let lastSec = null;
  session.ticker = createTicker((now) => {
    const left = remainingMs(session.briefingEndsAt, now);
    const sec = formatCountdown(left);
    $('#brief-count').textContent = sec;
    $('#ring-fill').style.strokeDashoffset = String(RING_LEN * (1 - left / total));
    const urgent = left <= 5000;
    $('#brief-ring').classList.toggle('is-urgent', urgent);
    if (urgent && sec !== lastSec && left > 0) haptic(20);
    lastSec = sec;
    if (left <= 0) endBriefing();
  }, { interval: 100 });
  session.ticker.start();
};

function endBriefing() {
  if (machine.state !== 'briefing') return;
  stopTicker();
  haptic([120, 60, 120]);
  // Wipe every trace of the route before the rally starts.
  destroyMap('brief');
  $('#brief-dirs').replaceChildren();
  $('#brief-dist').textContent = '—';
  $('#brief-eta').textContent = '—';
  const r = session.rally;
  session.rally = {
    id: r.id,
    mode: r.mode,
    difficulty: r.difficulty,
    destination: r.destination,
    arrivalTargets: r.arrivalTargets,
    routeDistance: r.route.distance,
  };
  session.startedAt = Date.now();
  store.saveActive({ phase: 'rally', rally: session.rally, startedAt: session.startedAt });
  go('begin');
}

onExit.briefing = () => {
  stopTicker();
  destroyMap('brief');
};

// ---------------------------------------------------------------- rally

onEnter.rally = (payload) => {
  const r = session.rally;
  const mode = MODES[r.mode];
  $('#rally-drive-note').hidden = r.mode !== 'drive';
  $('#dev-panel').hidden = !DEV;
  $('#manual-btn').hidden = true;
  session.gpsTrouble = 0;
  session.weakSince = null;
  if (payload.resumed) toast('Resumed — clock kept running');

  session.detector = createArrivalDetector({
    targets: r.arrivalTargets,
    arrivalRadius: mode.arrivalRadius,
    maxAccuracy: mode.maxAcceptableAccuracy,
    dwellMs: mode.dwellMs,
    maxDwellSpeed: mode.maxDwellSpeed,
  });
  session.ticker = createTicker((now) => {
    $('#rally-time').textContent = formatElapsed(elapsedMs(session.startedAt, now));
    if (session.weakSince && now - session.weakSince > 60000) $('#manual-btn').hidden = false;
  }, { interval: 100 });
  session.ticker.start();
  startGps();
  keepAwake(true);
};

onExit.rally = () => {
  stopTicker();
  stopGps();
  keepAwake(false);
};

function setGps(state, accuracy) {
  const el = $('#gps-status');
  el.className = `gps is-${state}`;
  el.querySelector('span').textContent = state === 'good' || state === 'weak' ? `±${Math.round(accuracy)} m` : '';
  el.setAttribute('aria-label', { good: 'GPS good', weak: 'GPS weak', bad: 'GPS unavailable', off: 'GPS paused', wait: 'Waiting for GPS' }[state]);
}

function startGps() {
  stopGps();
  setGps('wait');
  session.stopWatch = loc.watch(onFix, onGpsError);
}

function stopGps() {
  session.stopWatch?.();
  session.stopWatch = null;
}

function onFix(fix) {
  if (machine.state !== 'rally' || !session.detector) return;
  const st = session.detector.update(fix);
  if (st.quality === 'invalid') return;
  setGps(st.quality, fix.accuracy);
  if (st.quality === 'weak') session.weakSince ??= Date.now();
  else session.weakSince = null;
  if (st.arrived) complete('gps');
}

function onGpsError(err) {
  if (machine.state !== 'rally') return;
  setGps('bad');
  if (err.kind === 'denied' || err.kind === 'unsupported') {
    stopGps();
    toast('Location is off — confirm manually on arrival', 5000);
    $('#manual-btn').hidden = false;
  } else if (++session.gpsTrouble >= 2) {
    $('#manual-btn').hidden = false;
  }
}

async function checkIn() {
  const btn = $('#checkin-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const fix = await loc.getCurrent({ timeout: 15000, maximumAge: 0 });
    if (machine.state !== 'rally') return;
    const res = session.detector.checkIn(fix);
    session.detector.update(fix); // also feeds the odometer
    if (res.arrived) return complete('gps');
    if (res.reason === 'weak') {
      session.gpsTrouble++;
      toast(`GPS too weak (±${Math.round(fix.accuracy)} m)`);
    } else {
      haptic(80);
      toast('Not here');
    }
  } catch (err) {
    session.gpsTrouble++;
    toast(err.message || 'No position');
  } finally {
    btn.disabled = false;
    if (session.gpsTrouble >= 2) $('#manual-btn').hidden = false;
  }
}

async function manualVerify() {
  const ok = await confirmDialog({
    title: 'Confirm manually?',
    body: 'Counts as done, but not toward best times.',
    ok: 'I\'m there',
  });
  if (ok && machine.state === 'rally') complete('manual');
}

async function abandon() {
  const ok = await confirmDialog({ title: 'Abandon?', ok: 'Abandon', cancel: 'Keep going', danger: true });
  if (!ok || machine.state !== 'rally') return;
  if (!DEV) {
    stats = recordAbandon(stats);
    store.saveStats(stats);
  }
  store.clearActive();
  session.rally = null;
  go('abandon');
}

function complete(verified) {
  if (machine.state !== 'rally') return;
  const endedAt = Date.now();
  const r = session.rally;
  const entry = {
    date: endedAt,
    timeMs: elapsedMs(session.startedAt, endedAt),
    mode: r.mode,
    difficulty: r.difficulty,
    name: r.destination.name,
    label: r.destination.label,
    destId: r.destination.id,
    routeDistance: r.routeDistance,
    verified,
    dev: DEV,
  };
  let outcome = { isRecord: false, previousBest: stats.best[bestKey(r.mode, r.difficulty)] ?? null };
  if (!DEV) {
    outcome = recordResult(stats, entry);
    stats = outcome.stats;
    store.saveStats(stats);
  }
  session.result = { ...entry, travelled: session.detector?.distanceTravelled ?? null, outcome, destination: r.destination };
  store.clearActive();
  go('arrive');
}

// ---------------------------------------------------------------- discovered

onEnter.discovered = () => {
  const res = session.result;
  const d = res.destination;
  haptic([200, 80, 200, 80, 400]);
  $('#disc-kind').textContent = d.label ?? '';
  $('#disc-name').textContent = d.name;

  const pb = $('#disc-pb');
  const { isRecord, previousBest } = res.outcome;
  pb.classList.toggle('is-record', isRecord && res.verified === 'gps' && !res.dev);
  if (res.dev) pb.textContent = 'dev';
  else if (res.verified !== 'gps') pb.textContent = 'self-verified';
  else if (isRecord && previousBest != null) pb.textContent = `PB −${fmtDelta(previousBest - res.timeMs)}`;
  else if (isRecord) pb.textContent = 'PB';
  else pb.textContent = `+${fmtDelta(res.timeMs - previousBest)}`;

  const parts = [DIFFICULTIES[res.difficulty].label, fmtDist(res.routeDistance)];
  if (res.travelled != null) parts.push(`${fmtDist(res.travelled)} travelled`);
  $('#disc-meta').textContent = parts.join(' · ');

  animateTime($('#disc-time'), res.timeMs);

  const img = $('#disc-img');
  img.hidden = true;
  $('#disc-credit').hidden = true;
  findPhoto(d.tags).then((p) => {
    if (!p?.image || machine.state !== 'discovered' || session.result !== res) return;
    img.onload = () => {
      img.hidden = false;
      const credit = $('#disc-credit');
      const a = document.createElement('a');
      a.href = p.link ?? p.image;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `Photo: ${p.credit}`;
      credit.replaceChildren(a);
      credit.hidden = false;
    };
    img.alt = d.name;
    img.src = p.image;
  });

  destroyMap('disc');
  const { map, ready } = maps.createMap($('#disc-map'), { center: [d.lon, d.lat], zoom: 16.5 });
  session.maps.disc = map;
  maps.addMarker(map, d, 'finish');
  if (!reducedMotion()) {
    ready.then(() => session.maps.disc === map && map.easeTo({ bearing: map.getBearing() + 60, duration: 8000, easing: (t) => t }));
  }
};

onExit.discovered = () => destroyMap('disc');

function animateTime(el, ms) {
  if (reducedMotion()) {
    el.textContent = formatElapsed(ms);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 1000);
    el.textContent = formatElapsed(ms * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function share() {
  const res = session.result;
  if (!res) return;
  const text = `🏁 Blind Rally · ${formatElapsed(res.timeMs, { tenths: false })} · ${DIFFICULTIES[res.difficulty].label} · ${fmtDist(res.routeDistance)}`;
  const url = new URL('./', location.href).href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Blind Rally', text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Copied');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Sharing unavailable');
  }
}

// ---------------------------------------------------------------- stats

onEnter.stats = () => {
  $('#st-completed').textContent = String(stats.completed);
  $('#st-discovered').textContent = String(stats.discovered.length);
  $('#st-abandoned').textContent = String(stats.abandoned);
  $('#st-best').replaceChildren(
    ...Object.values(DIFFICULTIES).map((d) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = `${d.briefingSec}s`;
      th.title = d.label;
      tr.append(th);
      for (const mode of ['walk', 'drive']) {
        const td = document.createElement('td');
        const v = stats.best[bestKey(mode, d.id)];
        td.textContent = v == null ? '—' : formatElapsed(v, { tenths: false });
        td.classList.toggle('is-empty', v == null);
        tr.append(td);
      }
      return tr;
    }),
  );
  $('#st-history').replaceChildren(
    ...stats.history.map((h) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'history__n';
      name.textContent = h.name;
      name.title = new Date(h.date).toLocaleDateString();
      const time = document.createElement('span');
      time.className = `history__t${h.record ? ' is-pb' : ''}${h.verified === 'manual' ? ' is-manual' : ''}`;
      time.textContent = formatElapsed(h.timeMs, { tenths: false });
      li.append(name, time);
      return li;
    }),
  );
};

// ---------------------------------------------------------------- settings

onEnter.settings = (payload, from) => {
  if (from) session.settingsReturn = from === 'setup' ? 'setup' : 'home';
  $$('input[name="units"]').forEach((r) => { r.checked = r.value === settings.units; });
  $('#set-haptics').checked = settings.haptics;
  $('#set-awake').checked = settings.keepAwake;
  $('#app-version').textContent = `v${VERSION}${DEV ? ' dev' : ''}`;
};

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  store.saveSettings(settings);
}

// ---------------------------------------------------------------- dev simulator (?dev=1)

function devMove(fraction) {
  if (!loc.simulated || !session.rally) return;
  const target = session.rally.arrivalTargets[1] ?? session.rally.arrivalTargets[0];
  const cur = loc.position;
  if (fraction >= 1) {
    loc.setPosition({ lat: target.lat, lon: target.lon, accuracy: 8 });
    return;
  }
  loc.setPosition({ lat: cur.lat + (target.lat - cur.lat) * fraction, lon: cur.lon + (target.lon - cur.lon) * fraction, accuracy: 8 });
  toast(`${Math.round(haversine(loc.position, target))} m`);
}

// ---------------------------------------------------------------- events

const actions = {
  start: () => go('start'),
  stats: () => go('stats'),
  settings: () => go('settings'),
  back: () => go(machine.state === 'settings' && session.settingsReturn === 'setup' ? 'backToSetup' : 'back'),
  'use-location': () => useLocation(),
  scout: () => session.start && go('scout'),
  'cancel-scout': () => {
    session.scoutAbort?.abort();
    go('cancel');
  },
  'begin-now': () => endBriefing(),
  'check-in': () => checkIn(),
  'manual-verify': () => manualVerify(),
  abandon: () => abandon(),
  again: () => go('again'),
  home: () => go('home'),
  share: () => share(),
  'resume-active': () => resumeActive(true),
  'discard-active': async () => {
    const ok = await confirmDialog({ title: 'Abandon?', ok: 'Abandon', danger: true });
    if (!ok) return;
    stats = recordAbandon(stats);
    store.saveStats(stats);
    store.clearActive();
    onEnter.home();
  },
  'clear-data': async () => {
    const ok = await confirmDialog({ title: 'Erase all data?', body: 'Stats, history and settings on this device.', ok: 'Erase', danger: true });
    if (!ok) return;
    store.clearAll();
    settings = store.getSettings();
    stats = store.getStats();
    onEnter.settings({});
    toast('Erased');
  },
  'dev-step': () => devMove(0.5),
  'dev-arrive': () => devMove(1),
  'dev-weak': () => loc.simulated && loc.setPosition({ accuracy: loc.position.accuracy > 100 ? 8 : 150 }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'mode') {
    saveSettings({ mode: t.value });
    syncSetupControls();
    updateScoutButton();
  } else if (t.name === 'difficulty') {
    saveSettings({ difficulty: t.value });
  } else if (t.name === 'radius') {
    saveSettings(settings.mode === 'drive' ? { driveRadius: Number(t.value) } : { walkRadius: Number(t.value) });
  } else if (t.id === 'drive-ack') {
    updateScoutButton();
  } else if (t.name === 'units') {
    saveSettings({ units: t.value });
  } else if (t.id === 'set-haptics') {
    saveSettings({ haptics: t.checked });
  } else if (t.id === 'set-awake') {
    saveSettings({ keepAwake: t.checked });
  }
});

document.addEventListener('visibilitychange', () => {
  const s = machine.state;
  if (document.visibilityState === 'hidden') {
    // No background tracking: GPS stops the moment the page isn't visible.
    if (s === 'rally') {
      stopGps();
      setGps('off');
    }
  } else if (s === 'rally') {
    startGps();
    keepAwake(true);
  } else if (s === 'briefing') {
    keepAwake(true);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (['countdown', 'briefing', 'rally', 'scouting'].includes(machine.state)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('offline', () => {
  if (machine.state !== 'rally') toast('Offline');
});

// ---------------------------------------------------------------- boot / resume

function resumeActive(fromBanner = false) {
  const active = store.getActive();
  if (!active?.rally) return false;
  const now = Date.now();
  if (active.phase === 'briefing' && now < active.briefingEndsAt && active.rally.route) {
    session.rally = active.rally;
    session.briefingEndsAt = active.briefingEndsAt;
    machine.send('resumeBriefing', { resume: true });
    return true;
  }
  // Briefing expired while away, or we were mid-rally: the clock started when the briefing ended.
  const r = active.rally;
  session.rally = r.route
    ? { id: r.id, mode: r.mode, difficulty: r.difficulty, destination: r.destination, arrivalTargets: r.arrivalTargets, routeDistance: r.route.distance }
    : r;
  session.startedAt = active.phase === 'rally' ? active.startedAt : active.briefingEndsAt;
  if (!session.rally.destination || !session.startedAt) {
    store.clearActive();
    return false;
  }
  store.saveActive({ phase: 'rally', rally: session.rally, startedAt: session.startedAt });
  if (!fromBanner && now - session.startedAt > RESUME_WINDOW_MS) return false; // offer via the home banner instead
  machine.send('resume', { resumed: true });
  return true;
}

function boot() {
  if (!globalThis.maplibregl) {
    document.body.insertAdjacentHTML('afterbegin', '<p class="alert" role="alert">Map failed to load. Reload to try again.</p>');
  }
  document.body.dataset.screen = 'home';
  if (!resumeActive(false)) onEnter.home();
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !DEV) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }
}

boot();
