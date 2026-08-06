/**
 * v1.12.0 — geometry helpers for the Mapbox GL JS map.
 *
 * These exist because of the single most dangerous difference between Leaflet
 * and Mapbox GL JS: **coordinate order**. Leaflet takes `[lat, lng]`; GeoJSON
 * and Mapbox take `[lng, lat]`. Every ring the backend sends (H3 cell
 * boundaries, the study-area outline, catchment isochrones) is `[lat, lng]`
 * because it was authored for Leaflet. A silent swap does not throw — it
 * renders your hexes in the wrong hemisphere — so the conversion lives here,
 * in one place, under test, instead of being inlined at a dozen call sites.
 */

/** A ring as the backend sends it: [lat, lng] pairs. */
export type LatLngRing = [number, number][];
/** A ring as GeoJSON/Mapbox wants it: [lng, lat] pairs. */
export type LngLatRing = [number, number][];

const isFinitePair = (p: unknown): p is [number, number] =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Convert a [lat,lng] ring to a closed [lng,lat] ring for GeoJSON.
 *
 * Also drops malformed vertices and closes the ring (GeoJSON requires the
 * first and last position to be identical — Leaflet did not).
 * Returns null when fewer than 3 valid vertices remain, so callers can skip
 * the feature rather than emit invalid geometry.
 */
export function toLngLatRing(ring: LatLngRing | undefined | null): LngLatRing | null {
  if (!Array.isArray(ring)) return null;
  const out: LngLatRing = [];
  for (const p of ring) {
    if (!isFinitePair(p)) continue;
    out.push([p[1], p[0]]);          // [lat,lng] -> [lng,lat]
  }
  if (out.length < 3) return null;
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

/**
 * A circle of `radiusM` around a point, as a closed [lng,lat] ring.
 *
 * Leaflet had `L.circle(latlng, {radius: metres})`; Mapbox GL JS has no
 * metre-radius primitive, so search radii and CSV buffers must be emitted as
 * real polygons. Longitude degrees shrink with latitude, hence the cos(lat)
 * correction — without it a 1 km circle in Mumbai renders visibly elliptical.
 */
export function circleRingLngLat(
  lat: number, lng: number, radiusM: number, steps = 64,
): LngLatRing | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radiusM > 0)) return null;
  const latDeg = radiusM / 111_320;                                  // metres per degree lat
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDeg = Math.abs(cos) < 1e-6 ? latDeg : latDeg / cos;       // guard at the poles
  const ring: LngLatRing = [];
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * 2 * Math.PI;
    ring.push([lng + lngDeg * Math.cos(th), lat + latDeg * Math.sin(th)]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** Bounding box of some points, as Mapbox's [[w,s],[e,n]]. Null if none valid. */
export function boundsOfLatLng(
  points: { lat: number; lng: number }[],
): [[number, number], [number, number]] | null {
  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of valid) {
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [[w, s], [e, n]];
}

/**
 * Contrast-stretch a value into 0..1 across the observed range.
 *
 * Ported unchanged from the Leaflet implementation so the colour ramp is
 * identical before and after the migration — a mid-range grid must not
 * suddenly look different just because the renderer changed.
 */
export function stretch(v: number, lo: number, hi: number): number {
  const span = hi - lo > 0.1 ? hi - lo : 1;
  return Math.max(0, Math.min(1, (v - lo) / span));
}

/** Red → amber → green ramp. Identical formula to the Leaflet map + PDF figure. */
export const rampColor = (t: number) =>
  `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 130)}, 80%, 46%)`;
