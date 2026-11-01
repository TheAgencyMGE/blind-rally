// Central configuration. Everything a self-hoster might want to change lives here.

export const DIFFICULTIES = {
  rookie: { id: 'rookie', label: 'Rookie', briefingSec: 60 },
  pro: { id: 'pro', label: 'Pro', briefingSec: 30 },
  insane: { id: 'insane', label: 'Insane', briefingSec: 15 },
};

export const MODES = {
  walk: {
    id: 'walk',
    label: 'Walking',
    osrmProfile: 'foot',
    // Destination radius bounds (metres) offered in settings.
    radiusOptions: [500, 1000, 1500, 2000, 3000],
    defaultRadius: 1500,
    arrivalRadius: 35,
    maxAcceptableAccuracy: 60,
    dwellMs: 6000,
    maxDwellSpeed: 3, // m/s — faster than this and you're passing by, not arriving
    maxSnapDistance: 80, // POI must be within this many metres of a walkable way
    offRouteM: 40, // further than this from the briefed route (beyond GPS accuracy) = off route
  },
  bike: {
    id: 'bike',
    label: 'Cycling',
    osrmProfile: 'bike',
    radiusOptions: [1000, 2000, 3000, 5000, 8000],
    defaultRadius: 3000,
    arrivalRadius: 45,
    maxAcceptableAccuracy: 60,
    dwellMs: 6000,
    maxDwellSpeed: 3.5,
    maxSnapDistance: 100,
    offRouteM: 45,
  },
  drive: {
    id: 'drive',
    label: 'Driving',
    osrmProfile: 'driving',
    radiusOptions: [2000, 4000, 6000, 10000, 15000],
    defaultRadius: 4000,
    arrivalRadius: 60,
    maxAcceptableAccuracy: 80,
    dwellMs: 10000,
    maxDwellSpeed: 4,
    maxSnapDistance: 150,
    offRouteM: 60,
    speedLimits: true, // look up OSM maxspeed and count speeding
  },
};

// What a rally sends you to.
//  landmark: a named public place (the classic game)
//  random:   a random public spot on the path/road network: never fails for lack of landmarks, could be great or grim
//  city:     a town or city far away, with only vague directions. You find your own way.
export const TARGETS = {
  landmark: { id: 'landmark', label: 'Landmark' },
  random: { id: 'random', label: 'Random spot' },
  city: { id: 'city', label: 'City' },
};

// Random spots: how many random points we'll try to route to before settling for the least-bad one.
export const RANDOM_ATTEMPTS = 8;

export const CITY = {
  // Much wider search than landmarks, per travel mode (metres).
  radiusOptions: {
    walk: [3000, 5000, 8000, 12000, 16000],
    bike: [8000, 15000, 25000, 40000, 60000],
    drive: [20000, 40000, 70000, 100000, 150000],
  },
  defaultRadius: { walk: 5000, bike: 15000, drive: 40000 },
  // Which OSM place types count, per mode. On foot a new suburb is a big enough trip.
  places: {
    walk: ['town', 'village', 'suburb', 'quarter', 'neighbourhood'],
    bike: ['city', 'town', 'village', 'suburb'],
    drive: ['city', 'town'],
  },
  // You've arrived when you're inside the place, roughly. Bigger places, bigger zone.
  arrivalRadius: { city: 2500, town: 1200, suburb: 800, village: 500, quarter: 450, neighbourhood: 400 },
  minFraction: 0.25, // not the town you're already in
  overpassTimeoutMs: 16000, // then fall back to Wikipedia
};

// Destinations are never closer than this fraction of the max radius (straight line).
export const MIN_RADIUS_FRACTION = 0.35;
// Reject routes that are far longer than the radius suggests (rivers, motorways, detours).
export const MAX_ROUTE_DETOUR = 2.2;
// Routes with more maneuvers than this are unmemorable mazes — skip them.
export const MAX_ROUTE_STEPS = 22;
// How many candidates we're willing to route before giving up.
export const MAX_ROUTE_ATTEMPTS = 6;

export const SERVICES = {
  // Overpass API (OpenStreetMap data). Add mirrors here; they're tried in order.
  // When all fail, places come from Wikipedia geosearch instead (see rally.js).
  overpass: ['https://overpass-api.de/api/interpreter'],
  // OSRM-compatible routers per profile. The FOSSGIS servers support foot + car;
  // the OSRM demo server is car-only and used as a driving fallback.
  routing: {
    foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/foot'],
    bike: ['https://routing.openstreetmap.de/routed-bike/route/v1/bike'],
    driving: [
      'https://routing.openstreetmap.de/routed-car/route/v1/driving',
      'https://router.project-osrm.org/route/v1/driving',
    ],
  },
  // Free vector tiles, no key, no usage limits (https://openfreemap.org).
  mapStyle: 'https://tiles.openfreemap.org/styles/dark',
  wikidata: 'https://www.wikidata.org/w/api.php',
  // Fallback place source when Overpass is unavailable.
  wikipediaApi: (lang) => `https://${lang}.wikipedia.org/w/api.php`,
  wikipediaSummary: (lang, title) =>
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  commonsFile: (file, width = 800) =>
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`,
};

// Politeness: minimum gap between requests to the same public service.
export const MIN_REQUEST_GAP_MS = { overpass: 2000, routing: 1100, wiki: 200 };
export const REQUEST_TIMEOUT_MS = { overpass: 8000, routing: 12000, wiki: 8000 };
// Overpass results are cached in memory (never on disk) so "play again" doesn't re-query.
export const POI_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Peeks: brief looks at the route mid-rally, each costing points (see score.js).
export const PEEK = { max: 3, seconds: 8 };
// Speed limit lookups while driving: at most this often, and only after moving this far.
export const SPEED_LIMIT_LOOKUP = { minGapMs: 45000, minMoveM: 250 };

export const HISTORY_LIMIT = 30;
export const AVOID_RECENT = 15; // don't repeat one of the last N destinations
