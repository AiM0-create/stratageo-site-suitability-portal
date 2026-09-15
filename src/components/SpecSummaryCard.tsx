import React, { useState } from 'react';
import type { SpecV2 } from '../types/chat';
import {
  weightPercents, setLayerWeightPercent, toggleLayerDirection, removeLayer, buildAddFactorPrompt,
} from '../services/factorEditing';

/**
 * v2.1.0 — the plan, cut to what the customer agrees to before spending:
 *
 *   what and where · what we assumed (their words, marked) · the factors —
 *   each with its weight, direction and the reason it is there · what is
 *   excluded · Run.
 *
 * Gone: scenario chips and the plan-card questions (the clarification turn
 * asks first), the misleading-variables list (every factor now says why it
 * is there), the constraints table, validation/failure-risk prose, the
 * planner-preview scope, the H3 level picker, the methodology paragraph.
 */
interface SpecSummaryCardProps {
  spec: SpecV2;
  specStatus: 'empty' | 'draft' | 'complete';
  readyToExecute: boolean;
  isExecuting: boolean;
  onConfirmExecute: () => void;
  /** When provided, the factors become editable (weight slider, direction, remove). */
  onSpecEdit?: (updated: SpecV2) => void;
  /** Adding a NEW factor needs a real data source, which only the planner can
   *  choose — so "add factor" sends a chat turn. */
  onSendMessage?: (prompt: string) => void;
  hideClarifyingQuestions?: boolean;   // kept for prop compatibility; the card asks nothing itself
}

function catchmentLabel(l: SpecV2['layers'][number]): string {
  const c = l.catchment;
  return c.type === 'euclidean' ? `${c.meters}m` : `${c.minutes}-min ${c.type}`;
}

const FEASIBILITY_META: Record<string, { icon: string; label: string; cls: string }> = {
  feasible: { icon: '✅', label: 'Feasible', cls: 'feasible' },
  tradeoffs: { icon: '⚠️', label: 'Feasible with tradeoffs', cls: 'tradeoffs' },
  not_feasible: { icon: '❌', label: 'Not feasible as specified', cls: 'not-feasible' },
  insufficient_data: { icon: '❓', label: 'Insufficient data — using labelled proxies', cls: 'insufficient' },
};

/** Plain wording for a composer rejection reason. */
export function rejectionLabel(reason: string): string {
  switch (reason) {
    case 'unknown_class':          return 'not something we can count from map data';
    case 'duplicate_of_framework': return 'already measured by the framework';
    case 'duplicate_proposal':     return 'proposed twice';
    case 'illegal_catchment':      return 'catchment outside what the engine runs';
    case 'not_in_brief':           return 'nothing in your brief asked for it';
    case 'over_cap':               return 'too many extra factors';
    default:                       return 'could not be used';
  }
}

