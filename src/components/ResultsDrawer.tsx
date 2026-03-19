import React, { useState, useMemo } from 'react';
import type { LocationData, AnalysisResult, AnalysisSpec, HeatmapType } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface ResultsDrawerProps {
  open: boolean;
  onClose: () => void;
  result: AnalysisResult;
  spec: AnalysisSpec | null;
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  customWeights: Record<string, number>;
  onWeightChange: (name: string, weight: number) => void;
  heatmapType: HeatmapType;
  onHeatmapChange: (type: HeatmapType) => void;
  showBuffers?: boolean;
  onToggleBuffers?: () => void;
  csvPointCount?: number;
}

const ComparisonChart: React.FC<{ locations: LocationData[] }> = ({ locations }) => {
  const criteriaNames = useMemo(() =>
    Array.from(new Set(locations.flatMap(loc => loc.criteria_breakdown.map(c => c.name)))),
    [locations]);

  const chartData = useMemo(() => criteriaNames.map(name => {
    const point: Record<string, any> = { criteria: name.length > 16 ? name.slice(0, 14) + '...' : name };
    locations.forEach((loc, i) => {
      const c = loc.criteria_breakdown.find(cr => cr.name === name);
      point[`loc${i}`] = c?.score ?? 0;
    });
    return point;
  }), [criteriaNames, locations]);

  const colors = ['#1d4ed8', '#059669', '#d97706'];

  return (
    <div className="drawer-chart">
      <ResponsiveContainer width="100%" height={Math.max(180, criteriaNames.length * 32)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis type="number" domain={[0, 10]} hide />
          <YAxis dataKey="criteria" type="category" tick={{ fill: '#64748b', fontSize: 10 }} width={110} />
          <Tooltip cursor={{ fill: 'transparent' }} contentStyle={{ borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '11px' }} />
          {locations.length > 1 && <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '4px' }} />}
          {locations.map((loc, i) => (
            <Bar key={loc.name} dataKey={`loc${i}`} name={loc.name} fill={colors[i % colors.length]} radius={[0, 3, 3, 0]} barSize={locations.length > 1 ? 10 : 14} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const EvidenceTag: React.FC<{ basis: string }> = ({ basis }) => {
  const label = basis === 'osm-observed' ? 'OSM' : basis === 'osm-derived' ? 'Derived' : basis === 'constraint-rule' ? 'Rule' : basis === 'ai-generated' ? 'AI' : 'Default';
  const cls = basis === 'osm-observed' ? 'evidence-osm' : basis === 'constraint-rule' ? 'evidence-rule' : basis === 'ai-generated' ? 'evidence-ai' : 'evidence-default';
  return <span className={`evidence-tag ${cls}`}>{label}</span>;
};

const DirectionIcon: React.FC<{ direction: string }> = ({ direction }) => (
  <span className={`direction-icon ${direction === 'positive' ? 'dir-positive' : 'dir-negative'}`} title={direction === 'positive' ? 'Positive — more is better' : 'Negative — less is better'}>
    {direction === 'positive' ? '▲' : '▼'}
  </span>
);

export const ResultsDrawer: React.FC<ResultsDrawerProps> = ({
  open,
  onClose,
  result,
  spec,
  locations,
  selectedLocations,
  onSelectLocation,
  customWeights,
  onWeightChange,
  heatmapType,
  onHeatmapChange,
  showBuffers,
  onToggleBuffers,
  csvPointCount = 0,
}) => {
  const [expandedLoc, setExpandedLoc] = useState<string | null>(locations[0]?.name ?? null);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const ranked = useMemo(() => [...locations].sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.mcda_score - a.mcda_score;
  }), [locations]);

  // Collect unique POI types from locations for heatmap toggles
  const poiTypes = useMemo(() => {
    const types = new Set<string>();
    locations.forEach(loc => loc.pois.forEach(p => types.add(p.type)));
    return Array.from(types).slice(0, 6);
  }, [locations]);

  return (
    <div className={`drawer ${open ? 'drawer-open' : 'drawer-closed'}`}>
      <div className="drawer-header">
        <div>
          <div className="drawer-title">Ranked Locations</div>
          <div className="drawer-subtitle">{result.business_type} — {result.target_location}</div>
        </div>
        <button onClick={onClose} className="drawer-close" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="drawer-body">
        {/* Summary */}
        <p className="drawer-summary">{result.summary}</p>

        {/* Analysis Assumptions Panel */}
        {spec && (
          <div className="drawer-assumptions">
            <button className="assumptions-toggle" onClick={() => setShowAssumptions(!showAssumptions)}>
              <span>Analysis Assumptions</span>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: showAssumptions ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showAssumptions && (
              <div className="assumptions-body">
                <div className="assumption-row">
                  <span className="assumption-label">Sector</span>
                  <span className="assumption-value">{spec.businessType}{spec.classificationMeta?.source === 'llm' ? '' : ` (${spec.sectorId})`}</span>
                </div>
                <div className="assumption-row">
                  <span className="assumption-label">Search Radius</span>
                  <span className="assumption-value">{locations[0] ? `${(locations[0].searchRadiusM / 1000).toFixed(1)}km` : '—'}</span>
                </div>
                <div className="assumption-row">
                  <span className="assumption-label">Confidence</span>
                  <span className={`assumption-value confidence-${spec.confidence}`}>{spec.confidence}</span>
                </div>
                {spec.constraints.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Constraints</span>
                    <div className="assumption-chips">
                      {spec.constraints.map((c, i) => (
                        <span key={i} className={`constraint-chip ${c.type}`}>
                          {c.direction === 'away' ? '✕ ' : '✓ '}{c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {spec.userPointConstraints && spec.userPointConstraints.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">CSV Spatial Constraints</span>
                    {spec.userPointConstraints.map((upc, i) => (
                      <div key={i} className="constraint-panel">
                        <div className="constraint-panel-row">
                          <span className={`constraint-chip ${upc.mode === 'exclude' ? 'exclusion' : 'proximity'}`}>
                            {upc.mode === 'exclude' ? '✕ Excluding' : upc.mode === 'include' ? '✓ Including' : '~ Penalizing'} areas within {(upc.radiusM / 1000).toFixed(1)}km of {upc.label}
                          </span>
                        </div>
                        <div className="constraint-panel-meta">
                          Radius: {(upc.radiusM / 1000).toFixed(1)}km ({upc.radiusSource === 'user' ? 'user-specified' : 'auto-inferred'})
                          {onToggleBuffers && (
                            <label className="buffer-toggle">
                              <input type="checkbox" checked={showBuffers} onChange={onToggleBuffers} />
                              Show buffers on map
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {spec.positiveCriteria.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Positive Signals</span>
                    <div className="assumption-chips">
                      {spec.positiveCriteria.map((c, i) => <span key={i} className="constraint-chip proximity">▲ {c}</span>)}
                    </div>
                  </div>
                )}
                {spec.negativeCriteria.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Negative Signals</span>
                    <div className="assumption-chips">
                      {spec.negativeCriteria.map((c, i) => <span key={i} className="constraint-chip exclusion">▼ {c}</span>)}
                    </div>
                  </div>
                )}
                {spec.parsingNotes.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Notes</span>
                    {spec.parsingNotes.map((n, i) => <p key={i} className="assumption-note">{n}</p>)}
                  </div>
                )}

                {/* Sources */}
                <div className="assumption-section">
                  <span className="assumption-label">Data Sources</span>
                  {result.grounding_sources.map((s, i) => (
                    <div key={i} className="source-row">
                      <a href={s.uri} target="_blank" rel="noopener noreferrer" className="source-link">{s.title}</a>
                      <span className="source-reliability">{s.reliability}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Heatmap layer toggles */}
        {poiTypes.length > 0 && (
          <div className="drawer-layers">
            {poiTypes.map(t => (
              <button
                key={t}
                className={`drawer-layer-btn ${heatmapType === t ? 'active' : ''}`}
                onClick={() => onHeatmapChange(heatmapType === t ? null : t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        )}

        {/* Comparison chart */}
        {selectedLocations.length >= 1
          ? <ComparisonChart locations={selectedLocations} />
          : <ComparisonChart locations={ranked.filter(l => !l.excluded).slice(0, 3)} />}

        {/* Location cards */}
        <div className="drawer-locations">
          {ranked.map((loc, index) => {
            const isSelected = selectedLocations.some(sl => sl.name === loc.name);
            const isExpanded = expandedLoc === loc.name;
            const scoreClass = loc.excluded ? 'score-excluded' : loc.mcda_score >= 7.5 ? 'score-high' : loc.mcda_score >= 5 ? 'score-mid' : 'score-low';

            return (
              <div key={loc.name} className={`drawer-loc ${isSelected ? 'drawer-loc-selected' : ''} ${loc.excluded ? 'drawer-loc-excluded' : ''}`}>
                <div className="drawer-loc-header" onClick={() => onSelectLocation(loc)} role="button" tabIndex={0}>
                  <div className="drawer-loc-rank">#{index + 1}</div>
                  <div className="drawer-loc-info">
                    <div className="drawer-loc-name">
                      {loc.name}
                      {loc.excluded && <span className="excluded-badge">EXCLUDED</span>}
                    </div>
                    <div className="drawer-loc-coords">{loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}</div>
                  </div>
                  <div className={`drawer-loc-score ${scoreClass}`}>{loc.mcda_score.toFixed(1)}</div>
                  <button
                    className="drawer-expand"
                    onClick={(e) => { e.stopPropagation(); setExpandedLoc(isExpanded ? null : loc.name); }}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                </div>

                <p className="drawer-loc-reasoning">{loc.reasoning}</p>

                {isExpanded && (
                  <div className="drawer-loc-detail">
                    {/* Exclusion checks */}
                    {loc.exclusions.length > 0 && (
                      <div className="drawer-exclusions">
                        {loc.exclusions.map((ex, ei) => (
                          <div key={ei} className={`exclusion-item ${ex.passed ? 'exclusion-pass' : 'exclusion-fail'}`}>
                            <span>{ex.passed ? '✓' : '✕'} {ex.rule}</span>
                            <EvidenceTag basis={ex.evidenceBasis} />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Criteria */}
                    <div className="drawer-criteria">
                      {loc.criteria_breakdown.map((c, ci) => (
                        <div key={ci} className="drawer-criterion">
                          <div className="criterion-row">
                            <DirectionIcon direction={c.direction} />
                            <span className="criterion-name">{c.name}</span>
                            <EvidenceTag basis={c.evidenceBasis} />
                            <span className="criterion-score">{c.score.toFixed(1)}</span>
                          </div>
                          <div className="criterion-bar-track">
                            <div className={`criterion-bar-fill ${c.direction === 'negative' ? 'bar-negative' : 'bar-positive'}`} style={{ width: `${c.score * 10}%` }} />
                          </div>
                          <div className="criterion-meta">
                            <span className="criterion-raw">raw: {c.rawValue}</span>
                            <span className="criterion-weight-label">w: {c.weight.toFixed(2)}</span>
                            <input
                              type="range" min="0" max="0.5" step="0.05" value={c.weight}
                              onChange={(e) => onWeightChange(c.name, parseFloat(e.target.value))}
                              className="criterion-slider"
                            />
                          </div>
                          <p className="criterion-justification">{c.justification}</p>
                        </div>
                      ))}
                    </div>

                    {/* OSM Signals */}
                    <div className="drawer-signals">
                      <div className="signals-title">Observed OSM Signals</div>
                      <div className="signals-grid">
                        {Object.entries(loc.osmSignals).map(([key, val]) => (
                          <div key={key} className="signal-item">
                            <span className="signal-key">{key.replace(/_/g, ' ')}</span>
                            <span className="signal-val">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
