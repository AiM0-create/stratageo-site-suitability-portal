// ─── PDF report (v2.1.0) ───
//
// Moved out of App.tsx verbatim: 770 lines of jsPDF layout lived inside the
// root component's closure. Nothing here changed except the entry point —
// it takes the result, the ranked zones and the spec, and throws on failure
// so the caller can show the message. jsPDF and html2canvas are globals
// loaded from index.html.
import type { AnalysisResult, AnalysisSpec, LocationData } from '../types';
import { config } from '../config';
import { renderMapFigure } from './mapFigure';
import { buildExecutiveSummary } from './screeningPresentation';

declare const jspdf: any;

export async function exportAnalysisPdf(
  result: AnalysisResult,
  locations: LocationData[],
  spec: AnalysisSpec | null,
): Promise<void> {
  if (!result || locations.length === 0) return;
  try {
    const { jsPDF } = jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pw  = pdf.internal.pageSize.getWidth();  // 210
    const ph  = pdf.internal.pageSize.getHeight(); // 297
    const ml  = 14; const mr = 14;
    const cw  = pw - ml - mr;                      // 182 mm usable
    let y = 0;

    // ─── ASCII-safe direction labels (no Unicode arrows) ─────────────────────
    const dirTag = (dir: string) => dir === 'negative' ? '[-]' : '[+]';

    // v1.6.8 — jsPDF's built-in Helvetica is Latin-1 only. Any string that
    // reaches pdf.text() with characters outside it (em-dashes, arrows,
    // superscripts — all common in backend note text) rendered as garbage
    // with exploded letter-spacing (observed live on the evidence appendix
    // page). Every string is now routed through this sanitizer via a
    // pdf.text wrapper below.
    const asciiSafe = (t: string): string => String(t)
      .replace(/[—–]/g, '-')      // em/en dash
      .replace(/[‘’ʼ]/g, "'") // curly apostrophes
      .replace(/[“”]/g, '"')      // curly quotes
      .replace(/→/g, '->')              // right arrow
      .replace(/←/g, '<-')
      .replace(/▲/g, '[+]').replace(/▼/g, '[-]')
      .replace(/²/g, '2').replace(/³/g, '3')
      .replace(/[×✕]/g, 'x')
      .replace(/≈/g, '~').replace(/≥/g, '>=').replace(/≤/g, '<=')
      .replace(/[•·]/g, '-')       // bullets
      .replace(/…/g, '...')
      .replace(/[✓✔]/g, 'OK')
      .replace(/[^\x00-\xFF]/g, '');         // anything else non-Latin-1: drop
    const _origPdfText = pdf.text.bind(pdf);
    (pdf as any).text = (txt: any, ...rest: any[]) => _origPdfText(
      typeof txt === 'string' ? asciiSafe(txt)
        : Array.isArray(txt) ? txt.map(v => typeof v === 'string' ? asciiSafe(v) : v)
        : txt,
      ...rest,
    );
    // Plain-English labels for internal enum values that were leaking into
    // the report verbatim (micro_market_zone, recommended_sites, ...).
    const humanize = (s?: string | null) =>
      (s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

    // ─── Colours ──────────────────────────────────────────────────────────────
    const C = {
      navy:   [29,  78, 216] as [number,number,number],
      teal:   [5,  150, 105] as [number,number,number],
      green:  [22, 163,  74] as [number,number,number],
      amber:  [217,119,   6] as [number,number,number],
      red:    [220,  38,  38] as [number,number,number],
      s9:     [15,  23,  42] as [number,number,number],
      s7:     [51,  65,  85] as [number,number,number],
      s5:     [100,116, 139] as [number,number,number],
      s2:     [226,232, 240] as [number,number,number],
      s1:     [248,250, 252] as [number,number,number],
      white:  [255,255, 255] as [number,number,number],
      orange: [249,115,  22] as [number,number,number],
      blue:   [59, 130, 246] as [number,number,number],
    };
    const F = (c:[number,number,number]) => pdf.setFillColor(c[0],c[1],c[2]);
    const T = (c:[number,number,number]) => pdf.setTextColor(c[0],c[1],c[2]);
    const D = (c:[number,number,number]) => pdf.setDrawColor(c[0],c[1],c[2]);

    const scoreCol = (s: number, excl=false): [number,number,number] =>
      excl ? C.s5 : s >= 7.5 ? C.green : s >= 5 ? C.amber : C.red;

    // ─── Helpers ──────────────────────────────────────────────────────────────
    const gap  = (n=4) => { y += n; };
    const need = (n: number) => { if (y + n > ph - 14) { pdf.addPage(); pageHeader(); } };
    const hline = (lw=0.25, col=C.s2) => {
      D(col); pdf.setLineWidth(lw); pdf.line(ml, y, pw-mr, y);
    };
    const sectionHead = (txt: string) => {
      pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.s5);
      pdf.text(txt.toUpperCase(), ml, y); y += 4.5;
    };
    // Card background — fills from current y, height h, optional accent bar
    const cardBg = (h: number, col=C.s1, accentCol?: [number,number,number]) => {
      F(col); pdf.rect(ml, y, cw, h, 'F');
      if (accentCol) { F(accentCol); pdf.rect(ml, y, 2, h, 'F'); }
    };

    // ─── Page header ─────────────────────────────────────────────────────────
    const pageHeader = () => {
      F(C.navy); pdf.rect(0, 0, pw, 11, 'F');
      pdf.setFontSize(13); pdf.setFont('helvetica','bold');
      T(C.white); pdf.text('STRATA', ml, 7.5);
      T(C.teal);  pdf.text('GEO', ml + pdf.getTextWidth('STRATA') + 1, 7.5);
      pdf.setFontSize(7); pdf.setFont('helvetica','normal');
      T([180,200,230] as [number,number,number]);
      const rtag = 'Site Suitability Report   stratageo.in';
      pdf.text(rtag, pw - mr - pdf.getTextWidth(rtag), 7.5);
      y = 17;
    };

    // ─── Page footers (called once at the very end) ───────────────────────────
    const allFooters = () => {
      const n = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= n; i++) {
        pdf.setPage(i);
        D(C.s2); pdf.setLineWidth(0.3);
        pdf.line(ml, ph-10, pw-mr, ph-10);
        pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text('Screening-level assessment  Field validation recommended  Stratageo', ml, ph-6);
        const pg = `${i} / ${n}`;
        pdf.text(pg, pw - mr - pdf.getTextWidth(pg), ph-6);
      }
    };

    // ─── Horizontal score bar ─────────────────────────────────────────────────
    const bar = (score: number, bx: number, bw: number, by: number, bh: number, col: [number,number,number]) => {
      F(C.s2); pdf.rect(bx, by, bw, bh, 'F');
      F(col);  pdf.rect(bx, by, Math.max(0.8, (score/10)*bw), bh, 'F');
    };

    // ══════════════════════════════════════════════════════════════════════════
    // PAGE 1 — SUMMARY
    // ══════════════════════════════════════════════════════════════════════════
    pageHeader();

    // ── Title block ────────────────────────────────────────────────────────────
    const ranked = [...locations].sort((a,b) =>
      a.excluded !== b.excluded ? (a.excluded ? 1 : -1) : b.mcda_score - a.mcda_score);
    const topLoc = ranked[0];

    cardBg(22, C.s1, C.navy);
    pdf.setFontSize(16); pdf.setFont('helvetica','bold'); T(C.s9);
    // truncate long names to prevent overflow
    const bizTitle = result.business_type.length > 38
      ? result.business_type.slice(0,36)+'...' : result.business_type;
    pdf.text(bizTitle, ml + 5, y + 9);
    pdf.setFontSize(10); pdf.setFont('helvetica','normal'); T(C.navy);
    pdf.text(result.target_location, ml + 5, y + 16);
    // Score badge top-right
    if (topLoc) {
      const sc = topLoc.mcda_score;
      const col = scoreCol(sc, topLoc.excluded);
      F(col); pdf.roundedRect(pw-mr-22, y+4, 20, 12, 2, 2, 'F');
      pdf.setFontSize(17); pdf.setFont('helvetica','bold'); T(C.white);
      const sLbl = sc.toFixed(1);
      pdf.text(sLbl, pw-mr-12 - pdf.getTextWidth(sLbl)/2, y+13);
      pdf.setFontSize(6.5); pdf.setFont('helvetica','normal');
      pdf.text('/ 10', pw-mr-12 - pdf.getTextWidth('/ 10')/2, y+17.5);
    }
    y += 26;

    // ── Meta ──
    pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s5);
    const metaDate = new Date().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
    const metaRadius = locations[0] ? `${(locations[0].searchRadiusM/1000).toFixed(1)}km radius` : '';
    const metaConf   = spec ? `Confidence: ${spec.confidence}` : '';
    const metaConstr = spec && spec.constraints.length > 0 ? `${spec.constraints.length} constraint(s)` : '';
    pdf.text([metaDate, metaRadius, metaConf, metaConstr].filter(Boolean).join('   |   '), ml, y);
    y += 5;
    // v1.1.0 — version + model/cost metadata disclosure line
    const appVer = `App v${__APP_VERSION__}  Engine v${__APP_VERSION__}`;
    const recMode = (result as any).recommendationMode ? `Mode: ${humanize((result as any).recommendationMode)}` : '';
    const siteClm = `Claim level: ${humanize((result as any).siteClaimLevel || 'micro_market_zone')}`;
    pdf.setFontSize(6.5); T(C.s5);
    pdf.text([appVer, recMode, siteClm, 'Preliminary screening — not legal/parcel/field due diligence'].filter(Boolean).join('   |   '), ml, y);
    y += 5;

    // ── vNext (v1.8.0): screening verdict strip — top-zone verdict,
    // headline confidence, spatial scale, and the single most important
    // unresolved check (all computed values, mirroring the live UI). ──
    const execPdf = buildExecutiveSummary(result, ranked);
    {
      const bits = [
        execPdf.topZoneVerdict ? `Top zone verdict: ${execPdf.topZoneVerdict}` : '',
        execPdf.confidenceLevel ? `Screening confidence: ${execPdf.confidenceLevel}` : '',
        execPdf.spatialScale ? `Scale: ${humanize(execPdf.spatialScale)}` : '',
        execPdf.eligibleCells !== null ? `${execPdf.eligibleCells} eligible cells screened` : '',
      ].filter(Boolean);
      if (bits.length > 0) {
        pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.navy);
        pdf.text(bits.join('   |   '), ml, y);
        y += 4.5;
      }
      if (execPdf.criticalNextCheck) {
        pdf.setFontSize(7); pdf.setFont('helvetica','normal'); T(C.amber);
        const cLines = pdf.splitTextToSize(`Critical next check: ${asciiSafe(execPdf.criticalNextCheck)}`, cw);
        pdf.text(cLines.slice(0, 2), ml, y);
        y += cLines.slice(0, 2).length * 3.8 + 1;
      }
    }

    // ── Constraint tags (ASCII safe) ──
    if (spec && spec.constraints.length > 0) {
      let cx = ml;
      spec.constraints.forEach(c => {
        const away = c.direction === 'away';
        const lbl = `${away ? 'EXCL:' : 'INCL:'} ${c.label}`;
        const tw = pdf.getTextWidth(lbl) + 6;
        if (cx + tw > pw - mr - 5) { y += 6; cx = ml; }
        F(away ? [254,226,226] as [number,number,number] : [220,252,231] as [number,number,number]);
        pdf.roundedRect(cx, y, tw, 5, 1, 1, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica','bold');
        T(away ? C.red : C.green);
        pdf.text(lbl, cx + 3, y + 3.5);
        cx += tw + 3;
      });
      y += 8;
    }

    gap(2); hline(); gap(4);

    // ── Executive summary ──
    sectionHead('Executive Summary');
    // Use cw-10 to account for card indent and right margin — prevents cutoff
    const sumLines = pdf.splitTextToSize(asciiSafe(result.summary), cw - 10);
    const maxSumLines = Math.min(sumLines.length, 8);
    const sumH = maxSumLines * 4.5 + 6;
    cardBg(sumH, C.s1, C.navy);
    pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
    pdf.text(sumLines.slice(0, maxSumLines), ml + 5, y + 5);
    y += sumH + 5;

    // ── Key analysis notes (v1.6.8) — the audit log's most decision-relevant
    // lines (study-area extent, radius overrides, candidate shortfalls,
    // scoring-basis disclosures) belong on page 1, not buried in an appendix.
    const allNotes: string[] = ((spec as any)?.parsingNotes ?? []).filter((n: any) => typeof n === 'string');
    if (allNotes.length > 0) {
      const keyNotes = allNotes.slice(0, 4).map(n => {
        const lines = pdf.splitTextToSize(`- ${asciiSafe(n)}`, cw - 10);
        return lines.slice(0, 2); // max 2 lines per note
      });
      const noteLineCount = keyNotes.reduce((s, l) => s + l.length, 0);
      const notesH = noteLineCount * 4 + 8;
      need(notesH + 8);
      sectionHead(`Key Analysis Notes${allNotes.length > 4 ? ` (first 4 of ${allNotes.length} - full trail in the portal)` : ''}`);
      cardBg(notesH, C.s1, C.s5);
      pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
      let ny = y + 5;
      keyNotes.forEach(lines => { pdf.text(lines, ml + 5, ny); ny += lines.length * 4; });
      y += notesH + 5;
    }

    // ── Ranked locations table ──
    sectionHead('Ranked Locations Overview');
    // Header row
    F(C.navy); pdf.rect(ml, y, cw, 7, 'F');
    pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
    pdf.text('LOCATION', ml + 8, y + 4.8);
    pdf.text('SCORE', ml + 68, y + 4.8);
    pdf.text('SUITABILITY INDEX', ml + 85, y + 4.8);
    pdf.text('STATUS', pw - mr - 14, y + 4.8);
    y += 7;

    ranked.forEach((loc, idx) => {
      need(11);
      const rh = 10;
      F(idx % 2 === 0 ? C.white : C.s1);
      pdf.rect(ml, y, cw, rh, 'F');

      // Rank accent bar
      const rc = scoreCol(loc.mcda_score, loc.excluded);
      F(rc); pdf.rect(ml, y, 5, rh, 'F');
      pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
      const rankStr = `${idx+1}`;
      pdf.text(rankStr, ml + 2.5 - pdf.getTextWidth(rankStr)/2, y + 6.5);

      // Name + coords
      pdf.setFontSize(8.5); pdf.setFont('helvetica', loc.excluded ? 'italic' : 'bold');
      T(loc.excluded ? C.s5 : C.s9);
      pdf.text(loc.name + (loc.excluded ? ' [excl]' : ''), ml + 7, y + 4.5);
      pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
      pdf.text(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`, ml + 7, y + 8.2);

      // Score
      pdf.setFontSize(10); pdf.setFont('helvetica','bold'); T(rc);
      pdf.text(loc.mcda_score.toFixed(1), ml + 68, y + 5.5);
      pdf.setFontSize(7); pdf.setFont('helvetica','normal'); T(C.s5);
      pdf.text('/10', ml + 68 + pdf.getTextWidth(loc.mcda_score.toFixed(1)) + 0.5, y + 5.5);

      // Suitability bar  (starts at 85mm, ends 20mm before right margin)
      const bx = ml + 85; const bw = cw - 85 - 20;
      bar(loc.mcda_score, bx, bw, y + 3.5, 3, rc);

      // Status badge — vNext (v1.8.0): the honesty-gated screening verdict
      // when present; score-band words only for older payloads.
      const status = loc.excluded ? 'EXCLUDED'
        : ((loc as any).screeningVerdict
            ? String((loc as any).screeningVerdict).toUpperCase().substring(0, 12)
            : loc.mcda_score >= 7.5 ? 'STRONG'
            : loc.mcda_score >= 5   ? 'VIABLE' : 'WEAK');
      const stW = Math.max(15, pdf.getTextWidth(status) + 4);
      F(rc); pdf.roundedRect(pw-mr-2-stW, y+2.5, stW, 5, 1, 1, 'F');
      pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.white);
      pdf.text(status, pw-mr-2-stW/2 - pdf.getTextWidth(status)/2, y+5.8);

      D(C.s2); pdf.setLineWidth(0.2); pdf.line(ml, y+rh, pw-mr, y+rh);
      y += rh;
    });
    gap(5);

    // ── Criteria overview table (before the map: keeps page 1 dense and the
    // near-full-page map figure on its own page — kills the dead-space pages
    // observed in the live Pune report) ──
    if (ranked[0]?.criteria_breakdown.length > 0) {
      need(6 + ranked[0].criteria_breakdown.length * 6.5 + 10);
      hline(); gap(4);
      sectionHead('Scoring Criteria Applied');

      F(C.s1); pdf.rect(ml, y, cw, 6.5, 'F');
      pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.s5);
      pdf.text('CRITERION', ml + 22, y + 4.5);
      pdf.text('DIRECTION', ml + 100, y + 4.5);
      pdf.text('WEIGHT', ml + 148, y + 4.5);
      y += 6.5;

      ranked[0].criteria_breakdown.forEach((cr, idx) => {
        const rh = 6.5;
        F(idx % 2 === 0 ? C.white : C.s1); pdf.rect(ml, y, cw, rh, 'F');
        // Direction pill
        const dcol = cr.direction === 'negative' ? C.orange : C.teal;
        F(dcol); pdf.roundedRect(ml + 2, y + 1, 14, 4.5, 1, 1, 'F');
        pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
        pdf.text(dirTag(cr.direction), ml + 9 - pdf.getTextWidth(dirTag(cr.direction))/2, y + 4.2);
        // Name
        pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
        pdf.text(cr.name.substring(0, 42), ml + 18, y + 4.5);
        // Type text — vNext (v1.8.0): a target-band factor is not monotonic
        pdf.setFontSize(6.5); T(dcol);
        pdf.text((cr as any).scoringCurve === 'target_band'
          ? 'Target band (moderate best)'
          : cr.direction === 'negative' ? 'Less is better' : 'More is better', ml + 100, y + 4.5);
        // Weight
        T(C.s5);
        pdf.text(`${Math.round(cr.weight * 100)}%`, ml + 148, y + 4.5);
        y += rh;
      });
      gap(5);
    }

    // ── v1.6.8: Study area map — the core visual deliverable ──
    // Self-rendered figure over real Carto basemap tiles (same CORS-enabled
    // source as the on-screen map, attributed in the figure itself), with
    // north arrow, in-frame scale bar, and labeled legend. Falls back to the
    // clean tile-less rendering if the basemap can't be fetched at export
    // time — the report itself can never break on a tile.
    try {
      const fig = await renderMapFigure({
        hexGrid: (result as any).hexGrid ?? [],
        locations: ranked,
        studyAreaBoundary: (result as any).studyAreaBoundary,
        withheld: (result as any).recommendationWithheld === true,
        weightsAdjusted: false,
      });
      if (fig) {
        const imgW = cw;
        const imgH = imgW / fig.aspect;
        need(imgH + 16);
        hline(); gap(4);
        sectionHead('Study Area Map — Suitability Surface & Ranked Zones');
        pdf.addImage(fig.dataUrl, 'PNG', ml, y, imgW, imgH);
        y += imgH + 3;
        pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text('Zones are H3 micro-market cells (screening level), not parcels. Exact coordinates for each ranked zone are listed in the detail pages.', ml, y);
        y += 5;
        gap(3);
      }
    } catch { /* the map figure must never break the report */ }

    // ══════════════════════════════════════════════════════════════════════════
    // LOCATION DETAIL PAGES — one per ranked location, flowing (no forced page)
    // ══════════════════════════════════════════════════════════════════════════
    for (let li = 0; li < ranked.length; li++) {
      const loc = ranked[li];
      // Always start each location on a fresh page for cleanliness
      pdf.addPage(); pageHeader();

      const ac = scoreCol(loc.mcda_score, loc.excluded);

      // ── Location title card ─────────────────────────────────────────────────
      cardBg(22, C.s1, ac);
      // Rank square
      F(ac); pdf.rect(ml + 3, y + 3, 9, 9, 'F');
      pdf.setFontSize(10); pdf.setFont('helvetica','bold'); T(C.white);
      pdf.text(`${li+1}`, ml + 7.5 - pdf.getTextWidth(`${li+1}`)/2, y + 9.8);
      // Name
      pdf.setFontSize(15); pdf.setFont('helvetica','bold');
      T(loc.excluded ? C.s5 : C.s9);
      const locName = (loc.name + (loc.excluded ? '  [EXCLUDED]' : '')).substring(0, 35);
      pdf.text(locName, ml + 15, y + 9);
      // Coords
      pdf.setFontSize(7); pdf.setFont('helvetica','normal'); T(C.s5);
      pdf.text(`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}   |   Search radius: ${(loc.searchRadiusM/1000).toFixed(1)} km`, ml + 15, y + 15.5);
      // v1.6.7 — one-tap navigation for the field-validation visit
      pdf.setTextColor(29, 78, 216);
      pdf.textWithLink('Open in Google Maps', ml + 15 + 62, y + 15.5, { url: `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` });
      // Score pill
      F(ac); pdf.roundedRect(pw-mr-24, y+4, 22, 14, 2, 2, 'F');
      pdf.setFontSize(18); pdf.setFont('helvetica','bold'); T(C.white);
      const sStr = loc.mcda_score.toFixed(1);
      pdf.text(sStr, pw-mr-13 - pdf.getTextWidth(sStr)/2, y+14);
      pdf.setFontSize(7); T([255,255,255] as [number,number,number]);
      pdf.text('/ 10', pw-mr-13 - pdf.getTextWidth('/ 10')/2, y+18.5);
      y += 26;

      // ── Exclusion notice ──
      const failedExcl = loc.exclusions.filter(e => !e.passed);
      if (failedExcl.length > 0) {
        const exH = failedExcl.length * 8 + 4;
        F([254,226,226] as [number,number,number]); pdf.rect(ml, y, cw, exH, 'F');
        F(C.red); pdf.rect(ml, y, 2, exH, 'F');
        failedExcl.forEach((ex, ei) => {
          pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.red);
          const exLines = pdf.splitTextToSize(`Exclusion: ${ex.rule}`, cw - 8);
          pdf.text(exLines.slice(0,2), ml + 5, y + 5.5 + ei * 8);
        });
        y += exH + 4;
      }

      // ── GIS Analyst Assessment ──
      // v1.6.8 — SKIPPED when there is no assessment text: the live Pune
      // report printed an empty orange-bar section, which reads as a bug
      // in a client deliverable. Absent narrative = absent section.
      if ((loc.reasoning || '').trim()) {
        sectionHead('GIS Analyst Assessment');
        // split to cw-10 to avoid right-edge cutoff
        const rLines = pdf.splitTextToSize(asciiSafe(loc.reasoning), cw - 10);
        const rCount = Math.min(rLines.length, 10);
        const rH = rCount * 4.5 + 6;
        cardBg(rH, C.s1, ac);
        pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
        pdf.text(rLines.slice(0, rCount), ml + 5, y + 5);
        y += rH + 5;
      }

      // ── Criteria breakdown ──
      sectionHead('Scoring Criteria Breakdown');

      // Column X positions (all relative to left edge, absolute mm)
      // cw = 182mm. Columns:
      //  direction tag  : ml+2        (5mm wide)
      //  criterion name : ml+9        (55mm wide, ends at ml+64)
      //  justification  : ml+9 (row2)
      //  score bar      : ml+66       (38mm wide, ends at ml+104)
      //  score text     : ml+106      (14mm wide, ends at ml+120)
      //  raw evidence   : ml+122      (38mm wide, ends at ml+160)
      //  weight         : ml+162      (to right edge ml+182)
      const cDirX  = ml + 2;
      const cNameX = ml + 9;
      const cBarX  = ml + 66;
      const cBarW  = 38;
      const cScoreX= ml + 106;
      const cRawX  = ml + 122;
      const cWtX   = ml + 162;

      // Table header
      F(C.s9); pdf.rect(ml, y, cw, 7, 'F');
      pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.white);
      pdf.text('DIR', cDirX, y + 4.8);
      pdf.text('CRITERION & EVIDENCE', cNameX, y + 4.8);
      pdf.text('SCORE INDEX', cBarX, y + 4.8);
      pdf.text('SCORE', cScoreX, y + 4.8);
      pdf.text('RAW OBSERVED', cRawX, y + 4.8);
      pdf.text('WEIGHT', cWtX, y + 4.8);
      y += 7;

      loc.criteria_breakdown.forEach((cr, idx) => {
        need(11);
        const rh = 11;
        F(idx % 2 === 0 ? C.white : C.s1); pdf.rect(ml, y, cw, rh, 'F');

        // Direction pill — ASCII only, no Unicode
        const dcol = cr.direction === 'negative' ? C.orange : C.teal;
        F(dcol); pdf.roundedRect(cDirX, y + 1.5, 5, 4, 0.5, 0.5, 'F');
        pdf.setFontSize(5.5); pdf.setFont('helvetica','bold'); T(C.white);
        const dtag = cr.direction === 'negative' ? '-' : '+';
        pdf.text(dtag, cDirX + 2.5 - pdf.getTextWidth(dtag)/2, y + 4.8);

        // Criterion name (line 1)
        pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(C.s9);
        pdf.text(cr.name.substring(0, 36), cNameX, y + 4.5);
        // Justification (line 2) — split to available width
        pdf.setFontSize(6); pdf.setFont('helvetica','italic'); T(C.s5);
        const jLines = pdf.splitTextToSize(cr.justification || '', cBarX - cNameX - 2);
        pdf.text(jLines.slice(0,1), cNameX, y + 8.5);

        // Score bar (null score = insufficient data → no bar, "N/A")
        if (cr.score == null) {
          pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(C.red);
          pdf.text('N/A', cScoreX, y + 5.5);
          pdf.setFontSize(6); pdf.setFont('helvetica','normal'); T(C.s5);
          pdf.text('no data', cScoreX, y + 9);
        } else {
          const s = cr.score;
          const crCol = cr.direction === 'negative'
            ? (s <= 3 ? C.red : s <= 6 ? C.orange : C.green)
            : (s >= 7 ? C.green : s >= 4 ? C.blue : C.red);
          bar(s, cBarX, cBarW, y + 4, 3, crCol);

          // Score number — in its own column, no overlap with bar or evidence
          pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(crCol);
          pdf.text(`${s.toFixed(1)}`, cScoreX, y + 5.5);
          pdf.setFontSize(6.5); T(C.s5);
          pdf.text('/10', cScoreX, y + 9);
        }

        // Raw evidence — starts well after score column
        pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(C.s9);
        pdf.text(`${cr.rawValue ?? 0}`, cRawX, y + 5.5);
        pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text('features observed', cRawX, y + 9);

        // Weight badge
        F(C.s2); pdf.roundedRect(cWtX, y + 2, 14, 5.5, 1, 1, 'F');
        pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.s7);
        const wl = `${Math.round(cr.weight * 100)}%`;
        pdf.text(wl, cWtX + 7 - pdf.getTextWidth(wl)/2, y + 6);

        D(C.s2); pdf.setLineWidth(0.2); pdf.line(ml, y+rh, pw-mr, y+rh);
        y += rh;
      });
      gap(4);

      // ── Signal counts summary bar ──
      const sigs = Object.entries(loc.osmSignals || {}).slice(0,5);
      if (sigs.length > 0) {
        need(18);
        sectionHead('Spatial Evidence — Raw OSM Signal Counts');
        const scW = Math.min(cw / sigs.length, 44);
        sigs.forEach(([key, val], si) => {
          const sx = ml + si * scW;
          F(C.s1); pdf.rect(sx, y, scW - 1, 14, 'F');
          F(C.navy); pdf.rect(sx, y, 2, 14, 'F');
          pdf.setFontSize(14); pdf.setFont('helvetica','bold'); T(C.navy);
          pdf.text(String(val), sx + 5, y + 9);
          pdf.setFontSize(6); pdf.setFont('helvetica','normal'); T(C.s5);
          // Wrap label if too long
          const kl = pdf.splitTextToSize(key.replace(/_/g,' '), scW - 4);
          pdf.text(kl.slice(0,2), sx + 5, y + 12);
        });
        y += 16;
      }

      // ── vNext (v1.8.0): zone-specific next-stage validation ──
      // Generated by the engine from the ACTUAL unmet / screening-stage
      // requirements of this run — never generic boilerplate.
      const nextActs = ((loc as any).nextValidation as string[] | undefined) ?? [];
      if (nextActs.length > 0) {
        const actLines = nextActs.slice(0, 6).map(a => pdf.splitTextToSize(`- ${asciiSafe(a)}`, cw - 10).slice(0, 2));
        const actCount = actLines.reduce((s, l) => s + l.length, 0);
        const actH = actCount * 4 + 9;
        need(actH + 8);
        gap(2);
        sectionHead('Next-Stage Validation for This Zone');
        cardBg(actH, [240, 249, 255] as [number, number, number], C.blue);
        pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
        let ay = y + 5;
        actLines.forEach(lines => { pdf.text(lines, ml + 5, ay); ay += lines.length * 4; });
        y += actH + 4;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BENCHMARK + METHODOLOGY PAGE
    // ══════════════════════════════════════════════════════════════════════════
    pdf.addPage(); pageHeader();

    // v2.1.0 — the invented "industry benchmark" comparison was removed.
    // ── Methodology ──
    sectionHead('Methodology & Data Sources');
    const meths = [
      // v1.6.8 — rewritten to describe the ACTUAL v2 engine (the previous
      // text described the retired single-shot pipeline and named a stale
      // model, "GPT-4o-mini", in a client deliverable).
      { title: '1. Intent & Deterministic Planning',
        body: 'The brief is interpreted conversationally by a server-configured language model, then a deterministic planner locks the analysis structure: a reviewed business playbook (archetype) fixes the scoring factors, weights, and catchments, so an identical brief always produces an identical plan. The model writes explanations only - it cannot alter factors or weights.' },
      { title: '2. Spatial Data Collection',
        body: 'The study area is geocoded (Google primary, OpenStreetMap Nominatim fallback; coordinates supplied in the brief are used verbatim) and tiled with an H3 hexagonal grid. OpenStreetMap Overpass and Google Places count relevant features (transit, commercial, competitors, etc.) per factor catchment; water and no-build land (railway/ghat/heritage) are masked out as hard exclusions.' },
      { title: '3. Two-Pass MCDA Scoring',
        body: 'Every grid cell is scored with fast screening proxies and a weighted composite ranks the field; the top zones are then re-verified with real travel-time isochrones, routing, and verified place counts, and FINAL ranking uses those refined scores. Positive factors reward higher counts; negative factors penalize them; factors with no data are excluded from the mean, never scored as zero.' },
      { title: '4. Exclusions & Confidence',
        body: 'Named-area and engine-level exclusions are applied as hard filters. Confidence combines data sufficiency, provider health, and a deterministic reliability critique; the overall verdict always takes the most conservative of the signals and is disclosed alongside every recommendation.' },
      { title: 'Important Limitations',
        body: 'This is a screening-level assessment only. OSM coverage varies by region. Scores reflect relative suitability from available spatial data — not investment recommendations. Site-level due diligence and field validation are required before any real estate decision.',
        warn: true },
      { title: '5. Version & Analysis Metadata',
        body: `App v${__APP_VERSION__}  |  Engine v${__APP_VERSION__}  |  Spec v2.3  |  Analysis type: ${(result as any).uploadedCandidatesOnly ? 'Uploaded-candidates-only (candidate universe restricted to uploaded points)' : 'candidate zone screening (not parcel-level siting)'}  |  Recommendation mode: ${humanize((result as any).recommendationMode || 'recommended_sites')}  |  Site claim level: ${humanize((result as any).siteClaimLevel || 'micro_market_zone')}`,
        warn: false },
      // ── v1.6.0 (Phase 3) — headline confidence + weight audit ─────────────
      ...((result as any).unifiedConfidence ? [{
        title: `Overall Confidence: ${(result as any).unifiedConfidence.level}`,
        body: (result as any).unifiedConfidence.reason,
        warn: (result as any).unifiedConfidence.level !== 'High',
      }] : []),
      // ── vNext (v1.8.0): constraint-status table — every requested hard
      // constraint and how (whether) it was verified, in the same
      // vocabulary the live UI uses. ──
      ...(() => {
        const hcvP = (result as any).hardConstraintVerification;
        if (!hcvP || !Array.isArray(hcvP.constraints) || hcvP.constraints.length === 0) return [];
        const stTxt: Record<string, string> = {
          verified: 'VERIFIED', proxy_verified: 'PROXY VERIFIED',
          not_verifiable: 'NOT VERIFIABLE FROM DATA',
          requested_not_enforced: 'REQUESTED - NOT ENFORCED',
          failed: 'FAILED', not_required: 'not required',
        };
        const rows = hcvP.constraints.map((c: any) =>
          `${c.label}: ${stTxt[c.status] || c.status}${c.reason ? ` - ${c.reason}` : ''}`);
        return [{
          title: `Constraint Verification Status (${hcvP.verifiedCount ?? 0} verified / ${hcvP.unknownCount ?? 0} not verifiable / ${hcvP.failedCount ?? 0} failed)`,
          body: rows.join('\n'),
          warn: (hcvP.unknownCount ?? 0) > 0 || (hcvP.failedCount ?? 0) > 0 || (hcvP.unenforcedCount ?? 0) > 0,
        }];
      })(),
      ...(() => {
        const wa = (result as any).weightAudit;
        const adjusted = wa?.adjustedByUser === true;
        const executed = Object.fromEntries(
          (locations[0]?.criteria_breakdown ?? []).map(c => [c.name, c.weight]),
        );
        const defaults: Record<string, number> =
          wa?.defaultWeights || {};
        const rows = Object.keys({ ...defaults, ...executed }).map(n => {
          const d = defaults[n] !== undefined ? `${Math.round(defaults[n] * 100)}%` : 'n/a';
          const e = executed[n] !== undefined ? `${Math.round((executed[n] as number) * 100)}%` : 'n/a';
          return `${n}: default ${d} -> applied ${e}`;
        });
        return [{
          title: adjusted ? 'Factor Weight Audit — ADJUSTED BY USER' : 'Factor Weight Audit — defaults applied',
          body: (adjusted
            ? 'The ranking in this report uses factor weights adjusted by the user; the playbook defaults are shown alongside for full transparency. '
            : 'The ranking in this report uses the analysis playbook default weights, unmodified. ')
            + rows.join('  |  '),
          warn: adjusted,
        }];
      })(),
      // v1.6.8 — only include planning metadata that actually resolved.
      // The live Pune report printed "Planning mode: not set | Archetype:
      // unknown | ... | Planning ID: n/a" — raw fallback placeholders in a
      // client deliverable. Absent fields are now omitted; if none resolve,
      // the whole card is dropped (the guarantee sentence alone is not
      // worth a card of unknowns).
      ...(() => {
        const dpParts = [
          (result as any).planningMode ? `Planning mode: ${humanize((result as any).planningMode)}` : '',
          (result as any).archetypeKey ? `Playbook: ${humanize((result as any).archetypeKey)}` : '',
          (result as any).weightsSource ? `Weights source: ${humanize((result as any).weightsSource)}` : '',
          (result as any).llmRole ? `LLM role: ${humanize((result as any).llmRole)}` : '',
          (result as any).planningFingerprint ? `Planning ID: ${(result as any).planningFingerprint}` : '',
        ].filter(Boolean);
        if (dpParts.length === 0) return [];
        return [{
          title: '6. Deterministic Planning',
          body: dpParts.join('  |  ')
            + '  |  Factor keys and weights are locked by the reviewed playbook registry and cannot be changed by the language model between runs.',
          warn: false,
        }];
      })(),
      // ── Evidence Appendix (v1.3.0) ──────────────────────────────────────────
      ...(() => {
        const et = (result as any).evidenceTrail;
        if (!et) return [];
        const providerSummary = (et.providerQueries || [])
          .map((q: any) => `${q.provider} (${q.queryPurpose}): ${q.featureCount} features`)
          .join(' | ') || 'No provider queries recorded';
        const factorSummary = (et.factors || [])
          .map((f: any) => `${f.displayName} w:${Math.round(f.weight * (f.weight > 1 ? 1 : 100))}% ${f.direction === 'positive' ? '▲' : '▼'} ${f.catchment}`)
          .join(' | ') || 'No factor evidence';
        const exclusionSummary = (et.exclusions || [])
          .filter((e: any) => e.targetType === 'h3_cell')
          .map((e: any) => e.reason)
          .join(' | ') || 'No cell exclusions recorded';
        const candExcl = (et.exclusions || []).filter((e: any) => e.targetType === 'candidate').length;
        return [{
          title: '7. Evidence Appendix (v1.3.0) — AUDIT REPRODUCIBLE',
          body: [
            `Evidence version: ${et.evidenceVersion}  |  Snapshot: ${et.dataSnapshot?.snapshotId || 'n/a'}  |  Provider mode: ${et.dataSnapshot?.providerMode || 'live'}  |  Study area geometry hash: ${et.studyArea?.geometryHash || 'n/a'}  |  H3 resolution: ${et.studyArea?.h3Resolution || 8}`,
            `H3 cells before masks: ${et.studyArea?.h3CellCountBeforeMasks || '?'}  |  Candidate exclusions: ${candExcl}  |  Valid recommendations: ${et.recommendationSummary?.validRecommendationCount ?? '?'}  |  Excluded candidates: ${et.recommendationSummary?.excludedCandidateCount ?? '?'}`,
            `PROVIDER QUERIES: ${providerSummary}`,
            `FACTOR SCHEMA: ${factorSummary}`,
            `CELL EXCLUSIONS: ${exclusionSummary}`,
            `SCORING FORMULA: ${et.scoring?.formulaDescription || 'n/a'}`,
            `LIMITATIONS: ${(et.limitations || []).slice(0, 2).join(' | ')}`,
            'This evidence trail is AUDIT REPRODUCIBLE — scoring methodology is fully documented. Full data replay requires cached provider snapshots (not yet implemented).',
          ].join('\n'),
          warn: false,
        }];
      })(),
      ...((result as any).uploadedCandidatesOnly ? [{
        title: '7. Uploaded Candidate Points',
        body: `Candidate universe: RESTRICTED to uploaded points only. Total uploaded: ${(result as any).uploadedCandidateCount || 0}. Ranked: ${(result as any).rankedUploadedCandidateCount || 0}. Excluded (invalid): ${(result as any).excludedUploadedCandidateCount || 0}. No H3 hex-grid search was performed — only user-supplied point locations were scored.`,
        warn: false,
      }] : []),
    ];
    meths.forEach((m, mi) => {
      const mLines = pdf.splitTextToSize(asciiSafe(m.body), cw - 10);
      const mH = mLines.length * 4 + 10;
      need(mH + 2);
      const bgCol: [number,number,number] = m.warn ? [255,251,235] : C.s1;
      const accCol: [number,number,number] = m.warn ? C.amber : C.navy;
      cardBg(mH, bgCol, accCol);
      pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(accCol);
      pdf.text(m.title, ml + 5, y + 6);
      pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
      pdf.text(mLines, ml + 5, y + 11);
      y += mH + 3;
    });

    // ── vNext (v1.8.0): professional next-step CTA — screening leads to
    // detailed paid validation (§6.7/§7). No fake checkout; just the
    // contact route and what the next stage covers. ──
    {
      const ctaBody =
        'This report is a spatial SCREENING: it identifies and ranks investigation '
        + 'zones with the evidence behind each. The next stage - a detailed site study - '
        + 'validates actual properties in these zones: current rent and availability, '
        + 'frontage and loading, footfall observation, zoning confirmation, and '
        + 'parcel-level access analysis. Contact Stratageo to commission a detailed '
        + 'site validation for this shortlist: stratageo.in/contact.php'
        + ((result as any).jobRef ? `  (reference: ${(result as any).jobRef})` : '');
      const cLines = pdf.splitTextToSize(asciiSafe(ctaBody), cw - 10);
      const cH = cLines.length * 4 + 12;
      need(cH + 4);
      cardBg(cH, [240, 253, 244] as [number, number, number], C.green);
      pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(C.green);
      pdf.text('NEXT STAGE: REQUEST DETAILED SITE VALIDATION', ml + 5, y + 6.5);
      pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
      pdf.text(cLines, ml + 5, y + 12);
      pdf.setTextColor(29, 78, 216);
      pdf.textWithLink('stratageo.in/contact.php', pw - mr - 5 - pdf.getTextWidth('stratageo.in/contact.php'), y + 6.5, { url: config.contactUrl });
      y += cH + 3;
    }

    allFooters();

    pdf.save(`Stratageo-SiteSuitability-${result.business_type.replace(/\s+/g,'-')}-${result.target_location.replace(/\s+/g,'-')}-${new Date().toISOString().slice(0,10)}.pdf`);
  } catch (e: any) { throw new Error(`PDF export failed: ${e?.message || 'unknown error'}`); }
}
