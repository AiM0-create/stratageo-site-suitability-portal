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
    };
    onSpecEdit(updated);
  };

  const area =
    spec.studyArea.type === 'places'
      ? (spec.studyArea.places || []).map(p => p.split(',')[0]).join(', ')
      : spec.studyArea.type === 'bbox'
        ? 'custom bounding box'
        : 'point + radius';
  const unsupported = spec.meta?.unsupportedRequests || [];
  const weakProxies = spec.layers.filter(l => l.confidence === 'low' || l.proxyWarning);

  return (
    <div className="spec-card">
      <div className="spec-card-header">
        <span className="spec-card-title">Analysis Plan</span>
        <span className={`spec-card-status spec-card-status-${specStatus}`}>
          {specStatus === 'complete' ? 'Ready' : 'Draft'}
        </span>
      </div>

      <div className="spec-card-row"><strong>{spec.businessType}</strong></div>
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

      {/* ── Factor framework ── */}
      <table className="spec-card-table">
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
      </table>

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

      {readyToExecute && (
        <button className="spec-card-execute" onClick={onConfirmExecute} disabled={isExecuting}>
          {isExecuting ? 'Running analysis…' : '▶ Start analysis'}
        </button>
      )}
    </div>
  );
};
