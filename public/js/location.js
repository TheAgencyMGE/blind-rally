// Location providers. Only used in the foreground: we never track in the background.
// `createGeoProvider` wraps the browser API; `createSimProvider` is the ?dev=1 simulator
// used for desktop testing (its results are never saved to stats). Its start position can
// be set with ?dev=1&at=lat,lon.

export class LocationError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'denied' | 'unavailable' | 'timeout' | 'unsupported'
  }
}

const MESSAGES = {
  denied: 'Blind Rally starts from where you are. Allow location for this site in your browser settings, then try again.',
  unavailable: 'Your device couldn\'t determine its location. Move somewhere with a clearer view of the sky and try again.',
  timeout: 'Getting a GPS fix took too long. Try again, ideally outdoors.',
  unsupported: 'This browser doesn\'t support location.',
};

function toFix(pos) {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
    speed: pos.coords.speed,
    time: pos.timestamp || Date.now(),
  };
}

function toError(err) {
  const kind = err?.code === 1 ? 'denied' : err?.code === 3 ? 'timeout' : 'unavailable';
  return new LocationError(kind, MESSAGES[kind]);
}

export function createGeoProvider(geo = globalThis.navigator?.geolocation) {
  return {
    simulated: false,
    supported: Boolean(geo),
    getCurrent({ timeout = 15000, maximumAge = 0 } = {}) {
      if (!geo) return Promise.reject(new LocationError('unsupported', MESSAGES.unsupported));
      return new Promise((resolve, reject) => {
        geo.getCurrentPosition(
          (p) => resolve(toFix(p)),
          (e) => reject(toError(e)),
          { enableHighAccuracy: true, timeout, maximumAge },
        );
      });
    },
    watch(onFix, onError) {
      if (!geo) {
        onError(new LocationError('unsupported', MESSAGES.unsupported));
        return () => {};
      }
      const id = geo.watchPosition(
        (p) => onFix(toFix(p)),
        (e) => onError(toError(e)),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
      );
      return () => geo.clearWatch(id);
    },
    /** 'granted' | 'denied' | 'prompt' | 'unknown' — never triggers a prompt. */
    async permission() {
      try {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        return st.state;
      } catch {
        return 'unknown';
      }
    },
  };
}

export function createSimProvider(initial = { lat: 47.6097, lon: -122.3422 }) {
  let pos = { ...initial, accuracy: 8 };
  const watchers = new Set();
  const emit = () => {
    const fix = { ...pos, speed: 0, time: Date.now() };
    watchers.forEach((w) => w(fix));
  };
  let timer = null;
  return {
    simulated: true,
    supported: true,
    getCurrent: () => Promise.resolve({ ...pos, speed: 0, time: Date.now() }),
    watch(onFix) {
      watchers.add(onFix);
      if (!timer) timer = setInterval(emit, 1000);
      emit();
      return () => {
        watchers.delete(onFix);
        if (!watchers.size) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    permission: async () => 'granted',
    setPosition(p) {
      pos = { ...pos, ...p };
      emit();
    },
    get position() {
      return { ...pos };
    },
  };
}
