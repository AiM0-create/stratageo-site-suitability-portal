// ─── PDF report ───
//
// v2.1.0 moved the jsPDF layout out of App.tsx. v2.7.0 rewrote it: the live
// "High end gym / Kashmiri Market" export had paragraphs running off the
// right edge (every wrapped block was measured at the previous font size
// and drawn at a larger one), factor names cut mid-word by character count,
// the "/10" under each score badge drawn below the badge, an 11 MB PNG
// figure with NO basemap, and pages of "|"-joined text for an appendix.
// The report is now built on a small layout kit (text is measured at the
// size it is drawn; tables wrap; every block is page-break aware) with a
// cover, numbered sections, a contents list, a per-zone mini-map and a
// tabular evidence appendix.
//
// jsPDF and html2canvas are globals loaded from index.html.
import type { AnalysisResult, AnalysisSpec, LocationData, MCDACriteria } from '../types';
import { config } from '../config';
import { renderMapFigure } from './mapFigure';
import { buildExecutiveSummary } from './screeningPresentation';

declare const jspdf: any;

type RGB = [number, number, number];

// ─── Palette ────────────────────────────────────────────────────────────────
const C = {
  navy:   [29,  78, 216] as RGB,
  navyD:  [23,  37,  84] as RGB,   // cover band
  teal:   [5,  150, 105] as RGB,
  green:  [22, 163,  74] as RGB,
  amber:  [217,119,   6] as RGB,
  red:    [220,  38,  38] as RGB,
  blue:   [59, 130, 246] as RGB,
  ink:    [15,  23,  42] as RGB,
  s7:     [51,  65,  85] as RGB,
  s5:     [100,116, 139] as RGB,
  s4:     [148,163, 184] as RGB,
  s3:     [203,213, 225] as RGB,
  s2:     [226,232, 240] as RGB,
  s1:     [248,250, 252] as RGB,
  white:  [255,255, 255] as RGB,
  skyBg:  [240,249, 255] as RGB,
  amberBg:[255,251, 235] as RGB,
  greenBg:[240,253, 244] as RGB,
  redBg:  [254,242, 242] as RGB,
  paleBlue:[191,219,254] as RGB,
};

const VERDICT_PILL: Record<string, { bg: RGB; fg: RGB }> = {
  Priority:    { bg: [220,252,231], fg: [22,101, 52] },
  Promising:   { bg: [224,242,254], fg: [ 7, 89,133] },
  Conditional: { bg: [254,243,199], fg: [146, 64, 14] },
  Excluded:    { bg: [254,226,226], fg: [153, 27, 27] },
};
const INVESTIGATION_TEXT: Record<string, string> = {
  PRIORITY_INVESTIGATION_ZONE: 'Priority investigation zone',
  STRONG_CANDIDATE: 'Strong candidate',
  PROVISIONAL_CANDIDATE: 'Provisional candidate',
  WEAK_CANDIDATE: 'Weak candidate',
  NO_RELIABLE_RECOMMENDATION: 'Not recommended',
  EXCLUDED: 'Excluded',
};
const STABILITY_TEXT: Record<string, string> = {
  ROBUST_TOP_CANDIDATE: 'Robust under weight changes',
  STABLE_TOP_3: 'Stable in the top 3',
  SCENARIO_SENSITIVE: 'Sensitive to weighting',
  WEAK_UNSTABLE: 'Unstable ranking',
  NOT_ENOUGH_CANDIDATES: 'Too few candidates to test stability',
};
const SPOT_VERDICT: Record<string, { text: string; col: RGB; bg: RGB }> = {
  good:     { text: 'Good spot',     col: C.green, bg: C.greenBg },
  fair:     { text: 'Fair spot',     col: C.amber, bg: C.amberBg },
  weak:     { text: 'Weak spot',     col: C.red,   bg: C.redBg },
  excluded: { text: 'Excluded land', col: C.s5,    bg: C.s1 },
};

// v1.6.8 — jsPDF's built-in Helvetica is Latin-1 only. Any string that
// reaches pdf.text() with characters outside it (em-dashes, arrows,
// superscripts — all common in backend note text) rendered as garbage
// with exploded letter-spacing. Every string is routed through this
// sanitizer via the pdf.text wrapper below.
export const asciiSafe = (t: string): string => String(t ?? '')
  .replace(/[—–]/g, '-')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/→/g, '->').replace(/←/g, '<-')
  .replace(/▲/g, '[+]').replace(/▼/g, '[-]')
  .replace(/²/g, '2').replace(/³/g, '3')
  .replace(/[×✕]/g, 'x')
  .replace(/≈/g, '~').replace(/≥/g, '>=').replace(/≤/g, '<=')
  .replace(/[•·]/g, '-')
  .replace(/…/g, '...')
  .replace(/[✓✔]/g, 'OK')
  .replace(/[^\x00-\xFF]/g, '');

const humanize = (s?: string | null) =>
  (s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, c => c.toUpperCase());

