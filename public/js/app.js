// Blind Rally — UI controller. Wires the state machine to the DOM, GPS, maps and storage.

import { DIFFICULTIES, MODES, AVOID_RECENT, PEEK, SPEED_LIMIT_LOOKUP } from './config.js';
import { createMachine } from './state.js';
import { createStore, recordResult, recordAbandon, bestForMode, bestKey } from './storage.js';
import { generateRally } from './rally.js';
import { createArrivalDetector } from './arrival.js';
import { createGeoProvider, createSimProvider } from './location.js';
import { remainingMs, elapsedMs, formatElapsed, formatCountdown, createTicker } from './timer.js';
import { formatDistance, isValidCoord, haversine } from './geo.js';
import { findPhoto } from './photo.js';
import * as maps from './map.js';
import { createTracker, speedSeries, shrink } from './track.js';
import { scoreRally, styleFor, createSpeedWatch, SCORING } from './score.js';
import { fetchSpeedLimit } from './speedlimit.js';
import { renderCard } from './card.js';

const VERSION = '1.3.0';
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
  maps: { brief: null, disc: null, rally: null },
  wakeLock: null,
  tracker: null, // silent route tracking (track.js)
  peeks: 0,
  peeking: null,
  speed: null, // driving only: { watch, lastAt, lastPos, mph }
  lastFix: null,
  savedAt: 0,
  reviewing: false, // results screen opened from history
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
  const r = settings[`${settings.mode}Radius`];
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
  session.rally = rallyFromBriefing(session.rally);
  session.startedAt = Date.now();
  store.saveActive({ phase: 'rally', rally: session.rally, startedAt: session.startedAt });
  go('begin');
}

/** What the rally phase keeps. The route stays (scrambled at rest) for silent tracking and peeks — it's never drawn unless you peek. */
function rallyFromBriefing(r) {
  return {
    id: r.id,
    mode: r.mode,
    difficulty: r.difficulty,
    destination: r.destination,
    arrivalTargets: r.arrivalTargets,
    routeDistance: r.route.distance,
    etaSec: r.route.duration,
    start: r.start,
    geometry: r.route.geometry,
  };
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
  session.lastFix = null;
  session.savedAt = 0;
  session.devIndex = 0;
  if (payload.resumed) toast('Resumed — clock kept running');

  const geom = r.geometry ?? [];
  session.tracker = geom.length > 1
    ? createTracker(geom, { offRouteM: mode.offRouteM, maxAccuracy: mode.maxAcceptableAccuracy, state: r.trackState })
    : null;
  session.peeks = r.peeks ?? 0;
  renderPeek();
  session.speed = mode.speedLimits ? { watch: createSpeedWatch(), lastAt: 0, lastPos: null, mph: false } : null;
  if (session.speed) session.speed.watch.incidents = r.speeding ?? 0;
  $('#speed-limit').hidden = true;

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
  startRallyMap();
  startGps();
  keepAwake(true);
};

onExit.rally = () => {
  stopTicker();
  stopGps();
  endPeek();
  destroyMap('rally');
  session.me = null;
  keepAwake(false);
};

/** Persist tracking progress with the active rally so a refresh loses nothing. */
function saveProgress(force = false) {
  const now = Date.now();
  if (!force && now - session.savedAt < 10000) return;
  session.savedAt = now;
  session.rally = {
    ...session.rally,
    trackState: session.tracker?.snapshot(),
    peeks: session.peeks,
    speeding: session.speed?.watch.incidents ?? 0,
  };
  store.saveActive({ phase: 'rally', rally: session.rally, startedAt: session.startedAt });
}

// ---------------------------------------------------------------- peek

function renderPeek() {
  const left = PEEK.max - session.peeks;
  const btn = $('#peek-btn');
  btn.disabled = left <= 0 || !session.rally?.geometry?.length;
  btn.setAttribute('aria-label', `Peek at the route (${left} left, −${SCORING.peek} each)`);
  $('#peek-pips').replaceChildren(...Array.from({ length: PEEK.max }, (_, i) => {
    const pip = document.createElement('i');
    pip.classList.toggle('is-used', i >= left);
    return pip;
  }));
}

