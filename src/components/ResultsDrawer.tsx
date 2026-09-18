import React, { useMemo, useRef, useState } from 'react';
import type { LocationData, AnalysisResult, AnalysisSpec, HeatmapType, MCDACriteria } from '../types';
import { buildExecutiveSummary, topFactorSignals } from '../services/screeningPresentation';
import { resolveSheetGesture, type SheetState } from '../services/sheetState';

/**
 * v2.1.0 — the results panel, cut to what a customer decides with:
 *
 *   1. the answer        — top zone, its score, what the number is the best of
 *   2. the map controls  — colour the surface by overall score or one factor
 *   3. the zones         — Priority 1…N, each with its factors, the reason each
 *                          factor is there, what was observed, and the next check
 *   4. the notices       — what was not enforced, what degraded (collapsed)
 *
 * Gone (was 2,000 lines): methodology comparison, benchmark, conversion CTA,
 * copy-summary, evidence-trail viewer, LLM critique prose, post-run weight
 * sliders and the second unverified ranking they produced, weight audit,
 * data-sufficiency grid, constraint-verification table, assumptions panel,
 * comparison chart. The engine still computes the honest fields those panels
 * showed; the ones a decision needs are folded into the four blocks above.
 */
interface ResultsDrawerProps {
  open: boolean;
  onClose: () => void;
  result: AnalysisResult;
  spec: AnalysisSpec | null;
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  heatmapType: HeatmapType;
  onHeatmapChange: (type: HeatmapType) => void;
  /** v2.3.0 — on a phone the drawer is a bottom sheet; `sheetState` drives its
   *  height and the header becomes a drag handle. Undefined on desktop. */
  sheetState?: SheetState;
  onSheetChange?: (next: SheetState) => void;
}

const INVESTIGATION_TEXT: Record<string, string> = {
  RECOMMENDED_INVESTIGATION_ZONE: 'Recommended investigation zone',
  PROVISIONAL_CANDIDATE: 'Provisional candidate',
  WEAK_CANDIDATE: 'Weak candidate',
  NO_RELIABLE_RECOMMENDATION: 'Not recommended',
  EXCLUDED: 'Excluded',
};

const VERDICT_STYLE: Record<string, { bg: string; fg: string }> = {
  Priority:    { bg: '#dcfce7', fg: '#166534' },
  Promising:   { bg: '#e0f2fe', fg: '#075985' },
  Conditional: { bg: '#fef3c7', fg: '#92400e' },
};

function zoneLabel(loc: LocationData, withheld: boolean): string {
  if (loc.excluded) return 'Excluded';
  if (withheld) return 'Not recommended';
  const il = loc.investigationLabel;
  if (il && INVESTIGATION_TEXT[il]) return INVESTIGATION_TEXT[il];
  return '';
}

const SOURCE_TEXT: Record<string, string> = {
  'osm-observed': 'OSM + Places', 'google-corroborated': 'Google', 'osm-derived': 'Derived',
  'osm-absent': 'No data', 'insufficient-data': 'Insufficient data', 'constraint-rule': 'Rule',
};

const Criterion: React.FC<{ c: MCDACriteria }> = ({ c }) => {
  const noData = c.score === null || c.score === undefined;
  return (
    <div className="drawer-criterion">
      <div className="criterion-row">
        <span className={`direction-icon ${c.direction === 'positive' ? 'dir-positive' : 'dir-negative'}`}
              title={c.direction === 'positive' ? 'More is better' : 'Less is better'}>
          {c.direction === 'positive' ? '▲' : '▼'}
        </span>
        <span className="criterion-name">{c.name}{c.required && <span title="Required" style={{ color: '#dc2626', marginLeft: 3 }}>*</span>}</span>
        <span className="criterion-weight-label">{Math.round(c.weight * 100)}%</span>
        <span className="criterion-score">{noData ? '—' : (c.score as number).toFixed(1)}</span>
      </div>
      {c.whyItMatters && (
        <div className="criterion-why">
          {c.whyItMatters}
          {c.origin === 'brief' && c.evidence ? <em> — you said “{c.evidence}”</em> : null}
        </div>
      )}
      {noData ? (
        <div className="criterion-insufficient" style={{ fontSize: '11px', color: '#991b1b', padding: '2px 0' }}>
          No usable data here — left out of the score, never scored as zero.
        </div>
      ) : (
        <div className="criterion-bar-track">
          <div className={`criterion-bar-fill ${c.direction === 'negative' ? 'bar-negative' : 'bar-positive'}`} style={{ width: `${(c.score as number) * 10}%` }} />
        </div>
      )}
      <div className="criterion-meta">
        <span className="criterion-raw">{noData ? 'no data' : `${c.rawValue} observed`}</span>
        <span className="criterion-source">{SOURCE_TEXT[c.evidenceBasis] ?? 'Default'}</span>
        {c.comparative && !noData && (
          <span className="criterion-source" title="Refined scores are relative to the re-verified shortlist, not to the whole map">
            {c.comparative.position} of {c.comparative.n} shortlisted
          </span>
        )}
      </div>
    </div>
  );
};

