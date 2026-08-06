/**
 * v1.6.8 — Report map figure (professional-cartography pass).
 *
 * Renders the H3 suitability surface + ranked candidates onto an offscreen
 * canvas and returns a PNG data-URL for embedding in the PDF report.
 *
 * v1.6.7 shipped this figure with no basemap (licensing caution). v1.6.8
 * upgrade: the figure now draws real Carto "light_all" raster tiles under
 * the choropleth — the SAME CORS-enabled tile source the on-screen map
 * already uses, credited "(c) OpenStreetMap contributors (c) CARTO" (free
 * for this use with attribution). Projection switched from equirectangular
 * to Web Mercator so the hexes align with the tiles exactly. If any tile
 * fails (offline, blocked, timeout), the figure falls back to the v1.6.7
 * clean analytical rendering — the report itself can never break on a tile.
 *
 * Also added: north arrow, an in-frame scale bar (no longer colliding with
 * the caption), a neatline, and a labeled legend (actual score range,
 * ranked-pin and excluded-cell samples, study-area line sample).
 */
import type { HexGridCell, LocationData } from '../types';
import { config } from '../config';

const RAMP = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 130)}, 80%, 46%)`; // matches MapView

/**
 * v1.12.0 — basemap tiles now come from Mapbox's Static Tiles API instead of
 * CARTO, so the PDF figure matches the Mapbox style the user just looked at on
 * screen. Same {z}/{x}/{y} raster contract as before, so the whole Web-Mercator
 * tile-stitching path below is unchanged.
 *
 * The token is the same public `pk.` token the map uses. If it is absent (a
 * build without VITE_MAPBOX_TOKEN), tileUrl returns null and fetchBasemap
 * falls back to the clean no-basemap rendering — exactly as it already did
 * when a tile request failed. The report can never break on a missing basemap.
 */
const tileUrl = (z: number, x: number, y: number): string | null => {
  if (!config.mapboxToken) return null;
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/${z}/${x}/${y}`
    + `?access_token=${encodeURIComponent(config.mapboxToken)}`;
};

const TILE_TIMEOUT_MS = 5000;   // whole-basemap budget; miss it -> clean fallback
const MAX_TILES = 32;           // safety cap (a city extent needs ~6-16)

interface FigureOptions {
  hexGrid: HexGridCell[];
  locations: LocationData[];
  studyAreaBoundary?: [number, number][];
  /** grey the surface (recommendation withheld) */
  withheld?: boolean;
  /** weights differ from defaults — figure must say so */
  weightsAdjusted?: boolean;
}

// ── Web Mercator helpers (fraction of world, 0..1) ──
const xFrac = (lng: number) => (lng + 180) / 360;
const yFrac = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

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

export async function renderMapFigure(
  opts: FigureOptions,
): Promise<{ dataUrl: string; aspect: number; hasBasemap: boolean } | null> {
  const { hexGrid, locations, studyAreaBoundary, withheld = false, weightsAdjusted = false } = opts;
  if (!hexGrid || hexGrid.length === 0) return null;

  try {
    // ── Geographic bounds over every drawable geometry ──
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    const eat = (lat: number, lng: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    };
    for (const c of hexGrid) for (const [la, ln] of c.boundary || []) eat(la, ln);
    for (const p of studyAreaBoundary || []) eat(p[0], p[1]);
    for (const l of locations) eat(l.lat, l.lng);
    if (!Number.isFinite(minLat) || maxLat <= minLat || maxLng <= minLng) return null;

    // Breathing room around the geometry (5% of the span each side)
    const latPad = (maxLat - minLat) * 0.05, lngPad = (maxLng - minLng) * 0.05;
    minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;

    // ── Web Mercator projection into the plot rect ──
    const xf0 = xFrac(minLng), xf1 = xFrac(maxLng);
    const yf0 = yFrac(maxLat), yf1 = yFrac(minLat); // y grows southward
    const xfSpan = xf1 - xf0, yfSpan = yf1 - yf0;
    if (xfSpan <= 0 || yfSpan <= 0) return null;

    const W = 1500;
    const m = 36;                     // frame margin
    const plotW = W - 2 * m;
    const plotH = Math.max(300, Math.min(1700, plotW * (yfSpan / xfSpan)));
    const legendH = 170;
    const H = Math.round(m + plotH + m + legendH);
    const px = (lng: number) => m + ((xFrac(lng) - xf0) / xfSpan) * plotW;
    const py = (lat: number) => m + ((yFrac(lat) - yf0) / yfSpan) * plotH;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ── Basemap tiles (Carto light; clean fallback when unavailable) ──
    // Zoom: enough resolution that a tile pixel >= a canvas pixel across the extent.
    const z = Math.max(3, Math.min(18, Math.ceil(Math.log2(plotW / (256 * xfSpan)))));
    const tiles = await fetchBasemap(z, xf0, xf1, yf0, yf1);
    const hasBasemap = !!tiles;
    if (tiles) {
      const n = 2 ** z;
      ctx.save();
      ctx.beginPath();
      ctx.rect(m, m, plotW, plotH);
      ctx.clip();
      for (const t of tiles) {
        const dx = m + ((t.tx / n - xf0) / xfSpan) * plotW;
        const dy = m + ((t.ty / n - yf0) / yfSpan) * plotH;
        const dw = (1 / n / xfSpan) * plotW;
        const dh = (1 / n / yfSpan) * plotH;
        ctx.drawImage(t.img, dx, dy, dw + 0.75, dh + 0.75); // slight overlap kills seams
      }
      // Mute the basemap so the choropleth stays the star
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
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
        ctx.globalAlpha = hasBasemap ? 0.34 + t * 0.34 : 0.42 + t * 0.40;
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
    ranked.forEach((l, i) => {
      const x = px(l.lng), y = py(l.lat);
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fillStyle = withheld ? '#64748b' : '#059669';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1);
    });
    ctx.restore();

    // ── Map frame (neatline) ──
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.strokeRect(m, m, plotW, plotH);

    // ── North arrow (inside frame, top-right) ──
    const nx = m + plotW - 46, nyTop = m + 22;
    ctx.save();
    ctx.beginPath();
    ctx.arc(nx, nyTop + 26, 30, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath();                       // arrow, dark (west) half
    ctx.moveTo(nx, nyTop + 8);
    ctx.lineTo(nx - 9, nyTop + 34);
    ctx.lineTo(nx, nyTop + 27);
    ctx.closePath();
    ctx.fillStyle = '#0f172a'; ctx.fill();
    ctx.beginPath();                       // arrow, light (east) half
    ctx.moveTo(nx, nyTop + 8);
    ctx.lineTo(nx + 9, nyTop + 34);
    ctx.lineTo(nx, nyTop + 27);
    ctx.closePath();
    ctx.fillStyle = '#94a3b8'; ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 17px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('N', nx, nyTop + 50);
    ctx.restore();

    // ── Scale bar (inside frame, bottom-left, on a backdrop) ──
    const midLat = (minLat + maxLat) / 2;
    const totalKm = (maxLng - minLng) * 111.32 * Math.cos((midLat * Math.PI) / 180);
    const niceKm = [0.2, 0.5, 1, 2, 5, 10, 20, 50].find(k => k / totalKm > 0.14) ?? 50;
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
    ctx.fillText(`${niceKm} km`, sbX + barPx / 2, sbY - 12);
    ctx.restore();

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

    return { dataUrl: canvas.toDataURL('image/png'), aspect: W / H, hasBasemap };
  } catch {
    return null; // the figure must never break the report
  }
}
