// v2.4.0 — check a spot.
//
// The photo is the trigger; the pin is the subject. Two things are worth
// guarding without a browser: the hand-rolled EXIF GPS reader (a wrong
// byte order or a missed ref puts the pin in the wrong hemisphere), and the
// normalizer boundary for `targetCell` (a malformed verdict must be hidden,
// never printed as "undefined of NaN").

import { describe, it, expect } from 'vitest';
import { parseExifGps } from '../services/exifGps';
import { normalizeAnalysisResult } from '../services/resultNormalizer';

/** Build a minimal JPEG: SOI, APP1 "Exif", TIFF with IFD0 → GPS IFD carrying
 *  lat/lng refs and 3×RATIONAL coordinates. */
function jpegWithGps(lat: number, lng: number, opts: { littleEndian?: boolean; zero?: boolean } = {}): ArrayBuffer {
  const le = opts.littleEndian ?? true;
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u16 = (v: number) => le ? (u8(v), u8(v >> 8)) : (u8(v >> 8), u8(v));
  const u32 = (v: number) => le ? (u8(v), u8(v >> 8), u8(v >> 16), u8(v >> 24)) : (u8(v >> 24), u8(v >> 16), u8(v >> 8), u8(v));
  const dms = (deg: number) => {
    const a = Math.abs(deg); const d = Math.floor(a); const m = Math.floor((a - d) * 60); const s = ((a - d) * 60 - m) * 60;
    return [[d, 1], [m, 1], [Math.round(s * 1000), 1000]];
  };

  // TIFF header
  u8(le ? 0x49 : 0x4d); u8(le ? 0x49 : 0x4d); u16(42); u32(8);
  // IFD0 at 8: one entry (GPS IFD pointer) → GPS IFD at 8 + 2 + 12 + 4 = 26
  u16(1); u16(0x8825); u16(4); u32(1); u32(26); u32(0);
  // GPS IFD at 26: 4 entries; rationals after: 26 + 2 + 48 + 4 = 80
  const latRef = lat >= 0 ? 'N' : 'S', lngRef = lng >= 0 ? 'E' : 'W';
  u16(4);
  u16(1); u16(2); u32(2); u8(latRef.charCodeAt(0)); u8(0); u8(0); u8(0);
  u16(2); u16(5); u32(3); u32(80);
  u16(3); u16(2); u32(2); u8(lngRef.charCodeAt(0)); u8(0); u8(0); u8(0);
  u16(4); u16(5); u32(3); u32(104);
  u32(0);
  for (const [n, d] of dms(opts.zero ? 0 : lat)) { u32(n); u32(d); }
  for (const [n, d] of dms(opts.zero ? 0 : lng)) { u32(n); u32(d); }
  const tiff = bytes.splice(0);

  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];          // "Exif\0\0" + TIFF
  const seg = [0xff, 0xe1, ((app1.length + 2) >> 8) & 0xff, (app1.length + 2) & 0xff, ...app1];
  const jpeg = [0xff, 0xd8, ...seg, 0xff, 0xda, 0, 2];            // SOI, APP1, SOS
  return new Uint8Array(jpeg).buffer;
}

describe('parseExifGps', () => {
  it('reads a little-endian fix and keeps the hemisphere', () => {
    const fix = parseExifGps(jpegWithGps(12.9752, 77.6047));
    expect(fix).not.toBeNull();
    expect(fix!.lat).toBeCloseTo(12.9752, 3);
    expect(fix!.lng).toBeCloseTo(77.6047, 3);
  });
  it('reads a big-endian fix and applies S / W refs', () => {
    const fix = parseExifGps(jpegWithGps(-33.8688, -151.2093, { littleEndian: false }))!;
    expect(fix.lat).toBeCloseTo(-33.8688, 3);
    expect(fix.lng).toBeCloseTo(-151.2093, 3);
  });
  it('treats a zeroed tag as no fix', () => {
    expect(parseExifGps(jpegWithGps(0, 0, { zero: true }))).toBeNull();
  });
  it('returns null for a JPEG with no EXIF and for a non-JPEG', () => {
    expect(parseExifGps(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull();
    expect(parseExifGps(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();  // PNG
    expect(parseExifGps(new ArrayBuffer(0))).toBeNull();
  });
});

describe('normalizeAnalysisResult · targetCell', () => {
  const base = { summary: 's', business_type: 'cafe', target_location: 'x', methodology: 'm', spec: {}, locations: [], grounding_sources: [] };

  it('passes a well-formed verdict through with numbers coerced', () => {
    const r = normalizeAnalysisResult({
      ...base,
      targetCell: {
        h3: 'abc', lat: '12.97', lng: '77.60', point: { lat: 12.9752, lng: 77.6047 }, radiusM: 1500,
        excluded: false, cellsScreened: 68, cellsEligible: '56', screeningScore: 7.08, screeningRank: 4, percentile: 0.946,
        verdict: 'good', verdictText: 'A good spot', areaHint: "D'Souza Layout", priority: null,
        verified: { score: 4.21, rank: 10, of: 13, note: null },
        location: { name: 'Your spot', lat: 12.97, lng: 77.6, mcda_score: 4.2, isTarget: true, criteria_breakdown: [] },
      },
    } as any);
    const t = r.targetCell!;
    expect(t.verdict).toBe('good');
    expect(t.lat).toBeCloseTo(12.97);
    expect(t.cellsEligible).toBe(56);
    expect(t.verified).toEqual({ score: 4.21, rank: 10, of: 13, note: null });
    expect(t.location?.name).toBe('Your spot');
    expect(t.location?.isTarget).toBe(true);
  });

  it('hides a malformed verdict and says so', () => {
    const r = normalizeAnalysisResult({ ...base, targetCell: { verdict: 'amazing', lat: 1, lng: 2 } } as any) as any;
    expect(r.targetCell).toBeNull();
    expect(r.normalizationWarnings.some((w: string) => /Spot verdict/.test(w))).toBe(true);
  });

  it('is null on an ordinary area search', () => {
    expect(normalizeAnalysisResult({ ...base } as any).targetCell).toBeNull();
  });
});