export const SpecSummaryCard: React.FC<SpecSummaryCardProps> = ({
  spec, specStatus, readyToExecute, isExecuting, onConfirmExecute, onSpecEdit, onSendMessage,
}) => {
  const [addingFactor, setAddingFactor] = useState(false);
  const [newFactorName, setNewFactorName] = useState('');
  const [newFactorDir, setNewFactorDir] = useState<'positive' | 'negative'>('positive');

  const edit = (layers: SpecV2['layers']) => onSpecEdit?.({ ...spec, layers, weightsAdjustedByUser: true });
  const handleAddFactor = () => {
    const name = newFactorName.trim();
    if (!name || !onSendMessage) return;
    onSendMessage(buildAddFactorPrompt(name, newFactorDir));
    setNewFactorName(''); setNewFactorDir('positive'); setAddingFactor(false);
  };

  const pcts = weightPercents(spec.layers);
  const plan = spec.plan;
  const feas = spec.feasibility?.status ? (FEASIBILITY_META[spec.feasibility.status] || FEASIBILITY_META.feasible) : null;
  const blocked = spec.feasibility?.status === 'not_feasible';
  const area = spec.studyArea.type === 'places'
    ? (spec.studyArea.places || []).map(p => p.split(',')[0]).join(', ')
    : spec.studyArea.type === 'bbox' ? 'custom bounding box' : 'point + radius';
  const unsupported = spec.meta?.unsupportedRequests || [];
  const composition = spec.factorComposition;

  return (
    <div className="spec-card">
      <div className="spec-card-header">
        <span className="spec-card-title">Analysis plan</span>
        <span className={`spec-card-status spec-card-status-${specStatus}`}>{specStatus === 'complete' ? 'Ready' : 'Draft'}</span>
      </div>

      <div className="spec-card-row"><strong>{spec.businessType}</strong> · {area} · top {spec.output?.topN ?? 3} zones</div>

      {feas && spec.feasibility && (spec.feasibility.status !== 'feasible' || (spec.feasibility.unvalidatable?.length ?? 0) > 0) && (
        <div className={`spec-feasibility spec-feasibility-${feas.cls}`}>
          <div className="spec-feasibility-status">{feas.icon} {feas.label}</div>
          {spec.feasibility.explanation && <div className="spec-feasibility-why">{spec.feasibility.explanation}</div>}
          {(spec.feasibility.conflicts?.length ?? 0) > 0 && (
            <ul className="spec-list">{spec.feasibility.conflicts!.map((c, i) => <li key={i}>{c}</li>)}</ul>
          )}
          {(spec.feasibility.relaxationOptions?.length ?? 0) > 0 && (
            <ul className="spec-list">{spec.feasibility.relaxationOptions!.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          {(spec.feasibility.unvalidatable?.length ?? 0) > 0 && (
            <div className="spec-feasibility-unvalidatable">Cannot be checked from map data: {spec.feasibility.unvalidatable!.join('; ')}</div>
          )}
        </div>
      )}

      {(plan?.assumptions?.length ?? 0) > 0 && (
        <div className="spec-assumptions">
          <div className="spec-subhead">What we're going on</div>
          <ul className="spec-list">
            {plan!.assumptions!.map((a, i) => (
              <li key={i}><strong>{a.assumption}</strong>{a.basis ? <span className="spec-list-sub"> — {a.basis}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}

      {!blocked && composition && (
        <div className={`spec-composition${composition.genericFramework ? ' is-generic' : ''}`}>
          {composition.genericFramework
            ? <>No standard framework for this business type — the factors below are broad proxies plus what your brief added.
                {composition.replaced?.length
                  ? <> Your brief named the real competitors, so <em>{composition.replaced.join(', ')}</em> was dropped.</>
                  : null}</>
            : <>Framework: <strong>{composition.frameworkName}</strong>
                {composition.accepted.length
                  ? <> · {composition.accepted.length} factor{composition.accepted.length > 1 ? 's' : ''} added from your brief</>
                  : null}</>}
          {composition.rejected.length > 0 && (
            <ul className="spec-composition-rejected">
              {composition.rejected.map((r, i) => (
                <li key={i}>
                  <span className="spec-composition-class">{r.featureClass}</span> — {rejectionLabel(r.reason)}
                  {r.detail ? <span className="spec-list-sub"> ({r.detail})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!blocked && (
        <div className="spec-factors">
          {spec.layers.map((l, i) => (
            <div key={l.id} className={`spec-factor ${l.confidence === 'low' || l.proxyWarning ? 'spec-row-weak-proxy' : ''}`}>
              <div className="spec-factor-head">
                <span className="spec-factor-name" title={l.proxyWarning ? `⚠ ${l.proxyWarning}` : undefined}>{l.name}</span>
                {onSpecEdit ? (
                  <button type="button" className={`spec-dir-toggle ${l.direction === 'negative' ? 'is-neg' : 'is-pos'}`}
                          onClick={() => edit(toggleLayerDirection(spec.layers, l.id))} title="Click to flip: should more of this be better, or less?">
                    {l.direction === 'negative' ? '− less is better' : '+ more is better'}
                  </button>
                ) : (
                  <span className={`spec-dir-toggle ${l.direction === 'negative' ? 'is-neg' : 'is-pos'}`}>
                    {l.direction === 'negative' ? '− less is better' : '+ more is better'}
                  </span>
                )}
                {l.proxyWarning && <span className="spec-proxy-flag" title={l.proxyWarning}>⚠</span>}
                {l.origin === 'brief' && (
                  <span className="spec-origin is-brief" title={l.evidence ? `Added because you said “${l.evidence}”` : 'Added from your brief'}>from your brief</span>
                )}
                <span className="spec-factor-pct">{pcts[i]}%</span>
                {onSpecEdit && spec.layers.length > 1 && (
                  <button type="button" className="spec-factor-remove" onClick={() => { const next = removeLayer(spec.layers, l.id); if (next !== spec.layers) edit(next); }}
                          title={`Remove ${l.name}`} aria-label={`Remove ${l.name}`}>×</button>
                )}
              </div>
              {onSpecEdit && (
                <input className="spec-factor-slider" type="range" min={1} max={99} value={pcts[i]}
                       onChange={e => edit(setLayerWeightPercent(spec.layers, l.id, Number(e.target.value)))}
                       aria-label={`Weight for ${l.name}`} title="Drag to change importance — the other factors keep their relative balance" />
              )}
              <div className="spec-factor-meta">{catchmentLabel(l)} · {(l.confidence || 'medium')} confidence</div>
              {l.whyItMatters && (
                <div className="spec-factor-why">
                  {l.whyItMatters}
                  {l.origin === 'brief' && l.evidence ? <span className="spec-factor-evidence"> — you said “{l.evidence}”</span> : null}
                </div>
              )}
            </div>
          ))}

          {onSpecEdit && onSendMessage && (
            addingFactor ? (
              <div className="spec-add-factor">
                <input className="spec-add-input" type="text" autoFocus placeholder="What else matters? e.g. parking availability"
                       value={newFactorName} onChange={e => setNewFactorName(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') handleAddFactor(); if (e.key === 'Escape') { setAddingFactor(false); setNewFactorName(''); } }} />
                <button type="button" className={`spec-dir-toggle ${newFactorDir === 'negative' ? 'is-neg' : 'is-pos'}`}
                        onClick={() => setNewFactorDir(d => (d === 'negative' ? 'positive' : 'negative'))} title="Should more of this be better, or less?">
                  {newFactorDir === 'negative' ? '− less is better' : '+ more is better'}
                </button>
                <button type="button" className="spec-add-confirm" onClick={handleAddFactor} disabled={!newFactorName.trim()}>Add</button>
                <button type="button" className="spec-add-cancel" onClick={() => { setAddingFactor(false); setNewFactorName(''); }}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="spec-add-trigger" onClick={() => setAddingFactor(true)}>+ Add a factor</button>
            )
          )}
        </div>
      )}

      {(spec.exclusions?.length ?? 0) > 0 && (
        <div className="spec-card-exclusions">
          <strong>Kept out:</strong> {spec.exclusions!.map(e => `${e.name} (${e.bufferM ?? 300}m)`).join('; ')}
        </div>
      )}

      {unsupported.length > 0 && (
        <div className="spec-card-unsupported">
          {unsupported.map((u, i) => (
            <div key={i} className="spec-card-unsupported-item">⚠ <em>{u.requested}</em>: {u.fallback}</div>
          ))}
        </div>
      )}

      {readyToExecute && !blocked && (
        <button type="button" className="spec-card-execute" onClick={() => onConfirmExecute()} disabled={isExecuting}>
          {isExecuting ? 'Running analysis…' : 'Run analysis'}
        </button>
      )}
    </div>
  );
};