export const ResultsDrawer: React.FC<ResultsDrawerProps> = ({
  open, onClose, result, spec, locations, selectedLocations, onSelectLocation, heatmapType, onHeatmapChange,
  sheetState, onSheetChange,
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showNotices, setShowNotices] = useState(false);

  // v2.3.0 — sheet gesture: a vertical drag on the header steps the sheet up
  // or down; a tap cycles it. Pointer events cover touch and mouse alike.
  const dragStartY = useRef<number | null>(null);
  const isSheet = !!sheetState && !!onSheetChange;
  const onGripDown = (e: React.PointerEvent) => {
    if (!isSheet) return;
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onGripUp = (e: React.PointerEvent) => {
    if (!isSheet || dragStartY.current === null) return;
    const dy = e.clientY - dragStartY.current;
    dragStartY.current = null;
    onSheetChange!(resolveSheetGesture(sheetState!, dy));
  };
  const onGripCancel = () => { dragStartY.current = null; };

  const withheld = result.recommendationWithheld === true || result.status === 'no_viable_site';
  const ranked = useMemo(() => [...locations].sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.mcda_score - a.mcda_score;
  }), [locations]);
  const exec = useMemo(() => buildExecutiveSummary(result, ranked), [result, ranked]);

  const factorNames = useMemo(() => {
    const names = new Set<string>();
    locations.forEach(l => (l.criteria_breakdown ?? []).forEach(c => {
      if (c.score !== null && c.score !== undefined) names.add(c.name);
    }));
    return Array.from(names).slice(0, 8);
  }, [locations]);

  // Everything the customer should know about this run, in one list.
  const notices = useMemo(() => {
    const out: string[] = [];
    const unenforced = (result as any).exclusionsUnenforced;
    if (Array.isArray(unenforced)) unenforced.forEach((u: unknown) => out.push(`Not enforced: ${String(u)}`));
    (result.degradationNotes ?? []).forEach(n => out.push(n));
    (result.providerDiagnostics?.notes ?? []).forEach(n => out.push(n));
    (result.analysisCompleteness?.unsupportedConstraints ?? []).forEach(u => out.push(`${u.displayLabel}: ${u.reason}`));
    if (result.unifiedConfidence?.reason) out.push(`Confidence: ${result.unifiedConfidence.reason}`);
    return Array.from(new Set(out));
  }, [result]);

  const suggestions: string[] = (result.suggestions?.length ? result.suggestions : result.relaxationSuggestions) ?? [];
  const barColor = (t: string) => t === 'good' ? '#059669' : t === 'mixed' ? '#d97706' : '#dc2626';

  return (
    <div className={`drawer ${open ? 'drawer-open' : 'drawer-closed'}${isSheet ? ` drawer-sheet drawer-sheet-${sheetState}` : ''}`}>
      <div
        className="drawer-header"
        onPointerDown={onGripDown}
        onPointerUp={onGripUp}
        onPointerCancel={onGripCancel}
        role={isSheet ? 'button' : undefined}
        aria-label={isSheet ? `Results sheet, ${sheetState}. Tap or drag to resize.` : undefined}
      >
        {isSheet && <div className="drawer-grip" aria-hidden="true" />}
        <div className="drawer-header-text">
          <div className="drawer-title">
            {withheld ? 'Screening result' : 'Priority zones'}
            {isSheet && !withheld && ranked.length > 0 && (
              <span className="drawer-title-count"> · {ranked.filter(l => !l.excluded).length}</span>
            )}
          </div>
          <div className="drawer-subtitle">{result.business_type} — {result.target_location}</div>
        </div>
        <button onClick={onClose} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
                className="drawer-close" aria-label={isSheet ? 'Minimise results' : 'Close'}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
            {isSheet
              ? <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />}
          </svg>
        </button>
      </div>

      <div className="drawer-body">
        {/* 1. The answer */}
        {withheld ? (
          <div className="withheld-notice">
            <div className="withheld-head">No recommendation from this run</div>
            {result.plainReason
              ? <p className="withheld-body">{result.plainReason}</p>
              : result.reason ? <p className="withheld-body">{result.reason}</p> : null}
            {suggestions.length > 0 && (
              <ul className="withheld-list">{suggestions.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}</ul>
            )}
          </div>
        ) : exec.topZoneName && (
          <div className="exec-header">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '16px' }}>{exec.topZoneName}</span>
              {exec.topZoneScore !== null && (
                <span style={{ fontWeight: 700, fontSize: '15px', color: '#0369a1' }}>
                  {exec.topZoneScore.toFixed(1)}<span style={{ fontSize: '11px', color: '#64748b' }}>/10</span>
                </span>
              )}
              {exec.topZoneVerdict && VERDICT_STYLE[exec.topZoneVerdict] && (
                <span style={{ padding: '1px 7px', borderRadius: 9, fontSize: '10.5px', fontWeight: 700,
                  background: VERDICT_STYLE[exec.topZoneVerdict].bg, color: VERDICT_STYLE[exec.topZoneVerdict].fg }}>
                  {exec.topZoneVerdict}
                </span>
              )}
            </div>
            {/* v2.0.0 — say what the number is the best OF: the shortlist that
                was re-verified, not every cell on the map. */}
            <div style={{ fontSize: '11px', color: '#64748b', margin: '1px 0 6px' }} title={result.shortlist?.basis || undefined}>
              {exec.verifiedCells !== null
                ? <>best of {exec.verifiedCells} zones re-verified with travel-time and routing data</>
                : <>best of {exec.eligibleCells ?? 'the'} eligible</>}
              {exec.eligibleCells !== null && exec.screenedCells !== null ? <> · {exec.eligibleCells} eligible of {exec.screenedCells} screened</> : null}
              {exec.confidenceLevel ? <> · {exec.confidenceLevel.toLowerCase()} confidence</> : null}
            </div>
            {ranked[0] && topFactorSignals(ranked[0], 3).map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', marginBottom: 3 }}>
                <span style={{ flex: '0 0 42%', color: '#334155' }}>{s.label}</span>
                <span style={{ flex: 1, height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(10, s.score)) * 10}%`, background: barColor(s.tone) }} />
                </span>
                <span style={{ flex: '0 0 28px', textAlign: 'right', color: '#475569' }}>{s.score.toFixed(1)}</span>
              </div>
            ))}
            {exec.criticalNextCheck && (
              <div style={{ fontSize: '11px', color: '#0c4a6e', marginTop: 4 }}><b>Next check:</b> {exec.criticalNextCheck}</div>
            )}
            {/* v2.1.2 — the link between the greenest cell and the winner,
                stated where the eye lands. */}
            {result.shortlist?.bestScreeningNote && (
              <div style={{ fontSize: '11px', color: '#475569', marginTop: 4 }}>{result.shortlist.bestScreeningNote}</div>
            )}
          </div>
        )}

        <div className="drawer-claim-note">
          Zones to investigate, not exact sites — confirm on the ground before committing.
        </div>

        {/* 2. Map controls */}
        {factorNames.length > 0 && (
          <div className="drawer-layers">
            <div className="drawer-layers-label">Map colour</div>
            <button className={`drawer-layer-btn ${!heatmapType ? 'active' : ''}`} onClick={() => onHeatmapChange(null)}>Overall</button>
            {factorNames.map(t => (
              <button key={t} className={`drawer-layer-btn ${heatmapType === t ? 'active' : ''}`}
                      onClick={() => onHeatmapChange(heatmapType === t ? null : t)}>{t}</button>
            ))}
          </div>
        )}

        {/* 3. The zones */}
        {withheld && (
          <button className="assumptions-toggle withheld-raw-toggle" onClick={() => setShowRaw(!showRaw)}>
            <span>{showRaw ? 'Hide raw candidates' : 'View raw candidates (not a recommendation)'}</span>
          </button>
        )}
        {(!withheld || showRaw) && (
          <div className="drawer-locations">
            {ranked.map((loc, index) => {
              const isSelected = selectedLocations.some(sl => sl.name === loc.name);
              const isExpanded = expanded === loc.name;
              const raw = withheld && !loc.excluded;
              const score = typeof loc.mcda_score === 'number' ? loc.mcda_score : null;
              const scoreClass = loc.excluded ? 'score-excluded' : raw ? 'score-raw'
                : score !== null && score >= 7.5 ? 'score-high' : score !== null && score >= 5 ? 'score-mid' : 'score-low';
              const verdict = !loc.excluded && !raw ? loc.screeningVerdict : undefined;
              const nextChecks = loc.nextValidation ?? [];
              return (
                <div key={loc.name} className={`drawer-loc ${isSelected ? 'drawer-loc-selected' : ''} ${loc.excluded ? 'drawer-loc-excluded' : ''}`}>
                  <div className="drawer-loc-header" onClick={() => onSelectLocation(loc)} role="button" tabIndex={0}>
                    <div className="drawer-loc-rank">{loc.excluded ? '✕' : raw ? String.fromCharCode(65 + index) : `#${index + 1}`}</div>
                    <div className="drawer-loc-info">
                      <div className="drawer-loc-name">
                        {loc.name}
                        {loc.areaHint && <span className="drawer-loc-hint"> near {loc.areaHint}</span>}
                        {verdict && VERDICT_STYLE[verdict] && (
                          <span className="excluded-badge" style={{ background: VERDICT_STYLE[verdict].bg, color: VERDICT_STYLE[verdict].fg }}>{verdict.toUpperCase()}</span>
                        )}
                      </div>
                      <div className="drawer-loc-coords" title="Centre of the zone — not an address">
                        {typeof loc.lat === 'number' ? loc.lat.toFixed(4) : '—'}, {typeof loc.lng === 'number' ? loc.lng.toFixed(4) : '—'}
                      </div>
                    </div>
                    <div className={`drawer-loc-score ${scoreClass}`}>
                      <span className="score-number">{loc.scoreWithheld || score === null ? '—' : score.toFixed(1)}</span>
                      {zoneLabel(loc, withheld) && <span className="score-quality-label">{zoneLabel(loc, withheld)}</span>}
                    </div>
                    <button className="drawer-expand" onClick={(e) => { e.stopPropagation(); setExpanded(isExpanded ? null : loc.name); }} aria-label={isExpanded ? 'Collapse' : 'Expand'}>
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                  </div>

                  {!loc.excluded && nextChecks[0] && (
                    <div className="drawer-next-check"><b>Next check:</b> {nextChecks[0]}</div>
                  )}

                  {isExpanded && (
                    <div className="drawer-loc-details">
                      {(loc.exclusions ?? []).filter(ex => ex.passed === false).length > 0 && (
                        <div className="drawer-exclusions">
                          {(loc.exclusions ?? []).filter(ex => ex.passed === false).map((ex, ei) => (
                            <div key={ei} className="exclusion-item exclusion-fail"><span>✕ {ex.rule}{ex.detail ? ` — ${ex.detail}` : ''}</span></div>
                          ))}
                        </div>
                      )}
                      <div className="drawer-criteria">
                        {(loc.criteria_breakdown ?? []).map((c, ci) => <Criterion key={ci} c={c} />)}
                      </div>
                      {nextChecks.length > 1 && (
                        <div className="drawer-next-list">
                          <div className="drawer-next-title">Before committing</div>
                          <ul>{nextChecks.map((a, i) => <li key={i}>{a}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 4. Notices */}
        {notices.length > 0 && (
          <div className="drawer-notices">
            <button className="assumptions-toggle" onClick={() => setShowNotices(!showNotices)}>
              <span>{notices.length} notice{notices.length === 1 ? '' : 's'} about this run</span>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: showNotices ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showNotices && <ul className="drawer-notice-list">{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        )}

        {spec?.parsingNotes?.length ? (
          <div className="drawer-footnote">{spec.parsingNotes.find(n => /hexes/.test(n))}</div>
        ) : null}
      </div>
    </div>
  );
};
