/**
 * v1.6.8 — Report map figure (professional-cartography pass).
 *
 * Renders the H3 suitability surface + ranked candidates onto an offscreen
 * canvas and returns an image data-URL for embedding in the PDF report.
 *
 * v1.6.7 shipped this figure with no basemap (licensing caution). v1.6.8
 * upgrade: the figure now draws real raster tiles under the choropleth —
 * the SAME source the on-screen map already uses. Projection switched from
 * equirectangular to Web Mercator so the hexes align with the tiles exactly.
 * If any tile fails (offline, blocked, timeout), the figure falls back to the
 * v1.6.7 clean analytical rendering — the report itself can never break on
 * a tile.
 *
 * v2.7.0 — the live "High end gym / Kashmiri Market" report shipped WITHOUT
 * a basemap: a 1.5 km spot extent needs zoom 16 with 256 px tiles, which is
 * 56 tiles — over the 32-tile safety cap — so fetchBasemap returned null and
 * the "map" was hexes on white. The zoom is now chosen to fit the tile
 * budget (basemapZoom), tiles are 512 px @2x (a quarter of the requests for
 * the same detail), the spot-check pin is drawn, and a compact "focus" mode
 * renders the per-zone mini-map on the detail pages. Output is JPEG: the
 * PNG path stored the 1500x1900 canvas almost raw and made a 7-page report
 * 11 MB.
 */
import type { HexGridCell, LocationData } from '../types';
import { mapboxTokenSync, loadMapConfig } from './mapConfig';

const RAMP = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 130)}, 80%, 46%)`; // matches MapView

/**
 * v1.12.0 — basemap tiles come from Mapbox's Static Tiles API so the PDF
 * figure matches the Mapbox style the user just looked at on screen.
 *
 * The token is the same public `pk.` token the map uses, fetched at runtime
 * from the engine (never bundled — see services/mapConfig.ts). If it is absent,
 * tileUrl returns null and fetchBasemap falls back to the clean no-basemap
 * rendering — exactly as it already did when a tile request failed. The report
 * can never break on a missing basemap.
 */
export const TILE_SIZE = 512;            // v2.7.0 — 512 px tiles, requested @2x (1024 px images)
const tileUrl = (z: number, x: number, y: number): string | null => {
  const token = mapboxTokenSync();
  if (!token) return null;
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/${TILE_SIZE}/${z}/${x}/${y}@2x`
    + `?access_token=${encodeURIComponent(token)}`;
};

const TILE_TIMEOUT_MS = 9000;   // whole-basemap budget; miss it -> clean fallback
export const MAX_TILES = 48;    // safety cap — basemapZoom() always fits inside it

export interface FigureOptions {
  hexGrid: HexGridCell[];
  locations: LocationData[];
  studyAreaBoundary?: [number, number][];
  /** grey the surface (recommendation withheld) */
  withheld?: boolean;
  /** weights differ from defaults — figure must say so */
  weightsAdjusted?: boolean;
  /** v2.7.0 — the customer's pin on a spot check */
  target?: { lat: number; lng: number } | null;
  /**
   * v2.7.0 — compact mini-map centred on one zone: no legend strip, the
   * focused zone's marker emphasised, extent = radiusM around the point.
   */
  focus?: { lat: number; lng: number; radiusM: number; rank: number } | null;
}

// ── Web Mercator helpers (fraction of world, 0..1) ──
const xFrac = (lng: number) => (lng + 180) / 360;
const yFrac = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Tiles needed to cover a fraction-bounds box at zoom z. */
export function tileCount(z: number, xf0: number, xf1: number, yf0: number, yf1: number): number {
  const n = 2 ** z;
  return (Math.floor(xf1 * n) - Math.floor(xf0 * n) + 1) * (Math.floor(yf1 * n) - Math.floor(yf0 * n) + 1);
}

/**
 * v2.7.0 — the highest zoom whose tile pixels are at least as fine as the
 * canvas pixels, lowered until the extent fits in `maxTiles`. A 1.5 km spot
 * extent used to ask for zoom 16 / 56 tiles and get nothing; it now gets
 * zoom 15 (512 px tiles) and ~12 tiles.
 */