async function peek() {
  const r = session.rally;
  if (session.peeking || session.peeks >= PEEK.max || !r.geometry?.length) return;
  const ok = await confirmDialog({ title: 'Peek?', body: `${PEEK.seconds} s · −${SCORING.peek}`, ok: 'Peek', cancel: 'No' });
  const map = session.maps.rally;
  if (!ok || machine.state !== 'rally' || session.peeking || !map) return;
  session.peeks += 1;
  saveProgress(true);
  renderPeek();
  haptic(40);

  if (!map.getSource('br-route')) maps.addRoute(map, r.geometry);
  maps.setRouteVisible(map, true);
  const finish = maps.addMarker(map, r.geometry[r.geometry.length - 1], 'finish');
  const pts = session.lastFix ? [...r.geometry, session.lastFix] : r.geometry;
  const h = map.getContainer().clientHeight;
  maps.fitPoints(map, pts, { padding: { top: h * 0.22, bottom: h * 0.24, left: 30, right: 30 }, pitch: 30, bearing: map.getBearing(), duration: 600 });

  const endsAt = Date.now() + PEEK.seconds * 1000;
  $('#peek-btn').classList.add('is-on');
  const tick = () => {
    const left = Math.ceil((endsAt - Date.now()) / 1000);
    $('#peek-left').textContent = left > 0 ? String(left) : '';
    if (left <= 0) endPeek();
  };
  session.peeking = { finish, timer: setInterval(tick, 200) };
  tick();
}

function endPeek() {
  const p = session.peeking;
  if (!p) return;
  clearInterval(p.timer);
  p.finish.remove();
  session.peeking = null;
  $('#peek-btn').classList.remove('is-on');
  $('#peek-left').textContent = '';
  const map = session.maps.rally;
  if (map) {
    maps.setRouteVisible(map, false);
    if (session.lastFix) maps.follow(map, session.lastFix, null);
  }
}

// ---------------------------------------------------------------- speed limits (driving)

function updateSpeed(fix) {
  const sp = session.speed;
  if (!sp) return;
  sp.watch.update(fix.speed, fix.time ?? Date.now());
  const now = Date.now();
  const moved = sp.lastPos ? haversine(sp.lastPos, fix) : Infinity;
  if (now - sp.lastAt > SPEED_LIMIT_LOOKUP.minGapMs && moved > SPEED_LIMIT_LOOKUP.minMoveM && fix.accuracy < 50) {
    sp.lastAt = now;
    sp.lastPos = { lat: fix.lat, lon: fix.lon };
    fetchSpeedLimit(fix)
      .then((lim) => {
        if (session.speed !== sp) return;
        sp.watch.setLimit(lim?.kmh ?? null);
        sp.mph = lim ? lim.mph : settings.units === 'imperial';
        renderSpeed(sp.lastSpeed);
      })
      .catch(() => { /* Overpass busy: no limit shown, nothing counted */ });
  }
  sp.lastSpeed = fix.speed;
  renderSpeed(fix.speed);
}

function renderSpeed(speedMs) {
  const sp = session.speed;
  const el = $('#speed-limit');
  const lim = sp?.watch.limit;
  el.hidden = lim == null;
  if (lim == null) return;
  const conv = (kmh) => Math.round(sp.mph ? kmh / 1.609344 : kmh);
  el.classList.toggle('is-mph', sp.mph);
  $('#limit-value').textContent = String(conv(lim));
  const kmh = Number.isFinite(speedMs) ? speedMs * 3.6 : null;
  $('#speed-now').textContent = kmh == null ? '' : String(conv(kmh));
  el.classList.toggle('is-over', kmh != null && kmh > lim + 5);
  el.setAttribute('aria-label', `Limit ${conv(lim)} ${sp.mph ? 'mph' : 'km/h'}`);
}

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

// Locked map that only follows the player: no route, no destination, no panning.
function startRallyMap() {
  destroyMap('rally');
  session.me = null;
  const { map, ready } = maps.createMap($('#rally-map'), { zoom: 17, interactive: false });
  session.maps.rally = map;
  const name = session.rally.destination.name;
  ready.then(() => {
    if (session.maps.rally !== map) return;
    try { maps.hideLabel(map, name); } catch { /* labels are cosmetic */ }
  });
}

