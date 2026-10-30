// MapLibre GL wrapper: tilted 3D vector map with extruded buildings.
// MapLibre is loaded as a classic script (vendor/maplibre, CSP build) and exposes `maplibregl`.

import { SERVICES } from './config.js';
import { bearing } from './geo.js';

const gl = () => globalThis.maplibregl;
let workerSet = false;

/** Style tweaks: hide flat buildings, add 3D extrusions, drop anything that could spoil a destination. */
function decorate(map) {
  const style = map.getStyle();
  for (const layer of style.layers) {
    if (layer.id === 'building') map.setLayoutProperty(layer.id, 'visibility', 'none');
    if (layer.type === 'symbol' && /poi|water_name|place_other|place_suburb/.test(layer.id)) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  }
  const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({
    id: 'br-buildings-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#2a2c33', 60, '#3b3e48'],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.9,
    },
  }, firstSymbol);
}

/**
 * Create a map. Resolves once the style is loaded and decorated.
 * `flat` gives a top-down 2D view (used for tapping a start point).
 */
export function createMap(el, { center = [0, 20], zoom = 1.5, flat = false, interactive = true } = {}) {
  if (!workerSet) {
    gl().setWorkerUrl(new URL('../vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href);
    workerSet = true;
  }
  const map = new (gl().Map)({
    container: el,
    style: SERVICES.mapStyle,
    center,
    zoom,
    pitch: flat ? 0 : 55,
    maxPitch: 70,
    interactive,
    attributionControl: { compact: true },
    dragRotate: !flat,
    pitchWithRotate: !flat,
    fadeDuration: 0,
  });
  if (flat) map.touchZoomRotate.disableRotation();
  const ready = new Promise((resolve) => {
    map.once('load', () => {
      try { decorate(map); } catch { /* style changed upstream: plain map still works */ }
      el.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      resolve(map);
    });
  });
  return { map, ready };
}

function markerEl(cls) {
  const el = document.createElement('div');
  el.className = `mk ${cls}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function addMarker(map, p, kind) {
  return new (gl().Marker)({ element: markerEl(`mk--${kind}`) }).setLngLat([p.lon, p.lat]).addTo(map);
}

export function addRoute(map, geometry) {
  const data = { type: 'Feature', geometry: { type: 'LineString', coordinates: geometry.map((p) => [p.lon, p.lat]) } };
  map.addSource('br-route', { type: 'geojson', data });
  map.addLayer({ id: 'br-route-casing', type: 'line', source: 'br-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 11, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'br-route', type: 'line', source: 'br-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ff8a1f', 'line-width': 6 } });
}

/** Frame the route tilted, rotated so the journey runs up the screen. */
export function frameRoute(map, geometry, padding) {
  const b = new (gl().LngLatBounds)();
  geometry.forEach((p) => b.extend([p.lon, p.lat]));
  const heading = bearing(geometry[0], geometry[geometry.length - 1]);
  map.fitBounds(b, { padding, bearing: heading, pitch: 50, maxZoom: 17, duration: 0 });
}

/** Blank out any map label equal to `name` (a road or area destination would otherwise label itself). */
export function hideLabel(map, name) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol' || !map.getLayoutProperty(layer.id, 'text-field')) continue;
    map.setLayoutProperty(layer.id, 'text-field', [
      'case',
      ['==', ['get', 'name'], name], '',
      ['coalesce', ['get', 'name:latin'], ['get', 'name'], ''],
    ]);
  }
}