export function basemapZoom(
  plotW: number, xf0: number, xf1: number, yf0: number, yf1: number,
  tileSize = TILE_SIZE, maxTiles = MAX_TILES,
): number {
  const xfSpan = Math.max(1e-9, xf1 - xf0);
  let z = Math.max(3, Math.min(18, Math.ceil(Math.log2(plotW / (tileSize * xfSpan)))));
  while (z > 3 && tileCount(z, xf0, xf1, yf0, yf1) > maxTiles) z--;
  return z;
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = tileUrl(z, x, y);
    if (!url) { reject(new Error('no basemap token')); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required to keep the canvas exportable
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile failed'));
    img.src = url;
  });
}

/** Fetch every tile covering the fraction-bounds at zoom z; null = fallback. */
async function fetchBasemap(
  z: number, xf0: number, xf1: number, yf0: number, yf1: number,
): Promise<{ img: HTMLImageElement; tx: number; ty: number }[] | null> {
  const n = 2 ** z;
  const tx0 = Math.floor(xf0 * n), tx1 = Math.floor(xf1 * n);
  const ty0 = Math.floor(yf0 * n), ty1 = Math.floor(yf1 * n);
  const jobs: { tx: number; ty: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++)
      jobs.push({ tx, ty });
  if (jobs.length === 0 || jobs.length > MAX_TILES) return null;
  try {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('basemap timeout')), TILE_TIMEOUT_MS));
    const settled = await Promise.race([
      Promise.allSettled(jobs.map(j => loadTile(z, j.tx, j.ty))),
      timeout,
    ]);
    const tiles: { img: HTMLImageElement; tx: number; ty: number }[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') tiles.push({ img: s.value, tx: jobs[i].tx, ty: jobs[i].ty });
    });
    // Partial coverage looks worse than none — require the full set.
    return tiles.length === jobs.length ? tiles : null;
  } catch {
    return null;
  }
}

/** Metres → degrees at a latitude (good enough for a figure extent). */
const mToLat = (m: number) => m / 111_320;
const mToLng = (m: number, lat: number) => m / (111_320 * Math.cos((lat * Math.PI) / 180));

export interface MapFigure { dataUrl: string; aspect: number; hasBasemap: boolean }

