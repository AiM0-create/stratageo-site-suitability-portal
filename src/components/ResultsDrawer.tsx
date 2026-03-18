import React, { useState, useMemo } from 'react';
import type { LocationData, AnalysisResult, HeatmapType } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface ResultsDrawerProps {
  open: boolean;
  onClose: () => void;
  result: AnalysisResult;
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  customWeights: Record<string, number>;
  onWeightChange: (name: string, weight: number) => void;
  heatmapType: HeatmapType;
  onHeatmapChange: (type: HeatmapType) => void;
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

export const ResultsDrawer: React.FC<ResultsDrawerProps> = ({
  open,
  onClose,
  result,
  locations,
  selectedLocations,
  onSelectLocation,
  customWeights,
  onWeightChange,
  heatmapType,
  onHeatmapChange,
}) => {
  const [expandedLoc, setExpandedLoc] = useState<string | null>(locations[0]?.name ?? null);
  const ranked = useMemo(() => [...locations].sort((a, b) => b.mcda_score - a.mcda_score), [locations]);

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

        {/* Heatmap layer toggles */}
        <div className="drawer-layers">
          {(['competitor', 'transport', 'commercial'] as const).map(t => (
            <button
              key={t}
              className={`drawer-layer-btn ${heatmapType === t ? 'active' : ''}`}
              onClick={() => onHeatmapChange(heatmapType === t ? null : t)}
            >
              {t === 'competitor' ? 'Competitors' : t === 'transport' ? 'Transit' : 'Commercial'}
            </button>
          ))}
        </div>

        {/* Comparison chart */}
        {selectedLocations.length >= 1
          ? <ComparisonChart locations={selectedLocations} />
          : <ComparisonChart locations={ranked.slice(0, 3)} />}

        {/* Location cards */}
        <div className="drawer-locations">
          {ranked.map((loc, index) => {
            const isSelected = selectedLocations.some(sl => sl.name === loc.name);
            const isExpanded = expandedLoc === loc.name;
            const scoreClass = loc.mcda_score >= 7.5 ? 'score-high' : loc.mcda_score >= 5 ? 'score-mid' : 'score-low';

            return (
              <div key={loc.name} className={`drawer-loc ${isSelected ? 'drawer-loc-selected' : ''}`}>
                <div className="drawer-loc-header" onClick={() => onSelectLocation(loc)} role="button" tabIndex={0}>
                  <div className="drawer-loc-rank">#{index + 1}</div>
                  <div className="drawer-loc-info">
                    <div className="drawer-loc-name">{loc.name}</div>
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
                    {/* Criteria */}
                    <div className="drawer-criteria">
                      {loc.criteria_breakdown.map((c, ci) => (
                        <div key={ci} className="drawer-criterion">
                          <div className="criterion-row">
                            <span className="criterion-name">{c.name}</span>
                            <span className="criterion-score">{c.score.toFixed(1)}</span>
                          </div>
                          <div className="criterion-bar-track">
                            <div className="criterion-bar-fill" style={{ width: `${c.score * 10}%` }} />
                          </div>
                          <div className="criterion-weight-row">
                            <span className="criterion-weight-label">w: {c.weight.toFixed(2)}</span>
                            <input
                              type="range" min="0" max="1" step="0.05" value={c.weight}
                              onChange={(e) => onWeightChange(c.name, parseFloat(e.target.value))}
                              className="criterion-slider"
                            />
                          </div>
                          <p className="criterion-justification">{c.justification}</p>
                        </div>
                      ))}
                    </div>

                    {/* Details grid */}
                    <div className="drawer-details">
                      <div className="drawer-detail">
                        <span className="detail-label">Footfall</span>
                        <span className="detail-value">{loc.footfall}</span>
                      </div>
                      <div className="drawer-detail">
                        <span className="detail-label">Radius</span>
                        <span className="detail-value">{loc.marketing_radius_km} km</span>
                      </div>
                      {loc.public_transport && (
                        <div className="drawer-detail full">
                          <span className="detail-label">Transit</span>
                          <span className="detail-value">{loc.public_transport}</span>
                        </div>
                      )}
                      <div className="drawer-detail full">
                        <span className="detail-label">Demographics</span>
                        <span className="detail-value">{loc.demographics}</span>
                      </div>
                      <div className="drawer-detail full">
                        <span className="detail-label">Strategy</span>
                        <span className="detail-value">{loc.marketing_strategy}</span>
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
