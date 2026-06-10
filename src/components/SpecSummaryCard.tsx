import React from 'react';
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

export const SpecSummaryCard: React.FC<SpecSummaryCardProps> = ({
  spec,
  specStatus,
  readyToExecute,
  isExecuting,
  onConfirmExecute,
  onSpecEdit,
}) => {
  const totalW = spec.layers.reduce((s, l) => s + l.weight, 0) || 1;

  const handleWeightChange = (layerId: string, pct: number) => {
    if (!onSpecEdit || !Number.isFinite(pct) || pct <= 0) return;
    // Store the user's percent verbatim; the engine renormalizes ratios
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

  return (
    <div className="spec-card">
      <div className="spec-card-header">
        <span className="spec-card-title">Analysis Plan</span>
        <span className={`spec-card-status spec-card-status-${specStatus}`}>
          {specStatus === 'complete' ? 'Ready' : 'Draft'}
        </span>
      </div>

      <div className="spec-card-row"><strong>{spec.businessType}</strong></div>
      <div className="spec-card-row">Study area: {area}</div>
      <div className="spec-card-row">Grid: H3 res {spec.grid.resolution} &middot; Top {spec.output?.topN ?? 3} results</div>

      <table className="spec-card-table">
        <tbody>
          {spec.layers.map(l => (
            <tr key={l.id}>
              <td className="spec-layer-id">{l.id}</td>
              <td className="spec-layer-name">
                {l.name}
                {l.direction === 'negative' && <span className="spec-layer-neg" title="Lower is better">↓</span>}
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
            </tr>
          ))}
        </tbody>
      </table>

      {(spec.exclusions?.length ?? 0) > 0 && (
        <div className="spec-card-row spec-card-exclusions">
          Exclusions: {spec.exclusions!.map(e => e.name).join('; ')}
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
