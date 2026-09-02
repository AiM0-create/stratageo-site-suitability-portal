import React, { useState } from 'react';
import type { SpecV2 } from '../types/chat';
import {
  weightPercents, setLayerWeightPercent, toggleLayerDirection, removeLayer,
  buildAddFactorPrompt, applyScenarioWeights, restoreWeights,
} from '../services/factorEditing';

interface SpecSummaryCardProps {
  spec: SpecV2;
  specStatus: 'empty' | 'draft' | 'complete';
  readyToExecute: boolean;
  isExecuting: boolean;
  onConfirmExecute: () => void;
  /** When provided, the factor framework becomes editable (weight slider,
   *  direction toggle, remove). */
  onSpecEdit?: (updated: SpecV2) => void;
  /** v1.11.4 — send a chat turn. Adding a NEW factor needs a real data source
   *  (OSM tags / Places types) and a catchment, which only the planner can
   *  choose — inventing them in the browser would create a layer that matches
   *  nothing or silently measures the wrong thing. So "add factor" asks the
   *  planner, while weight/direction/remove stay instant client-side edits. */
  onSendMessage?: (prompt: string) => void;
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

// v1.6.3 — the two grid levels the customer can choose on the plan card.
// Level 8 is the engine default; level 7 is a coarser, faster district-scale
// screen. (The backend still honors a res-10 block-granularity prompt
// override until the customer picks a level explicitly.)
const GRID_LEVEL_CHOICES: Array<{ res: number; label: string; hint: string }> = [
  { res: 7, label: 'Level 7', hint: '~5.2 km² hexes — district-scale screening, fastest' },
  { res: 8, label: 'Level 8', hint: '~0.74 km² hexes — neighbourhood-scale (default)' },
];

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
  onSendMessage,
}) => {
  const plan = spec.plan;
  const pcts = weightPercents(spec.layers);
  const [addingFactor, setAddingFactor] = useState(false);
  const [newFactorName, setNewFactorName] = useState('');
  const [newFactorDir, setNewFactorDir] = useState<'positive' | 'negative'>('positive');

  /**
   * v1.12.6 — scenario chips are now applicable, not decorative.
   *
   * They already sat on the plan card at exactly the right moment — after the
   * methodology is visible, before anything is spent — carrying an `emphasis`
   * describing which factors should matter more. They rendered as <span>s, so
   * the choice was readable and inert. Clicking one now re-weights the factor
   * framework through the same audited path as the sliders
   * (weightsAdjustedByUser -> preserved across chat turns, reported in the
   * weight audit as user-adjusted).
   *
   * `baseWeightsRef` snapshots the weights BEFORE the first scenario is applied
   * so switching between scenarios always recomputes from the archetype
   * defaults rather than compounding, and clicking the active chip again
   * restores them.
   */
  const baseWeightsRef = React.useRef<Record<string, number> | null>(null);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  /** v1.12.6 — questionId -> optionId. Answering is optional throughout. */
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const scenarioIsApplicable = (sc: { weightMultipliers?: Record<string, number> }) =>
    Boolean(onSpecEdit && sc.weightMultipliers && Object.keys(sc.weightMultipliers).length > 0);

  /**
   * A scenario chip and a question answer are the same operation — both say
   * "these factors matter more" — so they compose through one path instead of
   * fighting each other. Everything is recomputed from `base` (the weights
   * before any emphasis), so selections are order-independent and never
   * compound.
   */
  const combineMultipliers = (
    scenarioName: string | null,
    picked: Record<string, string>,
  ): Record<string, number> => {
    const acc: Record<string, number> = {};
    const add = (m?: Record<string, number>) => {
      if (!m) return;
      for (const [id, v] of Object.entries(m)) {
        if (Number.isFinite(v)) acc[id] = (acc[id] ?? 1) * v;
      }
    };
    add(plan?.scenarios?.find(x => x.name === scenarioName)?.weightMultipliers);
    for (const q of plan?.clarifyingQuestions ?? []) {
      add(q.options.find(o => o.id === picked[q.id])?.weightMultipliers);
    }
    return acc;
  };

  /** v1.12.6 (step 3) — what the customer TOLD us, so the report can say
   *  "you told us X" instead of "we assumed X". An answered question stops
   *  being an assumption, which is where the run-to-run variance came from. */
  const resolvedClarifications = (picked: Record<string, string>): string[] =>
    (plan?.clarifyingQuestions ?? [])
      .map(q => {
        const opt = q.options.find(o => o.id === picked[q.id]);
        return opt ? `${q.question} — ${opt.label}` : null;
      })
      .filter((v): v is string => v !== null);

  const applyEmphasis = (scenarioName: string | null, picked: Record<string, string>) => {
    if (!onSpecEdit) return;
    if (!baseWeightsRef.current) {
      baseWeightsRef.current = Object.fromEntries(spec.layers.map(l => [l.id, l.weight]));
    }
    const base = baseWeightsRef.current;
    const combined = combineMultipliers(scenarioName, picked);
    const layers = Object.keys(combined).length
      ? applyScenarioWeights(spec.layers, base, combined)
      : restoreWeights(spec.layers, base);
    const resolved = resolvedClarifications(picked);
    onSpecEdit({
      ...spec,
      layers,
      weightsAdjustedByUser: true,
      meta: { ...(spec.meta ?? {}), clarificationsResolved: resolved },
    });
  };

  const handleScenarioClick = (sc: {
    name: string; weightMultipliers?: Record<string, number>;
  }) => {
    if (!onSpecEdit || !scenarioIsApplicable(sc)) return;
    const next = activeScenario === sc.name ? null : sc.name;   // click again = off
    setActiveScenario(next);
    applyEmphasis(next, answers);
  };

  const handleAnswer = (questionId: string, optionId: string) => {
    if (!onSpecEdit) return;
    const next = { ...answers };
    if (next[questionId] === optionId) delete next[questionId];  // click again = unset
    else next[questionId] = optionId;
    setAnswers(next);
    applyEmphasis(activeScenario, next);
  };

  // v1.11.4 — BUG FIX. This used to do `weight: pct`, writing the typed
  // PERCENTAGE straight onto the layer while the card renders weight/sum*100.
  // Archetype weights are fractions summing to ~1, so typing "25" set one layer
  // to 25 against a total of ~25.65: it displayed 97% and every OTHER factor
  // collapsed to 0%. A single edit destroyed the framework — the live
  // "00% / 0% / 0% / 0%" report. setLayerWeightPercent solves for the weight
  // that makes this layer exactly pct% while holding the others' ratios fixed.
  const handleWeightChange = (layerId: string, pct: number) => {
    if (!onSpecEdit) return;
    onSpecEdit({
      ...spec,
      layers: setLayerWeightPercent(spec.layers, layerId, pct),
      // v1.6.0 (Phase 2) — flag the adjustment so the backend preserves these
      // weights across chat turns and audits them as user-adjusted.
      weightsAdjustedByUser: true,
    });
  };

  const handleDirectionToggle = (layerId: string) => {
    if (!onSpecEdit) return;
    onSpecEdit({
      ...spec,
      layers: toggleLayerDirection(spec.layers, layerId),
      weightsAdjustedByUser: true,
    });
  };

  const handleRemoveLayer = (layerId: string) => {
    if (!onSpecEdit) return;
    const layers = removeLayer(spec.layers, layerId);
    if (layers === spec.layers) return;          // refused: last factor
    onSpecEdit({ ...spec, layers, weightsAdjustedByUser: true });
  };

  const handleAddFactor = () => {
    const name = newFactorName.trim();
    if (!name || !onSendMessage) return;
    onSendMessage(buildAddFactorPrompt(name, newFactorDir));
    setNewFactorName('');
    setNewFactorDir('positive');
    setAddingFactor(false);
  };

  // v1.6.3 — customer picks the H3 grid level (7 or 8). Flagged so the
  // backend preserves the choice across chat turns (like the weight sliders).
  const handleGridResChange = (res: number) => {
    if (!onSpecEdit || (res !== 7 && res !== 8) || spec.grid.resolution === res) return;
    onSpecEdit({
      ...spec,
      grid: { ...spec.grid, resolution: res },
      gridResolutionAdjustedByUser: true,
    });
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
      <div className="spec-card-row spec-grid-row">
        Grid:{' '}
        {onSpecEdit && !blocked ? (
          <span className="spec-grid-picker" role="radiogroup" aria-label="H3 grid level">
            {GRID_LEVEL_CHOICES.map(g => (
              <button
                key={g.res}
                type="button"
                role="radio"
                aria-checked={spec.grid.resolution === g.res}
                className={`spec-grid-choice${spec.grid.resolution === g.res ? ' spec-grid-choice-active' : ''}`}
                title={g.hint}
                onClick={() => handleGridResChange(g.res)}
              >
                {g.label}
              </button>
            ))}
            {spec.grid.resolution !== 7 && spec.grid.resolution !== 8 && (
              <span
                className="spec-grid-current"
                title="Set from your prompt wording — pick a level to override"
              >
                res {spec.grid.resolution}
              </span>
            )}
          </span>
        ) : (
          <>H3 res {spec.grid.resolution}</>
        )}
        {' '}&middot; Top {spec.output?.topN ?? 3} results
      </div>

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
      {/* v1.11.4 — editable factor framework. Live feedback: "changing
          variables is a task here, its not friendly at all, also what if i
          want to introduce my own variable or change the +- of a variable".
          Each row is now a slider (drag, don't type into a 3-character number
          spinner), a clickable direction toggle, and a remove button. Adding a
          brand-new factor goes through the planner — see onSendMessage. */}
      {!blocked && (
        <div className="spec-factors">
          {spec.layers.map((l, i) => (
            <div
              key={l.id}
              className={`spec-factor ${l.confidence === 'low' || l.proxyWarning ? 'spec-row-weak-proxy' : ''}`}
            >
              <div className="spec-factor-head">
                <span
                  className="spec-factor-name"
                  title={[l.whyItMatters, l.proxyWarning ? `⚠ ${l.proxyWarning}` : null].filter(Boolean).join(' | ') || undefined}
                >
                  {l.name}
                </span>
                {onSpecEdit ? (
                  <button
                    type="button"
                    className={`spec-dir-toggle ${l.direction === 'negative' ? 'is-neg' : 'is-pos'}`}
                    onClick={() => handleDirectionToggle(l.id)}
                    title="Click to flip: should more of this be better, or less?"
                  >
                    {l.direction === 'negative' ? '− less is better' : '+ more is better'}
                  </button>
                ) : (
                  <span className={`spec-dir-toggle ${l.direction === 'negative' ? 'is-neg' : 'is-pos'}`}>
                    {l.direction === 'negative' ? '− less is better' : '+ more is better'}
                  </span>
                )}
                {l.proxyWarning && <span className="spec-proxy-flag" title={l.proxyWarning}>⚠</span>}
                <span className="spec-factor-pct">{pcts[i]}%</span>
                {onSpecEdit && spec.layers.length > 1 && (
                  <button
                    type="button"
                    className="spec-factor-remove"
                    onClick={() => handleRemoveLayer(l.id)}
                    title={`Remove ${l.name} from the analysis`}
                    aria-label={`Remove ${l.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
              {onSpecEdit && (
                <input
                  className="spec-factor-slider"
                  type="range"
                  min={1}
                  max={99}
                  value={pcts[i]}
                  onChange={e => handleWeightChange(l.id, Number(e.target.value))}
                  aria-label={`Weight for ${l.name}`}
                  title="Drag to change importance — the other factors keep their relative balance"
                />
              )}
              <div className="spec-factor-meta">
                {catchmentLabel(l)} · {(l.confidence || 'medium')} confidence
                {l.whyItMatters ? ` · ${l.whyItMatters}` : ''}
              </div>
            </div>
          ))}

          {/* Add your own factor. Routed through the planner because a layer
              needs a real data source, not a name the browser made up. */}
          {onSpecEdit && onSendMessage && (
            addingFactor ? (
              <div className="spec-add-factor">
                <input
                  className="spec-add-input"
                  type="text"
                  autoFocus
                  placeholder="What else matters? e.g. parking availability"
                  value={newFactorName}
                  onChange={e => setNewFactorName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAddFactor();
                    if (e.key === 'Escape') { setAddingFactor(false); setNewFactorName(''); }
                  }}
                />
                <button
                  type="button"
                  className={`spec-dir-toggle ${newFactorDir === 'negative' ? 'is-neg' : 'is-pos'}`}
                  onClick={() => setNewFactorDir(d => (d === 'negative' ? 'positive' : 'negative'))}
                  title="Should more of this be better, or less?"
                >
                  {newFactorDir === 'negative' ? '− less is better' : '+ more is better'}
                </button>
                <button
                  type="button"
                  className="spec-add-confirm"
                  onClick={handleAddFactor}
                  disabled={!newFactorName.trim()}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="spec-add-cancel"
                  onClick={() => { setAddingFactor(false); setNewFactorName(''); }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="spec-add-trigger"
                onClick={() => setAddingFactor(true)}
              >
                + Add a factor
              </button>
            )
          )}
        </div>
      )}

      {/* ── Hard exclusions (red) ── */}
      {(spec.exclusions?.length ?? 0) > 0 && (
        <div className="spec-card-exclusions">
          <strong>Hard exclusions:</strong> {spec.exclusions!.map(e => `${e.name} (${e.bufferM ?? 300}m)`).join('; ')}
        </div>
      )}

      {/* ── Scenarios ── */}
      {(plan?.scenarios?.length ?? 0) > 0 && (
        <div className="spec-scenarios">
          {plan!.scenarios!.map((sc, i) => {
            const applicable = scenarioIsApplicable(sc);
            const active = activeScenario === sc.name;
            const hint = [sc.description, sc.emphasis].filter(Boolean).join(' — ');
            // A scenario with no derived multipliers cannot change anything, so
            // it stays a plain label rather than a button that does nothing.
            if (!applicable) {
              return (
                <span key={i} className="spec-scenario-chip" title={hint}>{sc.name}</span>
              );
            }
            return (
              <button
                key={i}
                type="button"
                className={`spec-scenario-chip is-applicable${active ? ' is-active' : ''}`}
                aria-pressed={active}
                title={[hint, active ? 'Click to restore the default weights' : 'Click to apply this emphasis']
                  .filter(Boolean).join(' — ')}
                onClick={() => handleScenarioClick(sc)}
              >
                {sc.name}
              </button>
            );
          })}
          {activeScenario && (
            <span className="spec-scenario-note">
              Weights re-balanced for “{activeScenario}” — click it again to restore defaults.
            </span>
          )}
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

      {/* ── Optional refinement (v1.12.6) ──
          Placed here on purpose: after the methodology is visible and directly
          above Run, so it reads as "sharpen this before spending" rather than a
          gate in front of the answer. Every question is skippable. */}
      {onSpecEdit && (plan?.clarifyingQuestions?.length ?? 0) > 0 && !blocked && (
        <div className="spec-clarify">
          <div className="spec-clarify-head">
            Optional — narrows the ranking. Skip and run if you'd rather.
          </div>
          {plan!.clarifyingQuestions!.map(q => (
            <div key={q.id} className="spec-clarify-q">
              <div className="spec-clarify-question">{q.question}</div>
              {q.why && <div className="spec-clarify-why">{q.why}</div>}
              <div className="spec-clarify-options">
                {q.options.map(o => (
                  <button
                    key={o.id}
                    type="button"
                    className={`spec-clarify-option${answers[q.id] === o.id ? ' is-active' : ''}`}
                    aria-pressed={answers[q.id] === o.id}
                    onClick={() => handleAnswer(q.id, o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
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
          {isExecuting ? 'Running analysis…' : 'Run analysis'}
        </button>
      )}
    </div>
  );
};
