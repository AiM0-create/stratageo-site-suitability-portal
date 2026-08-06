// v1.12.0 — Leaflet -> Mapbox GL JS geometry conversion.
//
// The migration's biggest hazard is coordinate order: Leaflet takes
// [lat, lng]; GeoJSON and Mapbox take [lng, lat]. Every ring the backend sends
// is [lat, lng] because it was authored for Leaflet. Getting it wrong throws
// nothing — it just renders the hex grid in the wrong hemisphere — so these
// tests use real Indian coordinates where a swap is unmistakable (Mumbai is
// lat ~19, lng ~72; a swap would put it at lat 72, off the map).

import { describe, it, expect } from 'vitest';
import {
  toLngLatRing, circleRingLngLat, boundsOfLatLng, stretch, rampColor,
} from '../services/mapGeo';

// A small square near Mumbai, in the backend's [lat, lng] order.
const MUMBAI_RING: [number, number][] = [
  [19.00, 72.80], [19.00, 72.85], [19.05, 72.85], [19.05, 72.80],
];

describe('toLngLatRing', () => {
  it('swaps [lat,lng] to [lng,lat]', () => {
    const out = toLngLatRing(MUMBAI_RING)!;
    // First vertex must be [72.80, 19.00] — longitude first.
    expect(out[0]).toEqual([72.80, 19.00]);
    // A swap error would put latitude >90 into the longitude slot.
    expect(out.every(([lng, lat]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180)).toBe(true);
  });

  it('closes the ring, as GeoJSON requires and Leaflet did not', () => {
    const out = toLngLatRing(MUMBAI_RING)!;
    expect(out).toHaveLength(MUMBAI_RING.length + 1);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it('does not double-close an already closed ring', () => {
    const closed: [number, number][] = [...MUMBAI_RING, [19.00, 72.80]];
    const out = toLngLatRing(closed)!;
    expect(out).toHaveLength(closed.length);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it('drops malformed vertices rather than emitting NaN geometry', () => {
    const dirty = [
      [19.0, 72.8], [NaN, 72.85], [19.05, 72.85], null, [19.05, 72.80],
    ] as unknown as [number, number][];
    const out = toLngLatRing(dirty)!;
    expect(out.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))).toBe(true);
    expect(out.length).toBe(4);   // 3 good vertices + closing point
  });

  it('returns null for anything that cannot be a polygon', () => {
    expect(toLngLatRing(null)).toBeNull();
    expect(toLngLatRing(undefined)).toBeNull();
    expect(toLngLatRing([])).toBeNull();
    expect(toLngLatRing([[19, 72], [19.1, 72.1]])).toBeNull();   // only 2 vertices
  });
});

describe('circleRingLngLat', () => {
  it('emits a closed [lng,lat] ring centred on the point', () => {
    const ring = circleRingLngLat(19.0, 72.8, 1000)!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const lngs = ring.map(p => p[0]);
    const lats = ring.map(p => p[1]);
    // Centre of the ring is the requested point (longitude first).
    expect((Math.min(...lngs) + Math.max(...lngs)) / 2).toBeCloseTo(72.8, 3);
    expect((Math.min(...lats) + Math.max(...lats)) / 2).toBeCloseTo(19.0, 3);
  });

  it('is round on the ground, not in degrees (cos-latitude correction)', () => {
    // Without the correction a 1km circle at lat 19 would be ~5% too narrow.
    const ring = circleRingLngLat(19.0, 72.8, 1000)!;
    const latSpanKm = (Math.max(...ring.map(p => p[1])) - Math.min(...ring.map(p => p[1]))) * 111.32;
    const lngSpanKm = (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])))
      * 111.32 * Math.cos((19.0 * Math.PI) / 180);
    expect(lngSpanKm).toBeCloseTo(latSpanKm, 1);
    expect(latSpanKm).toBeCloseTo(2.0, 1);   // 1km radius -> 2km across
  });

  it('scales with the requested radius', () => {
    const small = circleRingLngLat(19, 72.8, 500)!;
    const big = circleRingLngLat(19, 72.8, 2000)!;
    const span = (r: [number, number][]) =>
      Math.max(...r.map(p => p[1])) - Math.min(...r.map(p => p[1]));
    expect(span(big) / span(small)).toBeCloseTo(4, 1);
  });

  it('rejects degenerate input instead of emitting a broken polygon', () => {
    expect(circleRingLngLat(19, 72.8, 0)).toBeNull();
    expect(circleRingLngLat(19, 72.8, -100)).toBeNull();
    expect(circleRingLngLat(NaN, 72.8, 500)).toBeNull();
  });

  it('does not blow up at the poles', () => {
    const ring = circleRingLngLat(90, 0, 1000);
    expect(ring).not.toBeNull();
    expect(ring!.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))).toBe(true);
  });
});

describe('boundsOfLatLng', () => {
  it('returns Mapbox [[w,s],[e,n]] order', () => {
    const b = boundsOfLatLng([
      { lat: 19.0, lng: 72.8 }, { lat: 19.1, lng: 72.9 },
    ])!;
    expect(b).toEqual([[72.8, 19.0], [72.9, 19.1]]);
  });

  it('ignores invalid points and returns null when none remain', () => {
    const b = boundsOfLatLng([
      { lat: NaN, lng: 72.8 }, { lat: 19.1, lng: 72.9 },
    ])!;
    expect(b).toEqual([[72.9, 19.1], [72.9, 19.1]]);
    expect(boundsOfLatLng([])).toBeNull();
    expect(boundsOfLatLng([{ lat: NaN, lng: NaN }])).toBeNull();
  });
});

describe('stretch + rampColor (unchanged from the Leaflet map)', () => {
  it('maps the observed range onto 0..1', () => {
    expect(stretch(5, 5, 9)).toBe(0);
    expect(stretch(9, 5, 9)).toBe(1);
    expect(stretch(7, 5, 9)).toBeCloseTo(0.5, 6);
  });

  it('does not divide by zero on a flat range', () => {
    expect(Number.isFinite(stretch(5, 5, 5))).toBe(true);
  });

  it('clamps out-of-range values', () => {
    expect(stretch(1, 5, 9)).toBe(0);
    expect(stretch(99, 5, 9)).toBe(1);
  });

  it('ramps red -> green, matching the PDF figure formula', () => {
    expect(rampColor(0)).toBe('hsl(0, 80%, 46%)');
    expect(rampColor(1)).toBe('hsl(130, 80%, 46%)');
  });
});
