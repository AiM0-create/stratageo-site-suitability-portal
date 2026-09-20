// v2.7.0 — the exported report must carry its map and keep its text on the page.
//
// The live "High end gym / Kashmiri Market" export (20 Sep 2026) shipped with
// no basemap: a 1.5 km spot extent asked for zoom 16 with 256 px tiles — 56
// tiles, over the 32-tile cap — so the figure silently fell back to hexes on
// white and the client read it as "the map is not there". Every paragraph
// also ran off the right edge because text was wrapped at the previous font
// size and drawn at a larger one. The layout kit is exercised in the browser;
// what can be pinned in jsdom is the tile budget and the pure text helpers.
import { describe, it, expect } from 'vitest';
import { basemapZoom, tileCount, MAX_TILES, TILE_SIZE } from '../services/mapFigure';
import { asciiSafe, factorMix, originText } from '../services/pdfReport';
import type { MCDACriteria } from '../types';

const xFrac = (lng: number) => (lng + 180) / 360;
const yFrac = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

// the Kashmiri Market spot: ~1.5 km radius at 28.63 N with the 5% figure pad
const SPOT = { minLat: 28.617, maxLat: 28.647, minLng: 77.205, maxLng: 77.240 };
// a city-scale brief: ~12 km across Bengaluru
const CITY = { minLat: 12.90, maxLat: 13.02, minLng: 77.52, maxLng: 77.68 };

const bounds = (b: typeof SPOT) => [xFrac(b.minLng), xFrac(b.maxLng), yFrac(b.maxLat), yFrac(b.minLat)] as const;

describe('basemapZoom — the tile budget', () => {
  it('a 1.5 km spot extent gets a basemap (the v2.6.1 report did not)', () => {
    const [xf0, xf1, yf0, yf1] = bounds(SPOT);
    // the old rule: 256 px tiles, no budget check — 56 tiles at zoom 16
    const oldZ = Math.ceil(Math.log2(1428 / (256 * (xf1 - xf0))));
    expect(oldZ).toBe(16);
    expect(tileCount(oldZ, xf0, xf1, yf0, yf1)).toBeGreaterThan(32);
    // the new rule fits the budget with 512 px tiles
    const z = basemapZoom(1428, xf0, xf1, yf0, yf1);
    expect(z).toBeGreaterThanOrEqual(14);        // still street-level detail
    expect(tileCount(z, xf0, xf1, yf0, yf1)).toBeLessThanOrEqual(MAX_TILES);
  });

  it('a city extent also stays inside the budget', () => {
    const [xf0, xf1, yf0, yf1] = bounds(CITY);
    const z = basemapZoom(1428, xf0, xf1, yf0, yf1);
    expect(tileCount(z, xf0, xf1, yf0, yf1)).toBeLessThanOrEqual(MAX_TILES);
    expect(z).toBeGreaterThanOrEqual(11);
  });

  it('lowers the zoom rather than exceed a tiny budget, and never below 3', () => {
    const [xf0, xf1, yf0, yf1] = bounds(SPOT);
    const z = basemapZoom(1428, xf0, xf1, yf0, yf1, TILE_SIZE, 1);
    expect(tileCount(z, xf0, xf1, yf0, yf1)).toBeLessThanOrEqual(1);
    expect(z).toBeGreaterThanOrEqual(3);
  });

  it('a compact zone mini-map (650 m radius) is a handful of tiles', () => {
    const lat = 28.632, lng = 77.22, r = 650;
    const dLat = r / 111_320, dLng = r / (111_320 * Math.cos((lat * Math.PI) / 180));
    const z = basemapZoom(1000, xFrac(lng - dLng), xFrac(lng + dLng), yFrac(lat + dLat), yFrac(lat - dLat));
    expect(z).toBeGreaterThanOrEqual(15);
    expect(tileCount(z, xFrac(lng - dLng), xFrac(lng + dLng), yFrac(lat + dLat), yFrac(lat - dLat))).toBeLessThanOrEqual(12);
  });
});

describe('report text helpers', () => {
  const crit = (name: string, origin?: MCDACriteria['origin']): MCDACriteria => ({
    name, weight: 0.2, score: 5, rawValue: 10, direction: 'positive', justification: '',
    evidenceBasis: 'osm-observed' as any, origin,
  });

  it('factorMix says how many factors came from the brief', () => {
    expect(factorMix([])).toBe('No factors');
    expect(factorMix([crit('A'), crit('B', 'framework')])).toBe('2 factors (framework)');
    expect(factorMix([crit('A'), crit('B', 'brief'), crit('C', 'answer')])).toBe('3 factors (1 framework, 2 from your brief)');
  });

  it('originText uses the drawer vocabulary', () => {
    expect(originText('brief')).toBe('From your brief');
    expect(originText('framework')).toBe('Framework');
    expect(originText(null)).toBe('');
  });

  it('asciiSafe keeps every glyph inside Latin-1 (jsPDF Helvetica)', () => {
    const out = asciiSafe('Zone — “good” → 5 km² ≥ 3 • café … ✓ 📍');
    expect(out).toBe('Zone - "good" -> 5 km2 >= 3 - café ... OK ');
    for (const ch of out) expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0xff);
  });
});