export async function renderMapFigure(opts: FigureOptions): Promise<MapFigure | null> {
  const { hexGrid, locations, studyAreaBoundary, withheld = false, weightsAdjusted = false, target = null, focus = null } = opts;
  if (!hexGrid || hexGrid.length === 0) return null;
  const compact = !!focus;

  // v1.12.0 — make sure the runtime token is resolved before any tile request.
  // Usually already cached (the map fetched it), but a PDF exported from a
  // restored/shared analysis may reach here first. Never throws: on failure the
  // token stays empty and the figure renders without a basemap.
  try { await loadMapConfig(); } catch { /* basemap-less figure is fine */ }

  try {
    // ── Geographic bounds over every drawable geometry ──
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    const eat = (lat: number, lng: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    };
    if (focus) {
      eat(focus.lat - mToLat(focus.radiusM), focus.lng - mToLng(focus.radiusM, focus.lat));
      eat(focus.lat + mToLat(focus.radiusM), focus.lng + mToLng(focus.radiusM, focus.lat));
    } else {
      for (const c of hexGrid) for (const [la, ln] of c.boundary || []) eat(la, ln);
      for (const p of studyAreaBoundary || []) eat(p[0], p[1]);
      for (const l of locations) eat(l.lat, l.lng);
      if (target) eat(target.lat, target.lng);
    }
    if (!Number.isFinite(minLat) || maxLat <= minLat || maxLng <= minLng) return null;

    // Breathing room around the geometry (5% of the span each side)
    if (!focus) {
      const latPad = (maxLat - minLat) * 0.05, lngPad = (maxLng - minLng) * 0.05;
      minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;
    }

    // ── Web Mercator projection into the plot rect ──
    const xf0 = xFrac(minLng), xf1 = xFrac(maxLng);
    const yf0 = yFrac(maxLat), yf1 = yFrac(minLat); // y grows southward
    const xfSpan = xf1 - xf0, yfSpan = yf1 - yf0;
    if (xfSpan <= 0 || yfSpan <= 0) return null;

    const W = compact ? 1000 : 1500;
    const m = compact ? 0 : 36;       // frame margin
    const plotW = W - 2 * m;
    const plotH = compact
      ? Math.round(plotW * 0.72)
      : Math.max(300, Math.min(1700, plotW * (yfSpan / xfSpan)));
    const legendH = compact ? 0 : 170;
    const H = Math.round(m + plotH + m + legendH);
    // compact: keep the aspect the caller asked for; recentre the span vertically
    let yf0Used = yf0, yfSpanUsed = yfSpan;
    if (compact) {
      yfSpanUsed = xfSpan * (plotH / plotW);
      yf0Used = (yf0 + yf1) / 2 - yfSpanUsed / 2;
    }
    const px = (lng: number) => m + ((xFrac(lng) - xf0) / xfSpan) * plotW;
    const py = (lat: number) => m + ((yFrac(lat) - yf0Used) / yfSpanUsed) * plotH;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ── Basemap tiles (clean fallback when unavailable) ──
    const z = basemapZoom(plotW, xf0, xf1, yf0Used, yf0Used + yfSpanUsed);
    const tiles = await fetchBasemap(z, xf0, xf1, yf0Used, yf0Used + yfSpanUsed);
    const hasBasemap = !!tiles;
    if (tiles) {
      const n = 2 ** z;
      ctx.save();
      ctx.beginPath();
      ctx.rect(m, m, plotW, plotH);
      ctx.clip();
      for (const t of tiles) {
        const dx = m + ((t.tx / n - xf0) / xfSpan) * plotW;
        const dy = m + ((t.ty / n - yf0Used) / yfSpanUsed) * plotH;
        const dw = (1 / n / xfSpan) * plotW;
        const dh = (1 / n / yfSpanUsed) * plotH;
        ctx.drawImage(t.img, dx, dy, dw + 0.75, dh + 0.75); // slight overlap kills seams
      }
      // Mute the basemap so the choropleth stays the star
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(m, m, plotW, plotH);
      ctx.restore();
    }

    // ── Contrast stretch identical to the on-screen map ──
    const vals = hexGrid.filter(c => !c.excluded).map(c => c.score).filter(v => typeof v === 'number');
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 10;
    const span = hi - lo > 0.1 ? hi - lo : 1;

    // ── Hex cells (clipped to the frame) ──
    ctx.save();
    ctx.beginPath(); ctx.rect(m, m, plotW, plotH); ctx.clip();
    for (const cell of hexGrid) {
      const b = cell.boundary;
      if (!Array.isArray(b) || b.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(px(b[0][1]), py(b[0][0]));
      for (let i = 1; i < b.length; i++) ctx.lineTo(px(b[i][1]), py(b[i][0]));
      ctx.closePath();
      const t = Math.max(0, Math.min(1, (cell.score - lo) / span));
      if (cell.excluded) {
        ctx.fillStyle = 'rgba(100,116,139,0.30)';
      } else if (withheld) {
        ctx.fillStyle = `rgba(148,163,184,${(0.15 + t * 0.30).toFixed(2)})`;
      } else {
        // More transparent over a basemap so streets/labels read through
        ctx.globalAlpha = hasBasemap ? (compact ? 0.26 + t * 0.30 : 0.34 + t * 0.34) : 0.42 + t * 0.40;
        ctx.fillStyle = RAMP(t);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── Study-area boundary ──
    if (studyAreaBoundary && studyAreaBoundary.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(px(studyAreaBoundary[0][1]), py(studyAreaBoundary[0][0]));
      for (const p of studyAreaBoundary.slice(1)) ctx.lineTo(px(p[1]), py(p[0]));
      ctx.closePath();
      ctx.setLineDash([10, 7]);
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Ranked candidate markers ──
    const ranked = locations.filter(l => !l.excluded);
    const drawPin = (x: number, y: number, label: string, r: number, fill: string, dim: boolean) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.globalAlpha = dim ? 0.55 : 1;
      ctx.fill();
      ctx.lineWidth = Math.max(2, r / 5);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(r * 1.1)}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 1);
      ctx.globalAlpha = 1;
    };
    ranked.forEach((l, i) => {
      const isFocus = !!focus && i + 1 === focus.rank;
      const r = compact ? (isFocus ? 26 : 16) : 20;
      if (compact && isFocus) {                       // a soft halo under the focused zone
        ctx.beginPath(); ctx.arc(px(l.lng), py(l.lat), 44, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(5,150,105,0.22)'; ctx.fill();
      }
      drawPin(px(l.lng), py(l.lat), String(i + 1), r, withheld ? '#64748b' : '#059669', compact && !isFocus);
    });

    // ── v2.7.0: the customer's pin (spot check) ──
    if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
      const x = px(target.lng), y = py(target.lat);
      const s = compact ? 0.8 : 1;
      ctx.save();
      ctx.beginPath();                              // teardrop
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x - 22 * s, y - 26 * s, x - 22 * s, y - 52 * s, x, y - 52 * s);
      ctx.bezierCurveTo(x + 22 * s, y - 52 * s, x + 22 * s, y - 26 * s, x, y);
      ctx.closePath();
      ctx.fillStyle = '#1d4ed8'; ctx.fill();
      ctx.lineWidth = 3.5 * s; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y - 34 * s, 8 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.font = `bold ${Math.round(15 * s)}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lbl = 'YOUR SPOT';
      const lw = ctx.measureText(lbl).width + 16 * s;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(x - lw / 2, y - 76 * s, lw, 22 * s);
      ctx.strokeStyle = '#bfdbfe'; ctx.lineWidth = 1.5; ctx.strokeRect(x - lw / 2, y - 76 * s, lw, 22 * s);
      ctx.fillStyle = '#1d4ed8'; ctx.fillText(lbl, x, y - 65 * s);
      ctx.restore();
    }
    ctx.restore();

    // ── Map frame (neatline) ──
    ctx.strokeStyle = compact ? '#94a3b8' : '#334155';
    ctx.lineWidth = compact ? 1.5 : 2;
    ctx.strokeRect(m + (compact ? 0.75 : 0), m + (compact ? 0.75 : 0), plotW - (compact ? 1.5 : 0), plotH - (compact ? 1.5 : 0));

    // ── North arrow (inside frame, top-right) ──
    const na = compact ? 0.7 : 1;
    const nx = m + plotW - 46 * na, nyTop = m + 22 * na;
    ctx.save();
    ctx.beginPath();
    ctx.arc(nx, nyTop + 26 * na, 30 * na, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath();                       // arrow, dark (west) half
    ctx.moveTo(nx, nyTop + 8 * na);
    ctx.lineTo(nx - 9 * na, nyTop + 34 * na);
    ctx.lineTo(nx, nyTop + 27 * na);
    ctx.closePath();
    ctx.fillStyle = '#0f172a'; ctx.fill();
    ctx.beginPath();                       // arrow, light (east) half
    ctx.moveTo(nx, nyTop + 8 * na);
    ctx.lineTo(nx + 9 * na, nyTop + 34 * na);
    ctx.lineTo(nx, nyTop + 27 * na);
    ctx.closePath();
    ctx.fillStyle = '#94a3b8'; ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = `bold ${Math.round(17 * na)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('N', nx, nyTop + 50 * na);
    ctx.restore();

    // ── Scale bar (inside frame, bottom-left, on a backdrop) ──
    const midLat = (minLat + maxLat) / 2;
    const totalKm = (maxLng - minLng) * 111.32 * Math.cos((midLat * Math.PI) / 180);
    const niceKm = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50].find(k => k / totalKm > 0.14) ?? 50;
    const barPx = (niceKm / totalKm) * plotW;
    const sbX = m + 18, sbY = m + plotH - 22;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(sbX - 8, sbY - 28, barPx + 24, 42);
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
    ctx.strokeRect(sbX - 8, sbY - 28, barPx + 24, 42);
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sbX, sbY); ctx.lineTo(sbX + barPx, sbY);
    ctx.moveTo(sbX, sbY - 7); ctx.lineTo(sbX, sbY + 7);
    ctx.moveTo(sbX + barPx, sbY - 7); ctx.lineTo(sbX + barPx, sbY + 7);
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 16px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(niceKm < 1 ? `${Math.round(niceKm * 1000)} m` : `${niceKm} km`, sbX + barPx / 2, sbY - 12);
    ctx.restore();

    if (compact) {
      // attribution sits inside the frame, bottom-right, tiny
      ctx.save();
      ctx.font = '13px Helvetica, Arial, sans-serif';
      const cred = hasBasemap ? '(c) Mapbox (c) OpenStreetMap' : '(c) OpenStreetMap contributors';
      const cwid = ctx.measureText(cred).width + 12;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(m + plotW - cwid, m + plotH - 20, cwid, 20);
      ctx.fillStyle = '#475569'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(cred, m + plotW - 6, m + plotH - 10);
      ctx.restore();
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.86), aspect: W / H, hasBasemap };
    }

    // ── Legend strip (below the frame; fixed rows — nothing can collide) ──
    const lx = m;
    const row1 = m + plotH + 38;
    const row2 = row1 + 44;
    const row3 = row2 + 28;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';

    if (withheld) {
      ctx.font = 'bold 22px Helvetica, Arial, sans-serif'; ctx.fillStyle = '#475569';
      ctx.fillText('Screening surface - context only (result flagged unreliable; no recommendation made)', lx, row1);
    } else {
      // gradient ramp labeled with the ACTUAL plotted range
      const gw = 260, gh = 20;
      for (let i = 0; i < gw; i++) {
        ctx.fillStyle = RAMP(i / gw);
        ctx.fillRect(lx + i, row1 - gh / 2, 1.5, gh);
      }
      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
      ctx.strokeRect(lx, row1 - gh / 2, gw, gh);
      ctx.fillStyle = '#0f172a';
      ctx.font = '17px Helvetica, Arial, sans-serif';
      ctx.fillText(`${lo.toFixed(1)}`, lx, row1 + 26);
      const hiLbl = `${hi.toFixed(1)}`;
      ctx.fillText(hiLbl, lx + gw - ctx.measureText(hiLbl).width, row1 + 26);
      ctx.fillStyle = '#475569';
      ctx.fillText('suitability (low to high)', lx + gw / 2 - ctx.measureText('suitability (low to high)').width / 2, row1 + 26);

      // excluded swatch
      let cx2 = lx + gw + 52;
      ctx.fillStyle = 'rgba(100,116,139,0.35)';
      ctx.fillRect(cx2, row1 - 11, 26, 22);
      ctx.strokeStyle = '#94a3b8'; ctx.strokeRect(cx2, row1 - 11, 26, 22);
      ctx.fillStyle = '#0f172a';
      ctx.font = '18px Helvetica, Arial, sans-serif';
      ctx.fillText('excluded land', cx2 + 34, row1);
      cx2 += 34 + ctx.measureText('excluded land').width + 48;

      // ranked pin sample
      ctx.beginPath(); ctx.arc(cx2 + 11, row1, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#059669'; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 13px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('1', cx2 + 11, row1 + 1);
      ctx.textAlign = 'left'; ctx.fillStyle = '#0f172a'; ctx.font = '18px Helvetica, Arial, sans-serif';
      ctx.fillText('ranked candidate zone', cx2 + 30, row1);
      cx2 += 30 + ctx.measureText('ranked candidate zone').width + 48;

      // AOI line sample
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 3; ctx.setLineDash([10, 7]);
      ctx.beginPath(); ctx.moveTo(cx2, row1); ctx.lineTo(cx2 + 44, row1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#0f172a';
      ctx.fillText('study area', cx2 + 52, row1);
      cx2 += 52 + ctx.measureText('study area').width + 48;

      if (target) {                                   // spot pin sample
        ctx.beginPath();
        ctx.moveTo(cx2 + 8, row1 + 10);
        ctx.bezierCurveTo(cx2 - 2, row1 - 2, cx2 - 2, row1 - 12, cx2 + 8, row1 - 12);
        ctx.bezierCurveTo(cx2 + 18, row1 - 12, cx2 + 18, row1 - 2, cx2 + 8, row1 + 10);
        ctx.closePath(); ctx.fillStyle = '#1d4ed8'; ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.fillText('your spot', cx2 + 26, row1);
      }
    }

    // caption + data credit (their own rows — no collisions possible)
    ctx.font = '17px Helvetica, Arial, sans-serif'; ctx.fillStyle = '#475569';
    ctx.fillText(
      `Numbered pins = ranked candidate zones${weightsAdjusted ? ' - CUSTOM WEIGHTS APPLIED' : ''}. Cell colors: screening surface; candidate cells carry final refined scores.`,
      lx, row2,
    );
    ctx.fillText(
      hasBasemap
        ? 'Basemap (c) Mapbox (c) OpenStreetMap contributors. Analysis data: OpenStreetMap, Google Places. H3 hexagonal grid, Web Mercator.'
        : 'Analytical figure (basemap unavailable at export time). Data: (c) OpenStreetMap contributors; Google Places. H3 hexagonal grid.',
      lx, row3,
    );

    return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), aspect: W / H, hasBasemap };
  } catch {
    return null; // the figure must never break the report
  }
}
