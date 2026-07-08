/**
 * v1.6.7 — Report map figure.
 *
 * Renders the H3 suitability surface + ranked candidates onto an offscreen
 * canvas and returns a PNG data-URL for embedding in the PDF report.
 *
 * Deliberately NO basemap tiles: tile screenshots raise CORS + licensing
 * headaches in a client-generated commercial report, and a clean analytical
 * figure (choropleth + boundary + ranked markers + legend + scale bar) is the
 * defensible deliverable — every pixel derives from the analysis itself.
 */
import type { HexGridCell, LocationData } from '../types';

const RAMP = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 130)}, 80%, 46%)`; // matches MapView

interface FigureOptions {
  hexGrid: HexGridCell[];
  locations: LocationData[];
  studyAreaBoundary?: [number, number][];
  /** grey the surface (recommendation withheld) */
  withheld?: boolean;
  /** weights differ from defaults — figure must say so */
  weightsAdjusted?: boolean;
}

export function renderMapFigure(opts: FigureOptions): { dataUrl: string; aspect: number } | null {
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

    // ── Equirectangular projection with latitude correction ──
    const midLat = (minLat + maxLat) / 2;
    const kx = Math.cos((midLat * Math.PI) / 180);
    const spanX = (maxLng - minLng) * kx;
    const spanY = maxLat - minLat;
    const pad = 0.06; // 6% margin
    const W = 1500;
    const plotW = W * (1 - 2 * pad);
    const plotH = plotW * (spanY / spanX);
    const legendH = 150;
    const H = Math.round(plotH / (1 - 2 * pad) + legendH);
    const px = (lng: number) => W * pad + ((lng - minLng) * kx / spanX) * plotW;
    const py = (lat: number) => (H - legendH) * pad + (1 - (lat - minLat) / spanY) * plotH;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ── Contrast stretch identical to the on-screen map ──
    const vals = hexGrid.filter(c => !c.excluded).map(c => c.score).filter(v => typeof v === 'number');
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 10;
    const span = hi - lo > 0.1 ? hi - lo : 1;

    // ── Hex cells ──
    for (const cell of hexGrid) {
      const b = cell.boundary;
      if (!Array.isArray(b) || b.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(px(b[0][1]), py(b[0][0]));
      for (let i = 1; i < b.length; i++) ctx.lineTo(px(b[i][1]), py(b[i][0]));
      ctx.closePath();
      const t = Math.max(0, Math.min(1, (cell.score - lo) / span));
      if (cell.excluded) {
        ctx.fillStyle = 'rgba(100,116,139,0.28)';
      } else if (withheld) {
        ctx.fillStyle = `rgba(148,163,184,${(0.15 + t * 0.30).toFixed(2)})`;
      } else {
        ctx.globalAlpha = 0.42 + t * 0.40;
        ctx.fillStyle = RAMP(t);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
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

    // ── Legend, scale bar, caption strip ──
    const ly = H - legendH + 28;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '22px Helvetica, Arial, sans-serif'; ctx.fillStyle = '#0f172a';
    if (withheld) {
      ctx.fillText('Screening surface — context only (result flagged unreliable; no recommendation made)', W * pad, ly);
    } else {
      // gradient bar
      const gx = W * pad, gw = 300, gh = 20;
      for (let i = 0; i < gw; i++) {
        ctx.fillStyle = RAMP(i / gw);
        ctx.fillRect(gx + i, ly - gh / 2, 1.5, gh);
      }
      ctx.fillStyle = '#0f172a';
      ctx.fillText('lower', gx + gw + 12, ly);
      ctx.fillText('higher suitability', gx + gw + 84, ly);
      // excluded swatch
      ctx.fillStyle = 'rgba(100,116,139,0.35)';
      ctx.fillRect(gx + gw + 320, ly - 11, 26, 22);
      ctx.fillStyle = '#0f172a';
      ctx.fillText('excluded', gx + gw + 356, ly);
    }
    // scale bar: pick a round km length spanning ~20% of width
    const kmPerLng = 111.32 * kx;
    const plotKm = spanX / kx * kmPerLng / kx; // spanLng*kx already; recompute simply:
    const totalKm = (maxLng - minLng) * 111.32 * kx;
    const niceKm = [0.5, 1, 2, 5, 10, 20, 50].find(k => k / totalKm > 0.15) ?? 50;
    const barPx = (niceKm / totalKm) * plotW;
    const bx = W - W * pad - barPx, by = ly + 46;
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 8); ctx.lineTo(bx, by + 8);
    ctx.moveTo(bx + barPx, by - 8); ctx.lineTo(bx + barPx, by + 8);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(`${niceKm} km`, bx + barPx / 2, by - 18);
    // caption
    ctx.textAlign = 'left'; ctx.font = '19px Helvetica, Arial, sans-serif'; ctx.fillStyle = '#475569';
    ctx.fillText(
      `Analytical figure (no basemap). Numbered pins = ranked candidate zones${weightsAdjusted ? ' — CUSTOM WEIGHTS APPLIED' : ''}. Cell colors: screening surface; candidate cells show final refined scores.`,
      W * pad, ly + 46,
    );
    ctx.fillText('Data: © OpenStreetMap contributors; Google Places. H3 hexagonal grid.', W * pad, ly + 78);

    return { dataUrl: canvas.toDataURL('image/png'), aspect: W / H };
  } catch {
    return null; // the figure must never break the report
  }
}
