import React, { useState } from 'react';
import type { SpecV2 } from '../types/chat';

interface SpecSummaryCardProps {
  spec: SpecV2;
  specStatus: 'empty' | 'draft' | 'complete';
  readyToExecute: boolean;
  isExecuting: boolean;
  onConfirmExecute: () => void;
  /** When provided, layer weights become editable number inputs */
  onSpecEdit?: (updated: SpecV2) => void;
}

function catchmentLabel(l: SpecV2['layers'][number]): string {
  const c = l.catchment;
  if (c.type === 'euclidean') return `${c.meters}m`;
  return `${c.minutes}-min ${c.type}`;
}

const SCALE_LABELS: Record<string, string> = {
  national: 'National screening',
  city: 'City-level',
  micro_market: 'Micro-market',
  parcel: 'Parcel-level',
  network: 'Network coverage',
  city_then_micro: 'City → micro-market',
};

const FEASIBILITY_META: Record<string, { icon: string; label: string; cls: string }> = {
  feasible: { icon: '✅', label: 'Feasible', cls: 'feasible' },
  tradeoffs: { icon: '⚠️', label: 'Feasible with tradeoffs', cls: 'tradeoffs' },
  not_feasible: { icon: '❌', label: 'Not feasible as specified', cls: 'not-feasible' },
  insufficient_data: { icon: '❓', label: 'Insufficient data — using labeled proxies', cls: 'insufficient' },
};

const Collapsible: React.FC<{ title: string; defaultOpen?: boolean; badgeClass?: string; children: React.ReactNode }> = ({
  title, defaultOpen = false, badgeClass, children,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`spec-section ${badgeClass || ''}`}>
      <button className="spec-section-header" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span className="spec-section-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="spec-section-body">{children}</div>}
    </div>
  );
};