function showMe(fix) {
  const map = session.maps.rally;
  if (!map) return;
  const first = !session.me;
  if (first) session.me = maps.addMarker(map, fix, 'me');
  else session.me.setLngLat([fix.lon, fix.lat]);
  const heading = fix.speed > 1 && Number.isFinite(fix.heading) ? fix.heading : null;
  if (first) map.jumpTo({ center: [fix.lon, fix.lat] });
  if (!session.peeking) maps.follow(map, fix, heading);
}

function onFix(fix) {
  if (machine.state !== 'rally' || !session.detector) return;
  const st = session.detector.update(fix);
  if (st.quality === 'invalid') return;
  session.lastFix = fix;
  session.tracker?.update(fix);
  updateSpeed(fix);
  saveProgress();
  showMe(fix);
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
  endPeek();
  const timeMs = elapsedMs(session.startedAt, endedAt);
  const sum = session.tracker?.summary();
  const travelled = sum?.travelled ?? session.detector?.distanceTravelled ?? null;
  const inputs = {
    timeMs,
    etaSec: r.etaSec ?? null,
    routeDistance: r.routeDistance,
    travelled,
    accuracy: sum?.accuracy ?? null,
    wrongTurns: sum?.wrongTurns ?? 0,
    peeks: session.peeks,
    speeding: session.speed?.watch.incidents ?? 0,
    difficulty: r.difficulty,
  };
  // Rallies resumed from before scoring existed have no route estimate: no grade for those.
  const scored = r.etaSec ? scoreRally(inputs) : null;
  const style = scored ? styleFor(inputs, scored) : null;
  const fullTrack = session.tracker?.track ?? [];
  const entry = {
    date: endedAt,
    timeMs,
    mode: r.mode,
    difficulty: r.difficulty,
    name: r.destination.name,
    label: r.destination.label,
    destId: r.destination.id,
    routeDistance: r.routeDistance,
    verified,
    dev: DEV,
    ...(scored && {
      score: scored.score,
      grade: scored.grade,
      parts: scored.parts,
      style: { name: style.name, line: style.line },
      accuracy: inputs.accuracy,
      wrongTurns: inputs.wrongTurns,
      peeks: inputs.peeks,
      speeding: inputs.speeding,
      travelled,
      etaSec: inputs.etaSec,
      track: packTrack(fullTrack),
      route: r.geometry ? shrink(r.geometry, 200).map((p) => ({ lat: round5(p.lat), lon: round5(p.lon) })) : undefined,
      dest: { lat: r.destination.lat, lon: r.destination.lon, tags: photoTags(r.destination.tags) },
    }),
  };
  let outcome = { isRecord: false, previousBest: stats.best[bestKey(r.mode, r.difficulty)] ?? null };
  if (!DEV) {
    outcome = recordResult(stats, entry);
    stats = outcome.stats;
    store.saveStats(stats);
  }
  session.result = { ...entry, travelled, outcome, destination: r.destination, fullTrack };
  store.clearActive();
  go('arrive');
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

/** Only the tags findPhoto needs, so a replay can show the photo without storing everything. */
function photoTags(tags = {}) {
  const out = {};
  for (const k of ['wikipedia', 'wikidata', 'wikimedia_commons', 'image']) if (tags[k]) out[k] = tags[k];
  return out;
}

/** Shrink a recorded track to ≤300 points for history, keeping [lat, lon, t, off, speed]. */
function packTrack(track) {
  if (track.length < 2) return track;
  const pts = track.map(([lat, lon, t, off, v]) => ({ lat, lon, t, off, v }));
  return shrink(pts, 300).map((p) => [p.lat, p.lon, p.t, p.off, p.v]);
}

// ---------------------------------------------------------------- discovered

onEnter.discovered = (payload) => {
  const res = session.result;
  const d = res.destination;
  session.reviewing = Boolean(payload.review);
  if (!session.reviewing) haptic([200, 80, 200, 80, 400]);
  $('#disc-kind').textContent = d.label ?? '';
  $('#disc-name').textContent = d.name;

  const pb = $('#disc-pb');
  const { isRecord, previousBest } = res.outcome;
  pb.classList.toggle('is-record', !session.reviewing && isRecord && res.verified === 'gps' && !res.dev);
  if (session.reviewing) pb.textContent = new Date(res.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  else if (res.dev) pb.textContent = 'dev';
  else if (res.verified !== 'gps') pb.textContent = 'self-verified';
  else if (isRecord && previousBest != null) pb.textContent = `PB −${fmtDelta(previousBest - res.timeMs)}`;
  else if (isRecord) pb.textContent = 'PB';
  else pb.textContent = `+${fmtDelta(res.timeMs - previousBest)}`;

  const parts = [DIFFICULTIES[res.difficulty].label, fmtDist(res.routeDistance)];
  if (res.travelled != null) parts.push(`${fmtDist(res.travelled)} travelled`);
  $('#disc-meta').textContent = parts.join(' · ');

  animateTime($('#disc-time'), res.timeMs);
  renderScore(res);

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
  const track = res.fullTrack?.length ? res.fullTrack : res.track ?? [];
  const route = res.route ?? [];
  if (track.length > 1 || route.length > 1) {
    // Your run against the briefed route: dashed = what you memorized, orange = where you went, red = off route.
    const pts = [...route, ...track.map(([lat, lon]) => ({ lat, lon }))];
    if (track.length) maps.addMarker(map, { lat: track[0][0], lon: track[0][1] }, 'start-sm');
    ready.then(() => {
      if (session.maps.disc !== map) return;
      maps.fitPoints(map, pts, { padding: { top: 30, bottom: 60, left: 30, right: 30 }, pitch: 35, duration: reducedMotion() ? 0 : 1200 });
      if (route.length > 1) maps.addIdealRoute(map, route);
      if (track.length > 1) {
        maps.addTrack(map, reducedMotion() ? track : track.slice(0, 2));
        if (!reducedMotion()) drawTrack(map, track);
      }
    });
  } else if (!reducedMotion()) {
    ready.then(() => session.maps.disc === map && map.easeTo({ bearing: map.getBearing() + 60, duration: 8000, easing: (t) => t }));
  }
};

/** Replay your path onto the results map. */
function drawTrack(map, track) {
  setTimeout(() => {
    const t0 = performance.now();
    const step = (t) => {
      if (session.maps.disc !== map) return;
      const k = Math.min(1, (t - t0) / 2200);
      maps.setTrack(map, track.slice(0, Math.max(2, Math.ceil(track.length * (1 - Math.pow(1 - k, 2))))));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, 900);
}

const PART_LABELS = {
  difficulty: () => 'Briefing time',
  pace: () => 'Pace',
  accuracy: () => 'Off route',
  distance: () => 'Extra distance',
  wrongTurns: (r) => `Wrong turns ×${r.wrongTurns}`,
  peeks: (r) => `Peeks ×${r.peeks}`,
  speeding: (r) => `Speeding ×${r.speeding}`,
  clean: () => 'Clean run',
};

function renderScore(res) {
  const has = res.grade != null;
  $('#disc-grade-box').hidden = !has;
  $('#disc-stats').hidden = !has;
  $('#disc-breakdown').hidden = !has;
  $('#disc-breakdown').open = false;
  if (!has) return;
  const g = $('#disc-grade');
  g.textContent = res.grade;
  g.dataset.g = res.grade;
  $('#disc-style').textContent = res.style?.name ?? '';
  $('#disc-style-line').textContent = res.style?.line ?? '';
  $('#disc-score').textContent = `${res.score} / 1000`;
  $('#disc-acc').textContent = res.accuracy == null ? '—' : `${res.accuracy}%`;
  $('#disc-wrong').textContent = String(res.wrongTurns ?? 0);
  $('#disc-peeks').textContent = String(res.peeks ?? 0);

  const row = (label, pts, kind = 'part') => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    if (kind === 'part') {
      b.textContent = pts > 0 ? `+${pts}` : `−${Math.abs(pts)}`;
      b.className = pts < 0 ? 'is-neg' : 'is-pos';
    } else {
      b.textContent = String(pts);
      if (kind === 'total') li.className = 'is-total';
    }
    li.append(label, b);
    return li;
  };
  $('#disc-parts').replaceChildren(
    row('Base', SCORING.base, 'base'),
    ...(res.parts ?? []).map((p) => row(PART_LABELS[p.key]?.(res) ?? p.key, p.points)),
    row('Total', res.score, 'total'),
  );

  const svg = $('#disc-speed');
  const series = speedSeries(res.fullTrack?.length ? res.fullTrack : res.track ?? [], 48);
  if (series.length < 4) {
    svg.replaceChildren();
    return;
  }
  const max = Math.max(...series.map((p) => p.v), 0.5);
  const xy = series.map((p, i) => `${((i / (series.length - 1)) * 300).toFixed(1)},${(78 - (p.v / max) * 72).toFixed(1)}`);
  const NS = 'http://www.w3.org/2000/svg';
  const area = document.createElementNS(NS, 'polygon');
  area.setAttribute('points', `0,80 ${xy.join(' ')} 300,80`);
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', xy.join(' '));
  svg.replaceChildren(area, line);
  const top = settings.units === 'imperial' ? `${Math.round(max * 2.23694)} mph` : `${Math.round(max * 3.6)} km/h`;
  svg.setAttribute('aria-label', `Speed over time, top ${top}`);
}

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
  const grade = res.grade ? ` · ${res.grade} ${res.score}` : '';
  const text = `🏁 Blind Rally · ${formatElapsed(res.timeMs, { tenths: false })}${grade} · ${DIFFICULTIES[res.difficulty].label} · ${fmtDist(res.routeDistance)}`;
  const url = new URL('./', location.href).href;
  if (res.grade && (await shareCard(res, text, url))) return;
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

/** Share (or save) the image card. Returns false to fall back to text. */
async function shareCard(res, text, url) {
  let blob;
  try {
    blob = await renderCard({
      grade: res.grade,
      score: res.score,
      style: res.style ?? { name: 'Blind Rally', line: '' },
      name: res.name,
      label: res.label,
      time: formatElapsed(res.timeMs, { tenths: false }),
      stats: [
        ['On route', res.accuracy == null ? '—' : `${res.accuracy}%`],
        ['Wrong turns', res.wrongTurns ?? 0],
        ['Peeks', res.peeks ?? 0],
        ['Distance', fmtDist(res.travelled ?? res.routeDistance)],
      ],
      route: res.route,
      track: res.track,
      url: url.replace(/^https?:[/][/]/, '').replace(/[/]$/, ''),
    });
  } catch {
    return false;
  }
  const file = new File([blob], 'blind-rally.png', { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: `${text} ${url}` });
      return true;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Saved image');
  return true;
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
      for (const mode of Object.keys(MODES)) {
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
    ...stats.history.map((h, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = 'review';
      btn.dataset.i = String(i);
      const grade = document.createElement('span');
      grade.className = 'history__g';
      grade.textContent = h.grade ?? '';
      grade.dataset.g = h.grade ?? '';
      const name = document.createElement('span');
      name.className = 'history__n';
      name.textContent = h.name;
      name.title = new Date(h.date).toLocaleDateString();
      const time = document.createElement('span');
      time.className = `history__t${h.record ? ' is-pb' : ''}${h.verified === 'manual' ? ' is-manual' : ''}`;
      time.textContent = formatElapsed(h.timeMs, { tenths: false });
      btn.append(grade, name, time);
      li.append(btn);
      return li;
    }),
  );
};

function review(i) {
  const h = stats.history[i];
  const dest = h?.dest ?? h?.route?.at(-1);
  if (!dest) return toast('No replay for this one');
  session.result = {
    ...h,
    destination: { ...dest, name: h.name, label: h.label },
    outcome: { isRecord: h.record, previousBest: null },
  };
  go('review', { review: true });
}

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
  const g = session.rally.geometry;
  if (g?.length > 1 && fraction < 1) {
    // Walk along the briefed route so tracking sees a realistic run.
    session.devIndex = Math.min(g.length - 1, session.devIndex + Math.max(1, Math.round(g.length / 6)));
    const p = g[session.devIndex];
    loc.setPosition({ lat: p.lat, lon: p.lon, accuracy: 8 });
    return;
  }
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
  peek: () => peek(),
  review: (el) => review(Number(el.dataset.i)),
  'manual-verify': () => manualVerify(),
  abandon: () => abandon(),
  again: () => go('again'),
  home: () => go(session.reviewing ? 'stats' : 'home'),
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
  'dev-off': () => loc.simulated && loc.setPosition({ lat: loc.position.lat + 0.0012, lon: loc.position.lon + 0.0015, accuracy: 8 }),
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
    saveSettings({ [`${settings.mode}Radius`]: Number(t.value) });
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
  session.rally = r.route ? rallyFromBriefing(r) : r;
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