const km = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${Math.round(m)} m`;

const scoreCol = (s: number, excl = false): RGB =>
  excl ? C.s5 : s >= 7.5 ? C.green : s >= 5 ? C.amber : C.red;

/** How a factor got into the analysis — matches the drawer's vocabulary. */
export const originText = (o?: string | null): string =>
  o === 'brief' ? 'From your brief'
  : o === 'answer' ? 'From your answer'
  : o === 'user' ? 'Added by you'
  : o === 'framework' ? 'Framework' : '';

/** "6 factors (4 framework, 2 from the brief)" */
export function factorMix(criteria: MCDACriteria[]): string {
  const n = criteria.length;
  if (n === 0) return 'No factors';
  const fw = criteria.filter(c => !c.origin || c.origin === 'framework').length;
  const yours = n - fw;
  return `${n} factor${n === 1 ? '' : 's'}` + (yours > 0 ? ` (${fw} framework, ${yours} from your brief)` : ' (framework)');
}

// ─── Layout kit ─────────────────────────────────────────────────────────────
interface Cell {
  text?: string;
  size?: number;
  style?: 'normal' | 'bold' | 'italic' | 'bolditalic';
  color?: RGB;
  align?: 'left' | 'right' | 'center';
  /** second, smaller line under `text` */
  sub?: string;
  subColor?: RGB;
  /** custom painter; y is the row's top, h the row height */
  draw?: (x: number, y: number, w: number, h: number) => void;
  /** minimum row height this cell needs (for custom painters) */
  minH?: number;
}
interface Col { w: number; header: string; align?: 'left' | 'right' | 'center' }

class Doc {
  pdf: any;
  readonly pw = 210; readonly ph = 297;
  readonly pageMl = 16; readonly mr = 16;
  /** current left margin / content width — narrowed inside column() */
  ml = 16; cw = 210 - 32;
  readonly top = 22; readonly bottom = 297 - 16;
  y = 22;
  toc: { num: string; title: string; page: number }[] = [];
  running = '';

  constructor(pdf: any) { this.pdf = pdf; }

  // ── primitives ──
  fill(c: RGB) { this.pdf.setFillColor(c[0], c[1], c[2]); }
  stroke(c: RGB) { this.pdf.setDrawColor(c[0], c[1], c[2]); }
  font(size: number, style: Cell['style'] = 'normal', color: RGB = C.ink) {
    this.pdf.setFontSize(size); this.pdf.setFont('helvetica', style);
    this.pdf.setTextColor(color[0], color[1], color[2]);
  }
  /** line height in mm for a font size in pt */
  lh(size: number) { return size * 0.3528 * 1.38; }
  width(text: string, size: number, style: Cell['style'] = 'normal') {
    this.pdf.setFontSize(size); this.pdf.setFont('helvetica', style);
    return this.pdf.getTextWidth(asciiSafe(text));
  }
  /** Wrap at the size it will be drawn with — the v2.6.x overflow bug was measuring at the previous size. */
  wrap(text: string, w: number, size: number, style: Cell['style'] = 'normal'): string[] {
    this.pdf.setFontSize(size); this.pdf.setFont('helvetica', style);
    const t = asciiSafe(text).replace(/\s+/g, ' ').trim();
    if (!t) return [];
    return this.pdf.splitTextToSize(t, Math.max(4, w)) as string[];
  }
  /** Truncate by measured width, with an ellipsis. */
  fit(text: string, w: number, size: number, style: Cell['style'] = 'normal'): string {
    const t = asciiSafe(text).replace(/\s+/g, ' ').trim();
    if (this.width(t, size, style) <= w) return t;
    let lo = 0, hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.width(t.slice(0, mid) + '...', size, style) <= w) lo = mid; else hi = mid - 1;
    }
    return t.slice(0, lo).trimEnd() + '...';
  }
  text(t: string, x: number, y: number, opts: { align?: 'left' | 'right' | 'center'; w?: number; link?: string } = {}) {
    const s = asciiSafe(t);
    let tx = x;
    if (opts.align === 'right') tx = x + (opts.w ?? 0) - this.pdf.getTextWidth(s);
    else if (opts.align === 'center') tx = x + (opts.w ?? 0) / 2 - this.pdf.getTextWidth(s) / 2;
    if (opts.link) this.pdf.textWithLink(s, tx, y, { url: opts.link });
    else this.pdf.text(s, tx, y);
  }
  rect(x: number, y: number, w: number, h: number, fillC?: RGB, strokeC?: RGB, r = 0) {
    if (fillC) this.fill(fillC);
    if (strokeC) { this.stroke(strokeC); this.pdf.setLineWidth(0.25); }
    const mode = fillC && strokeC ? 'FD' : fillC ? 'F' : 'S';
    if (r > 0) this.pdf.roundedRect(x, y, w, h, r, r, mode); else this.pdf.rect(x, y, w, h, mode);
  }
  hline(y: number, col: RGB = C.s2, lw = 0.25, x0 = this.ml, x1 = this.pw - this.mr) {
    this.stroke(col); this.pdf.setLineWidth(lw); this.pdf.line(x0, y, x1, y);
  }

  // ── pages ──
  /** Run `fn` with the flowing blocks confined to a column. */
  column(x: number, w: number, fn: () => void) {
    const [ml, cw] = [this.ml, this.cw];
    this.ml = x; this.cw = w;
    try { fn(); } finally { this.ml = ml; this.cw = cw; }
  }
  pageHeader() {
    this.font(9.5, 'bold', C.navy); this.text('STRATA', this.pageMl, 12);
    this.font(9.5, 'bold', C.teal); this.text('GEO', this.pageMl + this.width('STRATA', 9.5, 'bold') + 0.6, 12);
    this.font(7, 'normal', C.s5);
    this.text(this.fit(this.running, 120, 7), this.pw - this.mr, 12, { align: 'right' });
    this.hline(15.5, C.s2, 0.3);
    this.y = this.top;
  }
  newPage() { this.pdf.addPage(); this.pageHeader(); }
  need(h: number) { if (this.y + h > this.bottom) this.newPage(); }
  gap(n = 3) { this.y += n; }
  allFooters(reference: string) {
    const n = this.pdf.internal.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      this.pdf.setPage(i);
      this.hline(this.ph - 11, C.s2, 0.3, this.pageMl);
      this.font(6.5, 'normal', C.s5);
      this.text(`Stratageo  |  Screening-level assessment - field validation required before any commitment${reference ? `  |  Ref ${reference}` : ''}`, this.pageMl, this.ph - 7);
      this.text(`Page ${i} of ${n}`, this.pw - this.mr, this.ph - 7, { align: 'right' });
    }
  }

  // ── blocks ──
  h1(num: string, title: string) {
    this.need(16);
    this.toc.push({ num, title, page: this.pdf.internal.getNumberOfPages() });
    this.font(8.5, 'bold', C.navy); this.text(num, this.ml, this.y + 5);
    this.font(12.5, 'bold', C.ink); this.text(title, this.ml + 9, this.y + 5);
    this.hline(this.y + 8, C.navy, 0.5, this.ml, this.ml + 22);
    this.hline(this.y + 8, C.s2, 0.3, this.ml + 22);
    this.y += 14;
  }
  h2(title: string) {
    this.need(9);
    this.font(7, 'bold', C.s5); this.text(title.toUpperCase(), this.ml, this.y + 3);
    this.y += 6.5;
  }
  /** Paragraph, page-break aware, returns lines drawn. */
  para(text: string, opts: { x?: number; w?: number; size?: number; style?: Cell['style']; color?: RGB; after?: number } = {}) {
    const { x = this.ml, w = this.cw, size = 8.5, style = 'normal', color = C.s7, after = 2 } = opts;
    const lines = this.wrap(text, w, size, style);
    const lh = this.lh(size);
    for (const ln of lines) {
      this.need(lh);
      this.font(size, style, color);
      this.text(ln, x, this.y + lh * 0.78);
      this.y += lh;
    }
    this.y += after;
    return lines.length;
  }
  /** Bulleted list, page-break aware. */
  bullets(items: string[], opts: { x?: number; w?: number; size?: number; color?: RGB } = {}) {
    const { x = this.ml, w = this.cw, size = 8.2, color = C.s7 } = opts;
    for (const it of items) {
      const lines = this.wrap(it, w - 5, size);
      const lh = this.lh(size);
      lines.forEach((ln, i) => {
        this.need(lh);
        this.font(size, 'normal', color);
        if (i === 0) { this.fill(C.navy); this.pdf.circle(x + 1.2, this.y + lh * 0.5, 0.7, 'F'); }
        this.text(ln, x + 5, this.y + lh * 0.78);
        this.y += lh;
      });
      this.y += 1;
    }
  }
  /** Note card with a coloured left rule; grows to fit; never splits mid-card when it can fit on a page. */
  note(title: string | null, body: string, tone: 'info' | 'warn' | 'good' | 'bad' | 'plain' = 'plain') {
    const bg = tone === 'warn' ? C.amberBg : tone === 'good' ? C.greenBg : tone === 'bad' ? C.redBg : tone === 'info' ? C.skyBg : C.s1;
    const acc = tone === 'warn' ? C.amber : tone === 'good' ? C.green : tone === 'bad' ? C.red : tone === 'info' ? C.blue : C.navy;
    const inner = this.cw - 10;
    const bodyLines = this.wrap(body, inner, 8.2);
    const bh = bodyLines.length * this.lh(8.2);
    const h = (title ? 6.5 : 0) + bh + 6;
    if (h <= this.bottom - this.top) this.need(h);
    this.rect(this.ml, this.y, this.cw, h, bg);
    this.rect(this.ml, this.y, 1.6, h, acc);
    let ty = this.y + 4.5;
    if (title) { this.font(8.5, 'bold', acc); this.text(title, this.ml + 5, ty + 1.5); ty += 6.5; }
    this.font(8.2, 'normal', C.s7);
    for (const ln of bodyLines) { this.text(ln, this.ml + 5, ty + this.lh(8.2) * 0.6); ty += this.lh(8.2); }
    this.y += h + 3;
  }
  pill(text: string, x: number, y: number, bg: RGB, fg: RGB, size = 6.5): number {
    const w = this.width(text, size, 'bold') + 5;
    this.rect(x, y, w, 4.6, bg, undefined, 2.3);
    this.font(size, 'bold', fg); this.text(text, x + 2.5, y + 3.3);
    return w;
  }
  bar(score: number, x: number, y: number, w: number, h: number, col: RGB) {
    this.rect(x, y, w, h, C.s2, undefined, h / 2);
    const fw = Math.max(h, (Math.max(0, Math.min(10, score)) / 10) * w);
    this.rect(x, y, fw, h, col, undefined, h / 2);
  }
  /** Two-column key/value table (no header). */
  kv(rows: [string, string][], opts: { keyW?: number; size?: number } = {}) {
    const { keyW = 34, size = 8 } = opts;
    for (const [k, v] of rows) {
      const lines = this.wrap(v, this.cw - keyW - 4, size);
      const lh = this.lh(size);
      const h = Math.max(1, lines.length) * lh + 2.6;
      this.need(h);
      this.hline(this.y, C.s2, 0.2);
      this.font(size - 0.8, 'bold', C.s5); this.text(k.toUpperCase(), this.ml, this.y + 1.3 + lh * 0.78);
      this.font(size, 'normal', C.ink);
      lines.forEach((ln, i) => this.text(ln, this.ml + keyW, this.y + 1.3 + lh * 0.78 + i * lh));
      this.y += h;
    }
    this.hline(this.y, C.s2, 0.2);
    this.y += 3;
  }
  /** Generic table: wraps cells, repeats the header after a page break. */
  table(cols: Col[], rows: Cell[][], opts: { size?: number; headBg?: RGB; headFg?: RGB; zebra?: boolean; pad?: number } = {}) {
    const { size = 7.8, headBg = C.ink, headFg = C.white, zebra = true, pad = 2.2 } = opts;
    const xs: number[] = []; let x = this.ml;
    for (const c of cols) { xs.push(x); x += c.w; }
    const header = () => {
      this.rect(this.ml, this.y, this.cw, 6.2, headBg);
      this.font(6.5, 'bold', headFg);
      cols.forEach((c, i) => this.text(c.header.toUpperCase(), xs[i] + 2, this.y + 4.2, { align: c.align, w: c.w - 4 }));
      this.y += 6.2;
    };
    this.need(6.2 + 10);
    header();
    rows.forEach((row, ri) => {
      // measure
      const laid = row.map((cell, i) => {
        const w = cols[i].w - 4;
        const lines = cell.text ? this.wrap(cell.text, w, cell.size ?? size, cell.style ?? 'normal') : [];
        const sub = cell.sub ? this.wrap(cell.sub, w, (cell.size ?? size) - 1.4, 'italic') : [];
        const h = lines.length * this.lh(cell.size ?? size) + sub.length * this.lh((cell.size ?? size) - 1.4);
        return { lines, sub, h: Math.max(h, cell.minH ?? 0) };
      });
      const rh = Math.max(...laid.map(l => l.h), this.lh(size)) + pad * 2;
      if (this.y + rh > this.bottom) { this.newPage(); header(); }
      if (zebra && ri % 2 === 1) this.rect(this.ml, this.y, this.cw, rh, C.s1);
      row.forEach((cell, i) => {
        const cx = xs[i] + 2, w = cols[i].w - 4;
        const sz = cell.size ?? size;
        if (cell.draw) { cell.draw(cx, this.y, w, rh); return; }
        let ty = this.y + pad + this.lh(sz) * 0.78;
        this.font(sz, cell.style ?? 'normal', cell.color ?? C.ink);
        for (const ln of laid[i].lines) { this.text(ln, cx, ty, { align: cell.align ?? cols[i].align, w }); ty += this.lh(sz); }
        if (laid[i].sub.length) {
          this.font(sz - 1.4, 'italic', cell.subColor ?? C.s5);
          for (const ln of laid[i].sub) { this.text(ln, cx, ty - 0.4, { align: cell.align ?? cols[i].align, w }); ty += this.lh(sz - 1.4); }
        }
      });
      this.hline(this.y + rh, C.s2, 0.2);
      this.y += rh;
    });
    this.y += 4;
  }
}

// ─── The report ─────────────────────────────────────────────────────────────
export async function exportAnalysisPdf(
  result: AnalysisResult,
  locations: LocationData[],
  spec: AnalysisSpec | null,
): Promise<void> {
  if (!result || locations.length === 0) return;
  try {
    const { jsPDF } = jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const d = new Doc(pdf);
    const r = result as any;
    const et = r.evidenceTrail;
    const target = result.targetCell ?? null;
    const isSpot = !!target;
    const withheld = r.recommendationWithheld === true;

    const ranked = [...locations].sort((a, b) =>
      a.excluded !== b.excluded ? (a.excluded ? 1 : -1) : b.mcda_score - a.mcda_score);
    const live = ranked.filter(l => !l.excluded);
    const topLoc = live[0] ?? ranked[0];
    const exec = buildExecutiveSummary(result, ranked);
    const criteria = topLoc?.criteria_breakdown ?? [];
    const reference: string = r.jobRef || et?.jobId?.slice(0, 8) || '';
    const dateStr = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const engineVer: string = et?.engineVersion || __APP_VERSION__;
    const business = result.business_type || 'Site suitability';
    const place = target?.areaHint ? `near ${target.areaHint}` : (result.target_location || '');
    d.running = `Site Suitability Screening  |  ${business}${place ? `  |  ${place}` : ''}`;

    const studyAreaText = isSpot
      ? `${km(target!.radiusM ?? 1500)} around your pin (${target!.point.lat.toFixed(5)}, ${target!.point.lng.toFixed(5)})`
      : (et?.studyArea?.label || result.target_location || 'as briefed');
    const gridText = et?.studyArea?.h3Resolution
      ? `H3 level ${et.studyArea.h3Resolution}, ${exec.screenedCells ?? et.studyArea.h3CellCountBeforeMasks ?? '?'} cells`
      : (exec.screenedCells ? `${exec.screenedCells} cells` : '');
    const widestCatchment = Math.max(0, ...locations.map(l => l.searchRadiusM || 0));
    const briefRaw: string = et?.prompt?.rawPrompt || r.spec?.objective || '';
    const brief = briefRaw.length > 240 ? `${briefRaw.slice(0, 237).trimEnd()}...` : briefRaw;

    // ════════════════════════════════════════════════════════════════════════
    // COVER
    // ════════════════════════════════════════════════════════════════════════
    const bandH = 112;
    d.rect(0, 0, d.pw, bandH, C.navyD);
    d.rect(0, bandH, d.pw, 1.2, C.teal);
    d.font(15, 'bold', C.white); d.text('STRATA', d.ml, 24);
    d.font(15, 'bold', C.teal); d.text('GEO', d.ml + d.width('STRATA', 15, 'bold') + 1, 24);
    d.font(7.5, 'normal', C.paleBlue); d.text('LOCATION INTELLIGENCE', d.ml + 44, 24);
    d.font(8, 'bold', C.paleBlue);
    d.text(isSpot ? 'SPOT CHECK  -  SITE SUITABILITY SCREENING REPORT' : 'SITE SUITABILITY SCREENING REPORT', d.ml, 46);
    // title (wrap to two lines at most)
    const titleLines = d.wrap(business.replace(/^\w/, c => c.toUpperCase()), d.cw, 26, 'bold').slice(0, 2);
    d.font(26, 'bold', C.white);
    let ty = 62;
    for (const ln of titleLines) { d.text(ln, d.ml, ty); ty += 12; }
    d.font(12.5, 'normal', C.paleBlue);
    d.text(d.fit(place || studyAreaText, d.cw, 12.5), d.ml, ty + 1);
    d.font(7.5, 'normal', C.paleBlue);
    d.text([dateStr, reference ? `Reference ${reference}` : '', `Engine v${engineVer}`].filter(Boolean).join('     '), d.ml, bandH - 8);
    if (withheld) {
      d.font(7.5, 'bold', [253, 224, 71]); d.text('RECOMMENDATION WITHHELD - SEE SECTION 1', d.pw - d.mr, bandH - 8, { align: 'right' });
    }

    // ── three headline tiles ──
    const tileY = bandH + 12, tileH = 32, tileGap = 5;
    const tileW = (d.cw - tileGap * 2) / 3;
    const tile = (i: number, label: string, big: string, bigCol: RGB, sub: string, pillTxt?: string, pillStyle?: { bg: RGB; fg: RGB }) => {
      const x = d.ml + i * (tileW + tileGap);
      d.rect(x, tileY, tileW, tileH, C.s1, C.s2, 1.5);
      d.font(6.5, 'bold', C.s5); d.text(label.toUpperCase(), x + 5, tileY + 7);
      d.font(19, 'bold', bigCol); d.text(d.fit(big, tileW - 10, 19, 'bold'), x + 5, tileY + 18);
      if (pillTxt && pillStyle) d.pill(pillTxt, x + 5 + d.width(big, 19, 'bold') + 3, tileY + 13.2, pillStyle.bg, pillStyle.fg);
      d.font(7, 'normal', C.s7);
      const subLines = d.wrap(sub, tileW - 10, 7).slice(0, 2);
      subLines.forEach((ln, li) => d.text(ln, x + 5, tileY + 24 + li * 3.6));
    };
    if (isSpot) {
      const sv = SPOT_VERDICT[target!.verdict] ?? SPOT_VERDICT.fair;
      const rankTxt = target!.screeningRank && target!.cellsEligible
        ? `Ranks ${target!.screeningRank} of ${target!.cellsEligible} cells on the screening score`
        : (target!.verdictText || '');
      tile(0, 'Your spot', sv.text, sv.col, rankTxt);
    } else if (topLoc) {
      tile(0, 'Top-ranked zone', `${topLoc.mcda_score.toFixed(1)}`, scoreCol(topLoc.mcda_score, topLoc.excluded),
        `${topLoc.name}${topLoc.areaHint ? `, near ${topLoc.areaHint}` : ''} - best of ${exec.verifiedCells ?? live.length} zones re-verified`,
        exec.topZoneVerdict ?? undefined, exec.topZoneVerdict ? VERDICT_PILL[exec.topZoneVerdict] : undefined);
    }
    const confLevel: string = r.unifiedConfidence?.level || (spec ? humanize(spec.confidence) : '');
    tile(1, 'Screening confidence', confLevel || 'n/a',
      confLevel === 'High' ? C.green : confLevel === 'Medium' ? C.amber : confLevel ? C.red : C.s5,
      r.unifiedConfidence?.reason || 'Data sufficiency and reliability critique combined');
    tile(2, 'Screened', exec.screenedCells != null ? `${exec.screenedCells} cells` : `${live.length} zones`,
      C.navy,
      `${exec.eligibleCells ?? '?'} eligible after masks  -  ${live.length} zone${live.length === 1 ? '' : 's'} ranked${exec.verifiedCells != null ? `, ${exec.verifiedCells} re-verified` : ''}`);
    d.y = tileY + tileH + 12;

    // ── at a glance ──
    d.h2('At a glance');
    const glance: [string, string][] = [];
    if (brief) glance.push(['Brief', brief]);
    glance.push(['Business', `${business}${r.archetypeKey ? `  -  framework: ${humanize(r.archetypeKey)}` : ''}`]);
    glance.push(['Study area', `${studyAreaText}${gridText ? `  -  ${gridText}` : ''}`]);
    glance.push(['Factors', factorMix(criteria) + (widestCatchment ? `  -  widest catchment ${km(widestCatchment)}` : '')]);
    glance.push(['Scoring', `Two-pass: every cell screened on Euclidean proxies, then ${exec.verifiedCells ?? 'the top'} zones re-verified with travel-time and routing data; the ranking uses the refined scores.`]);
    glance.push(['Claim level', `${humanize(r.siteClaimLevel || 'micro_market_zone')} - zones to investigate, not parcels or exact sites.`]);
    glance.push(['Prepared', `${dateStr} by Stratageo  -  App v${__APP_VERSION__}, Engine v${engineVer}${et?.evidenceVersion ? `, evidence v${et.evidenceVersion}` : ''}`]);
    d.kv(glance, { keyW: 30, size: 8 });

    // ── contents (filled at the end) ──
    const tocY = Math.min(Math.max(d.y + 4, 232), 246);
    // ── disclaimer ──
    d.font(6.8, 'normal', C.s5);
    const disc = d.wrap('This document is a screening-level assessment produced from public and licensed spatial data (OpenStreetMap, Google Places, OpenRouteService). It identifies zones worth investigating and the evidence behind each; it is not legal, parcel, zoning, rent or field due diligence, and it is not an investment recommendation.', d.cw, 6.8);
    disc.forEach((ln, i) => d.text(ln, d.ml, d.ph - 22 + i * 3.2));

    // ════════════════════════════════════════════════════════════════════════
    // 1  EXECUTIVE SUMMARY
    // ════════════════════════════════════════════════════════════════════════
    d.newPage();
    d.h1('1', 'Executive summary');
    if (isSpot) {
      const sv = SPOT_VERDICT[target!.verdict] ?? SPOT_VERDICT.fair;
      const h = 22;
      d.need(h + 4);
      d.rect(d.ml, d.y, d.cw, h, sv.bg, undefined, 1.5);
      d.rect(d.ml, d.y, 1.8, h, sv.col);
      d.font(6.5, 'bold', C.s5); d.text('VERDICT FOR YOUR SPOT', d.ml + 6, d.y + 6);
      d.font(15, 'bold', sv.col); d.text(`${sv.text} for a ${business}`, d.ml + 6, d.y + 13.5);
      d.font(7.5, 'normal', C.s7);
      d.text(d.fit(target!.verdictText || '', d.cw - 12, 7.5), d.ml + 6, d.y + 19);
      d.y += h + 4;
    }
    d.para(result.summary || 'No summary was produced for this run.', { size: 9, color: C.s7, after: 3 });

    // verdict strip
    {
      const facts: [string, string][] = [];
      if (!isSpot && exec.topZoneVerdict) facts.push(['Top zone verdict', exec.topZoneVerdict]);
      if (exec.confidenceLevel) facts.push(['Screening confidence', exec.confidenceLevel]);
      if (exec.spatialScale) facts.push(['Spatial scale', humanize(exec.spatialScale)]);
      if (exec.eligibleCells != null) facts.push(['Eligible cells', `${exec.eligibleCells}${exec.screenedCells != null ? ` of ${exec.screenedCells}` : ''}`]);
      if (isSpot && target!.verified) facts.push(['Re-verified rank', `${target!.verified.rank ?? '-'} of ${target!.verified.of}`]);
      if (facts.length) {
        const fw = d.cw / facts.length;
        d.need(14);
        d.rect(d.ml, d.y, d.cw, 13, C.s1, undefined, 1.2);
        facts.forEach(([k, v], i) => {
          const x = d.ml + i * fw;
          d.font(6.2, 'bold', C.s5); d.text(k.toUpperCase(), x + 4, d.y + 5);
          d.font(9.5, 'bold', C.navy); d.text(d.fit(v, fw - 8, 9.5, 'bold'), x + 4, d.y + 10.3);
        });
        d.y += 17;
      }
    }
    if (exec.criticalNextCheck) d.note('Critical next check', exec.criticalNextCheck, 'warn');
    if (withheld) d.note('Recommendation withheld', result.plainReason || r.reason || 'The reliability critic judged this ranking unreliable; the zones below are shown for context only.', 'bad');
    if (result.shortlist?.bestScreeningNote) d.note(null, result.shortlist.bestScreeningNote, 'info');

    // ════════════════════════════════════════════════════════════════════════
    // 2  RANKED ZONES
    // ════════════════════════════════════════════════════════════════════════
    d.h1('2', 'Ranked zones');
    d.para(exec.verifiedCells != null
      ? `Scores are relative to the ${exec.verifiedCells} zones that were re-verified with travel-time and routing data; a 10 is the best of that shortlist, not a universal grade.`
      : 'Scores are relative to the zones ranked in this run, not a universal grade.', { size: 7.8, color: C.s5, after: 3 });
    d.table(
      [
        { w: 10, header: '#', align: 'center' },
        { w: 66, header: 'Zone' },
        { w: 16, header: 'Score', align: 'right' },
        { w: 44, header: 'Suitability index' },
        { w: 42, header: 'Verdict' },
      ],
      ranked.map((loc, i) => {
        const col = scoreCol(loc.mcda_score, loc.excluded);
        const verdict = loc.excluded ? 'Excluded' : withheld ? 'Not recommended' : ((loc as any).screeningVerdict as string | undefined) || '';
        const il = loc.investigationLabel && INVESTIGATION_TEXT[loc.investigationLabel] ? INVESTIGATION_TEXT[loc.investigationLabel] : '';
        const stab = loc.stabilityLabel && STABILITY_TEXT[loc.stabilityLabel] ? STABILITY_TEXT[loc.stabilityLabel] : '';
        return [
          { draw: (x: number, y: number, w: number, h: number) => {
              d.rect(x + w / 2 - 3.2, y + h / 2 - 3.2, 6.4, 6.4, col, undefined, 1);
              d.font(7.5, 'bold', C.white); d.text(String(i + 1), x, y + h / 2 + 1.3, { align: 'center', w });
            }, minH: 8 },
          { text: `${loc.name}${loc.isTarget ? '  (your spot)' : ''}`, style: 'bold', color: loc.excluded ? C.s5 : C.ink,
            sub: `${loc.areaHint ? `near ${loc.areaHint}  -  ` : ''}${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` },
          { text: loc.scoreWithheld ? 'n/a' : `${loc.mcda_score.toFixed(1)}`, style: 'bold', color: col, size: 10, align: 'right' },
          { draw: (x: number, y: number, w: number, h: number) => d.bar(loc.mcda_score, x, y + h / 2 - 1.5, w, 3, col), minH: 6 },
          { text: verdict || il || '-', style: 'bold', color: VERDICT_PILL[verdict]?.fg ?? C.s7, sub: [verdict && il ? il : '', stab].filter(Boolean).join('  -  ') },
        ] as Cell[];
      }),
    );

    // ════════════════════════════════════════════════════════════════════════
    // 3  SCORING FRAMEWORK
    // ════════════════════════════════════════════════════════════════════════
    d.h1('3', 'Scoring framework');
    d.para(`${factorMix(criteria)}. Framework factors come from the reviewed ${r.archetypeKey ? humanize(r.archetypeKey) : 'business'} playbook; factors marked "from your brief" were added because the brief named them. Weights are normalised to 100% and shown as applied.`, { size: 7.8, color: C.s5, after: 3 });
    const evFactors: any[] = et?.factors ?? [];
    const catchmentFor = (name: string): string => {
      const f = evFactors.find(x => x.displayName === name);
      return f?.catchment ? String(f.catchment) : '';
    };
    d.table(
      [
        { w: 78, header: 'Factor' },
        { w: 26, header: 'Direction' },
        { w: 16, header: 'Weight', align: 'right' },
        { w: 28, header: 'Catchment' },
        { w: 30, header: 'Origin' },
      ],
      criteria.map(cr => {
        const neg = cr.direction === 'negative';
        const dirTxt = (cr as any).scoringCurve === 'target_band' ? 'Moderate is best' : neg ? 'Less is better' : 'More is better';
        return [
          { text: `${cr.name}${cr.required ? ' *' : ''}`, style: 'bold', sub: cr.whyItMatters || '' },
          { text: dirTxt, color: neg ? C.amber : C.teal, style: 'bold' },
          { text: `${Math.round(cr.weight * 100)}%`, align: 'right' },
          { text: catchmentFor(cr.name) || (cr.justification || '').match(/within ([^(]+)/)?.[1]?.trim() || '-' },
          { text: originText(cr.origin) || 'Framework', color: cr.origin && cr.origin !== 'framework' ? C.navy : C.s7 },
        ] as Cell[];
      }),
    );
    if (criteria.some(c => c.required)) d.para('* required factor - treated as a hard constraint.', { size: 6.8, color: C.s5 });
    const notes: string[] = ((spec as any)?.parsingNotes ?? []).filter((n: any) => typeof n === 'string');
    const skipped: any[] = r.analysisCompleteness?.skippedStages ?? [];
    if (notes.length || skipped.length) {
      d.h2('Planner decisions for this run');
      d.bullets([
        ...skipped.map(s => `${humanize(s.stage)} skipped - ${s.reason}${s.savedCost ? ` (cost saved: ${s.savedCost})` : ''}`),
        ...notes.filter(n => !/^Planner:/.test(n)).slice(0, 8),
      ]);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4  STUDY AREA MAP
    // ════════════════════════════════════════════════════════════════════════
    let figure: Awaited<ReturnType<typeof renderMapFigure>> = null;
    try {
      figure = await renderMapFigure({
        hexGrid: r.hexGrid ?? [],
        locations: ranked,
        studyAreaBoundary: r.studyAreaBoundary,
        withheld,
        weightsAdjusted: r.weightAudit?.adjustedByUser === true,
        target: target ? { lat: target.point.lat, lng: target.point.lng } : null,
      });
    } catch { figure = null; }
    if (figure) {
      d.newPage();
      d.h1('4', 'Study area map');
      const imgW = d.cw;
      const imgH = Math.min(imgW / figure.aspect, d.bottom - d.y - 14);
      const drawW = imgH * figure.aspect;
      pdf.addImage(figure.dataUrl, 'JPEG', d.ml + (d.cw - drawW) / 2, d.y, drawW, imgH);
      d.y += imgH + 4;
      d.para(`Figure 1. Screening surface over the ${studyAreaText}: cell colour is the Pass-A screening score (stretched to the plotted range); numbered pins are the ranked zones${isSpot ? '; the blue pin is your spot' : ''}. Zones are H3 micro-market cells, not parcels.${figure.hasBasemap ? '' : ' Basemap tiles were unavailable at export time.'}`, { size: 7.2, color: C.s5 });
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5  ZONE PROFILES
    // ════════════════════════════════════════════════════════════════════════
    for (let li = 0; li < ranked.length; li++) {
      const loc = ranked[li];
      const ac = scoreCol(loc.mcda_score, loc.excluded);
      d.newPage();
      if (li === 0) d.h1('5', 'Zone profiles'); else d.y = d.top + 2;

      // title card
      const th = 24;
      d.rect(d.ml, d.y, d.cw, th, C.s1, C.s2, 1.5);
      d.rect(d.ml, d.y, 1.8, th, ac);
      d.rect(d.ml + 6, d.y + 6, 11, 11, ac, undefined, 1.5);
      d.font(11, 'bold', C.white); d.text(String(li + 1), d.ml + 6, d.y + 13.8, { align: 'center', w: 11 });
      d.font(15, 'bold', loc.excluded ? C.s5 : C.ink);
      d.text(d.fit(`5.${li + 1}  ${loc.name}${loc.isTarget ? '  (your spot)' : ''}${loc.excluded ? '  [excluded]' : ''}`, d.cw - 60, 15, 'bold'), d.ml + 21, d.y + 11);
      d.font(7.5, 'normal', C.s5);
      d.text(`${loc.areaHint ? `near ${loc.areaHint}   |   ` : ''}${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`, d.ml + 21, d.y + 17);
      d.font(7.5, 'bold', C.navy);
      d.text('Open in Google Maps', d.ml + 21, d.y + 21.5, { link: `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` });
      // score pill — "/10" inside the pill this time
      d.rect(d.pw - d.mr - 30, d.y + 4.5, 25, 15, ac, undefined, 2);
      d.font(17, 'bold', C.white);
      const sTxt = loc.scoreWithheld ? 'n/a' : loc.mcda_score.toFixed(1);
      d.text(sTxt, d.pw - d.mr - 30, d.y + 13, { align: 'center', w: 25 });
      d.font(6, 'normal', C.white); d.text('out of 10', d.pw - d.mr - 30, d.y + 17.3, { align: 'center', w: 25 });
      d.y += th + 3;

      // tags
      {
        let x = d.ml;
        const verdict = loc.excluded ? 'Excluded' : withheld ? '' : ((loc as any).screeningVerdict as string | undefined) || '';
        if (verdict && VERDICT_PILL[verdict]) x += d.pill(verdict, x, d.y, VERDICT_PILL[verdict].bg, VERDICT_PILL[verdict].fg, 7) + 2;
        const il = loc.investigationLabel && INVESTIGATION_TEXT[loc.investigationLabel];
        if (il) x += d.pill(il, x, d.y, C.s2, C.s7, 7) + 2;
        const stab = loc.stabilityLabel && STABILITY_TEXT[loc.stabilityLabel];
        if (stab) x += d.pill(stab, x, d.y, C.s2, C.s7, 7) + 2;
        if (loc.rankingBasis === 'screening') x += d.pill('Screening score only', x, d.y, C.amberBg, C.amber, 7) + 2;
        if (x > d.ml) d.y += 8;
      }

      const failedExcl = loc.exclusions.filter(e => !e.passed);
      if (failedExcl.length > 0) d.note('Excluded by rule', failedExcl.map(e => e.rule).join('; '), 'bad');
      if ((loc.reasoning || '').trim()) { d.h2('Assessment'); d.para(loc.reasoning, { size: 8.6, color: C.s7, after: 4 }); }

      // criteria table
      d.h2('Factor scores');
      d.table(
        [
          { w: 74, header: 'Factor & evidence' },
          { w: 40, header: 'Score index' },
          { w: 16, header: 'Score', align: 'right' },
          { w: 28, header: 'Observed', align: 'right' },
          { w: 20, header: 'Weight', align: 'right' },
        ],
        loc.criteria_breakdown.map(cr => {
          const neg = cr.direction === 'negative';
          const noData = cr.score == null;
          const s = cr.score ?? 0;
          const crCol: RGB = noData ? C.s4 : neg
            ? (s <= 3 ? C.red : s <= 6 ? C.amber : C.green)
            : (s >= 7 ? C.green : s >= 4 ? C.blue : C.red);
          return [
            { text: `${neg ? '[-] ' : '[+] '}${cr.name}`, style: 'bold', sub: cr.justification || (noData ? 'No data for this factor' : '') },
            { draw: (x: number, y: number, w: number, h: number) => {
                if (noData) { d.font(6.8, 'italic', C.s5); d.text(cr.dataStatus === 'unavailable' ? 'provider unavailable' : 'insufficient data', x, y + h / 2 + 1); }
                else d.bar(s, x, y + h / 2 - 1.5, w, 3, crCol);
              }, minH: 6 },
            { text: noData ? 'n/a' : s.toFixed(1), style: 'bold', color: crCol, size: 9.5, align: 'right', sub: noData ? '' : 'of 10' },
            { text: cr.rawValue == null ? '-' : String(cr.rawValue), style: 'bold', align: 'right', sub: cr.rawValue == null ? '' : 'features' },
            { text: `${Math.round(cr.weight * 100)}%`, align: 'right' },
          ] as Cell[];
        }),
        { size: 7.6 },
      );

      // two columns: mini-map | evidence counts + next checks
      let mini: Awaited<ReturnType<typeof renderMapFigure>> = null;
      try {
        mini = await renderMapFigure({
          hexGrid: r.hexGrid ?? [],
          locations: ranked,
          studyAreaBoundary: r.studyAreaBoundary,
          withheld,
          target: target ? { lat: target.point.lat, lng: target.point.lng } : null,
          focus: { lat: loc.lat, lng: loc.lng, radiusM: 650, rank: live.indexOf(loc) + 1 },
        });
      } catch { mini = null; }
      const colGap = 6;
      const leftW = mini ? 86 : 0;
      const rightX = d.ml + leftW + (mini ? colGap : 0);
      const rightW = d.cw - leftW - (mini ? colGap : 0);
      const miniH = mini ? leftW / mini.aspect : 0;
      d.need(Math.max(miniH + 12, 30));
      const blockTop = d.y;
      if (mini) {
        d.h2('Zone map');
        pdf.addImage(mini.dataUrl, 'JPEG', d.ml, d.y, leftW, miniH);
        d.font(6.6, 'normal', C.s5);
        d.text(d.fit(`Figure ${2 + li}. ~1.3 km across, centred on zone ${li + 1}${isSpot ? '; blue pin = your spot' : ''}.`, leftW, 6.6), d.ml, d.y + miniH + 3.5);
      }
      const leftBottom = d.y + miniH + 6;
      // right column
      d.y = blockTop;
      const sigs = Object.entries(loc.osmSignals || {}).slice(0, 6);
      const nextActs: string[] = ((loc as any).nextValidation as string[] | undefined) ?? [];
      d.column(rightX, rightW, () => {
        if (sigs.length > 0) {
          d.h2('Evidence counts');
          for (const [k, v] of sigs) {
            d.hline(d.y, C.s2, 0.2, rightX, rightX + rightW);
            d.font(7.6, 'normal', C.s7); d.text(d.fit(humanize(k), rightW - 22, 7.6), rightX, d.y + 3.8);
            d.font(8.5, 'bold', C.navy); d.text(String(v), rightX, d.y + 3.8, { align: 'right', w: rightW });
            d.y += 5.2;
          }
          d.hline(d.y, C.s2, 0.2, rightX, rightX + rightW);
          d.y += 4;
        }
        if (nextActs.length > 0) {
          d.h2('Next-stage validation');
          d.bullets(nextActs.slice(0, 6), { x: rightX, w: rightW, size: 7.6 });
        }
      });
      d.y = Math.max(d.y, leftBottom);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 6  METHODOLOGY
    // ════════════════════════════════════════════════════════════════════════
    d.newPage();
    d.h1('6', 'Methodology');
    const method: [string, string][] = [
      ['Intent and deterministic planning', 'The brief is interpreted conversationally by a server-configured language model, then a deterministic planner locks the analysis structure: a reviewed business playbook (archetype) fixes the scoring factors, weights and catchments, so an identical brief always produces an identical plan. The model writes explanations only - it cannot alter factors or weights.'],
      ['Spatial data collection', 'The study area is geocoded (Google primary, OpenStreetMap Nominatim fallback; coordinates supplied in the brief are used verbatim) and tiled with an H3 hexagonal grid. OpenStreetMap Overpass and Google Places count relevant features per factor catchment; water and no-build land (railway, ghat, heritage) are masked out as hard exclusions where the planner judged them relevant to the brief.'],
      ['Two-pass scoring', 'Every grid cell is scored on fast screening proxies and a weighted composite ranks the field; the top zones are then re-verified with real travel-time isochrones, routing and verified place counts, and the final ranking uses those refined scores. Positive factors reward higher counts, negative factors penalise them, and a factor with no data is excluded from the composite - never scored as zero.'],
      ['Exclusions and confidence', 'Named-area and engine-level exclusions are applied as hard filters. Confidence combines data sufficiency, provider health and a deterministic reliability critique; the overall verdict always takes the most conservative of the signals and is disclosed alongside every recommendation.'],
    ];
    method.forEach(([t, b], i) => {
      d.need(14);
      d.font(8.8, 'bold', C.navy); d.text(`6.${i + 1}  ${t}`, d.ml, d.y + 3.5);
      d.y += 6.5;
      d.para(b, { size: 8.2, color: C.s7, after: 4 });
    });
    d.note('Limitations', 'This is a screening-level assessment. OpenStreetMap coverage varies by region and sparse mapping can depress scores independently of real-world suitability; Google Places ranking and availability change over time. Scores are relative to the cells and zones in this run. Rent, floor area, availability, zoning and ownership are never scored - they are field checks. Site-level due diligence is required before any real-estate decision.', 'warn');
    if (r.unifiedConfidence) d.note(`Overall confidence: ${r.unifiedConfidence.level}`, r.unifiedConfidence.reason, r.unifiedConfidence.level === 'High' ? 'good' : 'warn');

    const hcv = r.hardConstraintVerification;
    if (hcv && Array.isArray(hcv.constraints) && hcv.constraints.length > 0) {
      d.h2(`Constraint verification  (${hcv.verifiedCount ?? 0} verified, ${hcv.unknownCount ?? 0} not verifiable, ${hcv.failedCount ?? 0} failed)`);
      const stTxt: Record<string, string> = {
        verified: 'Verified', proxy_verified: 'Proxy verified', not_verifiable: 'Not verifiable from data',
        requested_not_enforced: 'Requested - not enforced', failed: 'Failed', not_required: 'Not required',
      };
      d.table(
        [{ w: 60, header: 'Constraint' }, { w: 40, header: 'Status' }, { w: 78, header: 'Basis' }],
        hcv.constraints.map((c: any) => [
          { text: c.label, style: 'bold' },
          { text: stTxt[c.status] || humanize(c.status), color: c.status === 'verified' ? C.green : c.status === 'failed' ? C.red : C.s7, style: 'bold' },
          { text: c.reason || '-' },
        ] as Cell[]),
        { size: 7.4, headBg: C.s7 },
      );
    }
    {
      const wa = r.weightAudit;
      const adjusted = wa?.adjustedByUser === true;
      const defaults: Record<string, number> = wa?.defaultWeights || {};
      const executed = Object.fromEntries(criteria.map(c => [c.name, c.weight]));
      const names = Object.keys({ ...defaults, ...executed });
      if (names.length) {
        d.h2(adjusted ? 'Factor weight audit - adjusted by the user' : 'Factor weight audit - playbook defaults applied');
        d.table(
          [{ w: 98, header: 'Factor' }, { w: 40, header: 'Playbook default', align: 'right' }, { w: 40, header: 'Applied', align: 'right' }],
          names.map(n => [
            { text: n },
            { text: defaults[n] !== undefined ? `${Math.round(defaults[n] * 100)}%` : '-', align: 'right' },
            { text: executed[n] !== undefined ? `${Math.round(executed[n] * 100)}%` : '-', align: 'right', style: 'bold',
              color: adjusted && defaults[n] !== undefined && Math.round(defaults[n] * 100) !== Math.round((executed[n] ?? 0) * 100) ? C.amber : C.ink },
          ] as Cell[]),
          { size: 7.4, headBg: C.s7 },
        );
      }
    }
    {
      const dp: [string, string][] = [];
      if (r.planningMode) dp.push(['Planning mode', humanize(r.planningMode)]);
      if (r.archetypeKey) dp.push(['Playbook', humanize(r.archetypeKey)]);
      if (r.weightsSource) dp.push(['Weights source', humanize(r.weightsSource)]);
      if (r.llmRole) dp.push(['Language model role', humanize(r.llmRole)]);
      if (r.planningFingerprint) dp.push(['Planning ID', String(r.planningFingerprint)]);
      if (dp.length) { d.h2('Deterministic planning'); d.kv(dp, { keyW: 40, size: 7.8 }); }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 7  EVIDENCE APPENDIX
    // ════════════════════════════════════════════════════════════════════════
    if (et) {
      d.newPage();
      d.h1('7', 'Evidence appendix');
      d.para('Everything needed to reproduce this screening: the data snapshot, the queries made, the factor schema as executed and the scoring rule. Full data replay requires cached provider snapshots (not yet implemented).', { size: 7.8, color: C.s5, after: 4 });
      const candExcl = (et.exclusions || []).filter((e: any) => e.targetType === 'candidate').length;
      d.kv([
        ['Evidence version', String(et.evidenceVersion ?? '-')],
        ['Analysis ID', `${et.analysisId ?? '-'}${et.jobId ? `  (job ${et.jobId})` : ''}`],
        ['Created', et.createdAt ? new Date(et.createdAt).toLocaleString('en-IN') : '-'],
        ['Data snapshot', `${et.dataSnapshot?.snapshotId || 'n/a'}  -  provider mode ${et.dataSnapshot?.providerMode || 'live'}${et.dataSnapshot?.cacheHit ? ' (cache hit)' : ''}`],
        ['Study area', `${et.studyArea?.label || studyAreaText}  -  geometry hash ${et.studyArea?.geometryHash || 'n/a'}`],
        ['Grid', `H3 level ${et.studyArea?.h3Resolution ?? '?'}  -  ${et.studyArea?.h3CellCountBeforeMasks ?? '?'} cells before masks, ${et.studyArea?.h3CellCountAfterMasks ?? '?'} after`],
        ['Recommendations', `${et.recommendationSummary?.validRecommendationCount ?? '?'} valid of ${et.recommendationSummary?.requestedTopN ?? '?'} requested  -  ${et.recommendationSummary?.excludedCandidateCount ?? 0} excluded candidates, ${candExcl} candidate exclusions recorded`],
        ['Scoring rule', et.scoring?.formulaDescription || 'n/a'],
        ['Missing data', et.scoring?.missingDataHandling || 'Factors with no data are excluded from the composite, never scored 0.'],
      ], { keyW: 34, size: 7.8 });

      const pq: any[] = et.providerQueries || [];
      if (pq.length) {
        d.h2('Provider queries');
        d.table(
          [{ w: 34, header: 'Provider' }, { w: 88, header: 'Purpose' }, { w: 22, header: 'Features', align: 'right' }, { w: 34, header: 'Status' }],
          pq.slice(0, 40).map(q => [
            { text: String(q.provider) },
            { text: humanize(String(q.queryPurpose || '')).replace(/primary X /i, ''), sub: q.warning || '' },
            { text: String(q.featureCount ?? 0), align: 'right' },
            { text: `${q.responseStatus || '-'}${q.cacheHit ? ' (cached)' : ''}${q.durationMs != null ? `  ${(q.durationMs / 1000).toFixed(1)}s` : ''}`, color: C.s7 },
          ] as Cell[]),
          { size: 7.2, headBg: C.s7 },
        );
        if (pq.length > 40) d.para(`${pq.length - 40} further queries omitted for length; the full trail is in the portal.`, { size: 6.8, color: C.s5 });
      }
      if (evFactors.length) {
        d.h2('Factor schema as executed');
        d.table(
          [{ w: 62, header: 'Factor' }, { w: 16, header: 'Weight', align: 'right' }, { w: 22, header: 'Direction' }, { w: 34, header: 'Catchment' }, { w: 44, header: 'Sources' }],
          evFactors.map(f => [
            { text: String(f.displayName || f.factorKey), style: 'bold', sub: f.rawValueDescription || '' },
            { text: `${Math.round(f.weight * (f.weight > 1 ? 1 : 100))}%`, align: 'right' },
            { text: f.direction === 'negative' ? 'Less is better' : 'More is better' },
            { text: String(f.catchment || '-') },
            { text: (f.dataSources || []).join(', ') || '-' },
          ] as Cell[]),
          { size: 7.2, headBg: C.s7 },
        );
      }
      const lims: string[] = et.limitations || [];
      if (lims.length) { d.h2('Recorded limitations'); d.bullets(lims.slice(0, 10), { size: 7.6 }); }
    }
    if (r.uploadedCandidatesOnly) {
      d.note('Uploaded candidate points', `Candidate universe restricted to uploaded points only. Total uploaded: ${r.uploadedCandidateCount || 0}. Ranked: ${r.rankedUploadedCandidateCount || 0}. Excluded (invalid): ${r.excludedUploadedCandidateCount || 0}. No H3 hex-grid search was performed.`, 'info');
    }

    // ── next step ──
    d.gap(2);
    {
      const body = 'This report is a spatial screening: it identifies and ranks investigation zones with the evidence behind each. The next stage - a detailed site study - validates actual properties in these zones: current rent and availability, frontage and loading, footfall observation, zoning confirmation and parcel-level access. Contact Stratageo to commission a detailed site validation for this shortlist.';
      const lines = d.wrap(body, d.cw - 10, 8.2);
      const h = lines.length * d.lh(8.2) + 16;
      d.need(h);
      d.rect(d.ml, d.y, d.cw, h, C.greenBg, undefined, 1.5);
      d.rect(d.ml, d.y, 1.8, h, C.green);
      d.font(9, 'bold', C.green); d.text('NEXT STAGE: DETAILED SITE VALIDATION', d.ml + 6, d.y + 7);
      d.font(8, 'bold', C.navy); d.text('stratageo.in/contact.php', d.pw - d.mr - 5, d.y + 7, { align: 'right', link: config.contactUrl });
      d.font(8.2, 'normal', C.s7);
      lines.forEach((ln, i) => d.text(ln, d.ml + 6, d.y + 13.5 + i * d.lh(8.2)));
      d.y += h;
    }

    // ── contents on the cover, footers everywhere ──
    pdf.setPage(1);
    d.font(7, 'bold', C.s5); d.text('CONTENTS', d.ml, tocY);
    d.hline(tocY + 1.5, C.s2, 0.3);
    let cy = tocY + 6.5;
    const perCol = Math.ceil(d.toc.length / 2);
    d.toc.forEach((t, i) => {
      const col = i < perCol ? 0 : 1;
      const x = d.ml + col * (d.cw / 2 + 4);
      const yy = cy + (i - col * perCol) * 5;
      d.font(7.8, 'bold', C.navy); d.text(t.num, x, yy);
      d.font(7.8, 'normal', C.ink); d.text(t.title, x + 7, yy);
      d.font(7.8, 'normal', C.s5); d.text(String(t.page), x + d.cw / 2 - 6, yy, { align: 'right', w: 0 });
    });
    d.allFooters(reference);

    pdf.save(`Stratageo-SiteSuitability-${business.replace(/\s+/g, '-')}-${(result.target_location || 'spot').replace(/[\s,]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (e: any) { throw new Error(`PDF export failed: ${e?.message || 'unknown error'}`); }
}