export const SpecSummaryCard: React.FC<SpecSummaryCardProps> = ({
  spec,
  specStatus,
  readyToExecute,
  isExecuting,
  onConfirmExecute,
  onSpecEdit,
}) => {
  const totalW = spec.layers.reduce((s, l) => s + l.weight, 0) || 1;
  const plan = spec.plan;

  const handleWeightChange = (layerId: string, pct: number) => {
    if (!onSpecEdit || !Number.isFinite(pct) || pct <= 0) return;
    const updated: SpecV2 = {
      ...spec,
      layers: spec.layers.map(l => (l.id === layerId ? { ...l, weight: pct } : l)),
      // v1.6.0 (Phase 2) — flag the adjustment so the backend preserves these
      // weights across chat turns and audits them as user-adjusted.
      weightsAdjustedByUser: true,
    };
    onSpecEdit(updated);
  };

  const area =
    spec.studyArea.type === 'places'
      ? (spec.studyArea.places || []).map(p => p.split(',')[0]).join(', ')
      : spec.studyArea.type === 'bbox'
        ? 'custom bounding box'
        : 'point + radius';
  // v1.5.1 — pre-run honesty note: a metro/subway exclusion depends on station
  // data resolving at run time; if it cannot, the result is marked degraded
  // ("requested but not enforced"), never silently kept. Derived purely from
  // the spec the backend already sent — no new backend behavior.
  const hasMetroExclusion = (spec.exclusions ?? []).some(e =>
    /metro|subway/i.test(e.name || '')
    || (e.source?.tags ?? []).some(t => /subway|metro/i.test(t)));
  const unsupported = spec.meta?.unsupportedRequests || [];
  const weakProxies = spec.layers.filter(l => l.confidence === 'low' || l.proxyWarning);
  // Not-feasible plans show the conflict + options instead of factors/execute
  const blocked = spec.feasibility?.status === 'not_feasible';

  return (
    <div className="spec-card">
      <div className="spec-card-header">
        <span className="spec-card-title">Analysis Plan</span>
        <span className={`spec-card-status spec-card-status-${specStatus}`}>
          {specStatus === 'complete' ? 'Ready' : 'Draft'}
        </span>
      </div>

      <div className="spec-card-row"><strong>{spec.businessType}</strong></div>

      {/* ── Feasibility gate banner ── */}
      {spec.feasibility && spec.feasibility.status && (
        <div className={`spec-feasibility spec-feasibility-${(FEASIBILITY_META[spec.feasibility.status] || FEASIBILITY_META.feasible).cls}`}>
          <div className="spec-feasibility-status">
            {(FEASIBILITY_META[spec.feasibility.status] || FEASIBILITY_META.feasible).icon}{' '}
            {(FEASIBILITY_META[spec.feasibility.status] || FEASIBILITY_META.feasible).label}
          </div>
          {spec.feasibility.explanation && <div className="spec-feasibility-why">{spec.feasibility.explanation}</div>}
          {(spec.feasibility.conflicts?.length ?? 0) > 0 && (
            <ul className="spec-list">
              {spec.feasibility.conflicts!.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
          {(spec.feasibility.relaxationOptions?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">Options to proceed</div>
              <ul className="spec-list">
                {spec.feasibility.relaxationOptions!.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
          {(spec.feasibility.unvalidatable?.length ?? 0) > 0 && (
            <div className="spec-feasibility-unvalidatable">
              Cannot be validated from data: {spec.feasibility.unvalidatable!.join('; ')}
            </div>
          )}
        </div>
      )}

      {/* ── Constraint table (when the user gave explicit constraints) ── */}
      {(spec.constraints?.length ?? 0) > 0 && (
        <Collapsible title={`Constraints (${spec.constraints!.length})`} defaultOpen={spec.feasibility?.status === 'not_feasible'}>
          <table className="spec-card-table">
            <thead><tr><th>Constraint</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {spec.constraints!.map((c, i) => (
                <tr key={i} className={c.status === 'conflicting' ? 'spec-row-conflict' : c.status === 'unvalidatable' ? 'spec-row-weak-proxy' : ''}>
                  <td className="spec-layer-name" title={c.notes || undefined}>{c.constraint}</td>
                  <td><span className={`spec-constraint-type spec-constraint-${c.type}`}>{c.type}</span></td>
                  <td>{c.status === 'conflicting' ? '✕ conflict' : c.status === 'unvalidatable' ? '? unverifiable' : '✓'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      )}

      {plan?.methodology && (
        <div className="spec-card-methodology">
          {plan.spatialScale && <span className="spec-scale-badge">{SCALE_LABELS[plan.spatialScale] || plan.spatialScale}</span>}
          {plan.methodology}
        </div>
      )}
      <div className="spec-card-row">Study area: {area}</div>
      <div className="spec-card-row">Grid: H3 res {spec.grid.resolution} &middot; Top {spec.output?.topN ?? 3} results</div>

      {/* ── Consultant assumptions (yellow) ── */}
      {(plan?.assumptions?.length ?? 0) > 0 && (
        <Collapsible title={`Assumptions (${plan!.assumptions!.length})`} defaultOpen badgeClass="spec-section-assumptions">
          <ul className="spec-list">
            {plan!.assumptions!.map((a, i) => (
              <li key={i}><strong>{a.assumption}</strong>{a.basis ? <span className="spec-list-sub"> — {a.basis}</span> : null}</li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* ── Misleading variables ── */}
      {(plan?.misleadingVariables?.length ?? 0) > 0 && (
        <Collapsible title="Why standard site selection may fail" badgeClass="spec-section-misleading">
          <ul className="spec-list">
            {plan!.misleadingVariables!.map((m, i) => (
              <li key={i}><strong>{m.variable}</strong>{m.risk ? <span className="spec-list-sub"> — {m.risk}</span> : null}</li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* ── Factor framework (hidden when the request is not feasible) ── */}
      {!blocked && <table className="spec-card-table">
        <thead>
          <tr><th></th><th>Factor</th><th>Wt</th><th>Catchment</th><th>Conf.</th></tr>
        </thead>
        <tbody>
          {spec.layers.map(l => (
            <tr key={l.id} className={l.confidence === 'low' || l.proxyWarning ? 'spec-row-weak-proxy' : ''}>
              <td className="spec-layer-id">{l.id}</td>
              <td className="spec-layer-name" title={[l.whyItMatters, l.proxyWarning ? `⚠ ${l.proxyWarning}` : null].filter(Boolean).join(' | ') || undefined}>
                {l.name}
                {l.direction === 'negative' && <span className="spec-layer-neg" title="Lower is better">↓</span>}
                {l.proxyWarning && <span className="spec-proxy-flag" title={l.proxyWarning}>⚠</span>}
                {l.whyItMatters && <div className="spec-why">{l.whyItMatters}</div>}
              </td>
              <td className="spec-layer-weight">
                {onSpecEdit ? (
                  <span className="spec-weight-edit">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={Math.round((l.weight / totalW) * 100)}
                      onChange={e => handleWeightChange(l.id, Number(e.target.value))}
                      title="Edit weight — others renormalize proportionally"
                    />%
                  </span>
                ) : (
                  `${Math.round((l.weight / totalW) * 100)}%`
                )}
              </td>
              <td className="spec-layer-catchment">{catchmentLabel(l)}</td>
              <td><span className={`spec-conf spec-conf-${l.confidence || 'medium'}`}>{(l.confidence || 'medium')[0].toUpperCase()}</span></td>
            </tr>
          ))}
        </tbody>
      </table>}

      {/* ── Hard exclusions (red) ── */}
      {(spec.exclusions?.length ?? 0) > 0 && (
        <div className="spec-card-exclusions">
          <strong>Hard exclusions:</strong> {spec.exclusions!.map(e => `${e.name} (${e.bufferM ?? 300}m)`).join('; ')}
        </div>
      )}

      {/* ── Scenarios ── */}
      {(plan?.scenarios?.length ?? 0) > 0 && (
        <div className="spec-scenarios">
          {plan!.scenarios!.map((s, i) => (
            <span key={i} className="spec-scenario-chip" title={[s.description, s.emphasis].filter(Boolean).join(' — ')}>
              {s.name}
            </span>
          ))}
        </div>
      )}

      {/* ── Validation + failure risks ── */}
      {((plan?.validation?.length ?? 0) > 0 || (plan?.modelFailureRisks?.length ?? 0) > 0) && (
        <Collapsible title="Validation & failure risks">
          {(plan?.validation?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">Validation</div>
              <ul className="spec-list">{plan!.validation!.map((v, i) => <li key={i}>{v}</li>)}</ul>
            </>
          )}
          {(plan?.modelFailureRisks?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">How this could be wrong</div>
              <ul className="spec-list">{plan!.modelFailureRisks!.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          )}
        </Collapsible>
      )}

      {/* ── v1.4.9 — PlannerLite scope: verified / skipped / cannot verify ── */}
      {spec.plannerPreview && !blocked && (
        <Collapsible title="Analysis scope" defaultOpen>
          {(spec.plannerPreview.willVerify?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">Will be checked</div>
              <ul className="spec-list">
                {spec.plannerPreview.willVerify!.map((v, i) => <li key={i}>✓ {v}</li>)}
              </ul>
            </>
          )}
          {(spec.plannerPreview.skipped?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">Skipped for this analysis (saves time)</div>
              <ul className="spec-list">
                {spec.plannerPreview.skipped!.map((s, i) => (
                  <li key={i}><span className="spec-list-sub">⚡ {s.reason}</span></li>
                ))}
              </ul>
            </>
          )}
          {(spec.plannerPreview.cannotVerify?.length ?? 0) > 0 && (
            <>
              <div className="spec-subhead">Cannot be verified from data</div>
              <ul className="spec-list">
                {spec.plannerPreview.cannotVerify!.map((c, i) => <li key={i}>⚠ {c}</li>)}
              </ul>
              <p className="assumption-note" style={{ fontSize: '10.5px', color: '#92400e', margin: '2px 0 0' }}>
                These will be flagged for field validation — never scored.
              </p>
            </>
          )}
          {hasMetroExclusion && (
            <p className="assumption-note" style={{ fontSize: '10.5px', color: '#64748b', margin: '4px 0 0' }}>
              Metro exclusion will be attempted with resolved station data; if
              station data is unavailable at run time, the result will be marked
              “requested but not enforced” — never silently kept.
            </p>
          )}
        </Collapsible>
      )}

      {/* ── Weak proxy banner (orange) ── */}
      {weakProxies.length > 0 && (
        <div className="spec-card-weak-banner">
          ⚠ {weakProxies.length} factor{weakProxies.length > 1 ? 's use' : ' uses'} a weak proxy — treat with caution
        </div>
      )}

      {unsupported.length > 0 && (
        <div className="spec-card-unsupported">
          {unsupported.map((u, i) => (
            <div key={i} className="spec-card-unsupported-item">
              ⚠ <em>{u.requested}</em>: {u.fallback}
            </div>
          ))}
        </div>
      )}

      {readyToExecute && !blocked && (
        <button
          type="button"
          className="spec-card-execute"
          onClick={() => onConfirmExecute()}
          disabled={isExecuting}
        >
          {isExecuting ? 'Running analysis…' : '▶ Start analysis'}
        </button>
      )}
    </div>
  );
};
