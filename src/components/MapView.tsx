import React, { useEffect, useRef, useState } from 'react';
import type { LocationData, HeatmapType, UserPoint, HexGridCell, CatchmentOutline } from '../types';
import { config } from '../config';

declare const L: any;

export type BasemapId = typeof config.basemaps[number]['id'];

interface MapViewProps {
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  onDeselectAll: () => void;
  heatmapType: HeatmapType;
  userPoints?: UserPoint[];
  showBuffers?: boolean;
  bufferRadiusM?: number;
  basemapId?: BasemapId;
  onBasemapChange?: (id: BasemapId) => void;
  /** v2 engine layers (conversational analyses) */
  hexGrid?: HexGridCell[];
  catchments?: CatchmentOutline[];
  /** Spatial Reliability Upgrade v1.0.3 */
  recommendationWithheld?: boolean;             // grey out pins, label as raw candidates
  studyAreaBoundary?: [number, number][];        // [lat,lng] ring of the AOI
}

/** Normalised 0..1 (0 = least, 1 = most favourable) → red→amber→green ramp. */
const rampColor = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 130)}, 80%, 46%)`;

const CATCHMENT_COLORS: Record<string, string> = { walk: '#059669', drive: '#7c3aed' };

const getMarkerIcon = (rank: number, isSelected: boolean, excluded: boolean, raw = false) => {
  // raw = recommendation withheld → render as a neutral "raw candidate", never a
  // green recommendation pin (v1.0.3 UI fix: pins must not contradict the banner).
  const color = excluded ? '#94a3b8' : raw ? '#64748b' : isSelected ? '#1d4ed8' : '#059669';
  const bgColor = excluded ? '#f1f5f9' : raw ? '#e2e8f0' : isSelected ? '#dbeafe' : '#d1fae5';
  const glyph = excluded ? '✕' : raw ? '?' : rank;

  return L.divIcon({
    className: 'sg-marker',
    html: `<div class="sg-marker-pin" style="--marker-color: ${color}; --marker-bg: ${bgColor}">
      <span class="sg-marker-rank">${glyph}</span>
    </div>`,
    iconSize: [36, 44],
    iconAnchor: [18, 44],
    popupAnchor: [0, -44],
  });
};

export const MapView: React.FC<MapViewProps> = ({
  locations,
  selectedLocations,
  onSelectLocation,
  onDeselectAll,
  heatmapType,
  userPoints = [],
  showBuffers = true,
  bufferRadiusM,
  basemapId = 'light',
  onBasemapChange,
  hexGrid,
  catchments,
  recommendationWithheld = false,
  studyAreaBoundary,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any>(null);
  const userLayerRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);
  const hexLayerRef = useRef<any>(null);
  const catchmentLayerRef = useRef<any>(null);
  const aoiLayerRef = useRef<any>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHexGrid, setShowHexGrid] = useState(true);
  const [showCatchments, setShowCatchments] = useState(true);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initialBasemap = config.basemaps.find(b => b.id === basemapId) ?? config.basemaps[0];

    const map = L.map(containerRef.current, {
      center: config.map.defaultCenter,
      zoom: config.map.defaultZoom,
      zoomControl: false,
    });

    const tl = L.tileLayer(initialBasemap.url, {
      attribution: initialBasemap.attribution,
      subdomains: initialBasemap.subdomains || 'abc',
      maxZoom: 19,
    });
    tl.addTo(map);
    tileLayerRef.current = tl;

    L.control.zoom({ position: 'topright' }).addTo(map);
    map.on('click', onDeselectAll);

    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);

    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      if (mapRef.current) {
        mapRef.current.stop();
        mapRef.current.remove();
        mapRef.current = null;
        tileLayerRef.current = null;
      }
    };
  }, []);

  // Swap tile layer when basemap changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bm = config.basemaps.find(b => b.id === basemapId) ?? config.basemaps[0];
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const tl = L.tileLayer(bm.url, {
      attribution: bm.attribution,
      subdomains: bm.subdomains || 'abc',
      maxZoom: 19,
    });
    tl.addTo(map);
    tl.bringToBack();
    tileLayerRef.current = tl;
  }, [basemapId]);

  // Update markers
  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    map.stop();
    markers.clearLayers();

    if (locations.length === 0) {
      map.flyTo(config.map.defaultCenter, config.map.defaultZoom, { animate: true, duration: 1 });
      return;
    }

    const bounds: [number, number][] = [];

    // Sort: non-excluded first by score
    const ranked = [...locations].sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      return b.mcda_score - a.mcda_score;
    });

    let visibleRank = 0;
    ranked.forEach((loc) => {
      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      if (!loc.excluded) visibleRank++;
      const displayRank = loc.excluded ? 0 : visibleRank;
      const isSelected = selectedLocations.some(sl => sl.name === loc.name);
      const raw = recommendationWithheld && !loc.excluded;
      const icon = getMarkerIcon(displayRank, isSelected, loc.excluded, raw);

      try {
        const marker = L.marker([lat, lng], { icon });
        const excludedLabel = loc.excluded
          ? ' <span style="color:#ef4444;font-size:9px">[EXCLUDED]</span>'
          : raw ? ' <span style="color:#64748b;font-size:9px">[RAW — NOT RECOMMENDED]</span>' : '';
        const headGlyph = loc.excluded ? '✕' : raw ? '?' : `#${displayRank}`;
        marker.bindTooltip(
          `<div class="sg-tooltip"><strong>${headGlyph}</strong> ${loc.name}${excludedLabel}<br/><span class="sg-tooltip-score">${loc.mcda_score}/10</span></div>`,
          { permanent: true, direction: 'top', className: 'sg-tooltip-container', offset: [0, -44] }
        );
        marker.on('click', (e: any) => {
          L.DomEvent.stopPropagation(e);
          onSelectLocation(loc);
        });
        markers.addLayer(marker);
        bounds.push([lat, lng]);
      } catch { /* skip invalid marker */ }
    });

    // Selected location search radius
    selectedLocations.forEach(sl => {
      const lat = Number(sl.lat);
      const lng = Number(sl.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const radius = sl.searchRadiusM || 1000;
      try {
        L.circle([lat, lng], {
          radius,
          color: '#1d4ed8',
          fillColor: '#1d4ed8',
          fillOpacity: 0.06,
          weight: 1.5,
          dashArray: '6 4',
        }).addTo(markers);
      } catch { /* skip */ }
    });

    // Fit bounds
    const selCoords = selectedLocations
      .map(l => [Number(l.lat), Number(l.lng)] as [number, number])
      .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));

    if (selCoords.length === 1) {
      map.flyTo(selCoords[0], 13, { animate: true, duration: 1 });
    } else if (selCoords.length > 1) {
      map.flyToBounds(selCoords, { padding: [60, 60], animate: true, duration: 1.2 });
    } else if (bounds.length === 1) {
      map.flyTo(bounds[0], 13, { animate: true, duration: 1 });
    } else if (bounds.length > 1) {
      map.flyToBounds(bounds, { padding: [60, 60], animate: true, duration: 1.2 });
    }
  }, [locations, selectedLocations, onSelectLocation, heatmapType, recommendationWithheld]);

  // ── Study-area (AOI) boundary outline (v1.0.3) ──
  // Draw the resolved study area so the user can SEE whether the spatial area is
  // wrong (e.g. a buffered chord across both riverbanks). Excluded water/rail/ghat
  // cells are already greyed in the hex layer below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (aoiLayerRef.current) {
      map.removeLayer(aoiLayerRef.current);
      aoiLayerRef.current = null;
    }
    if (!studyAreaBoundary || studyAreaBoundary.length < 3) return;
    try {
      const poly = L.polygon(studyAreaBoundary, {
        color: '#475569',
        weight: 1.5,
        dashArray: '5 5',
        fill: false,
        interactive: false,
      });
      poly.bindTooltip('Study area (AOI)', { sticky: true, className: 'sg-tooltip-container' });
      poly.addTo(map);
      aoiLayerRef.current = poly;
    } catch { /* skip */ }
  }, [studyAreaBoundary]);

  // ── Hex suitability surface (v2 engine choropleth) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (hexLayerRef.current) {
      map.removeLayer(hexLayerRef.current);
      hexLayerRef.current = null;
    }
    if (!showHexGrid || !hexGrid || hexGrid.length === 0) return;

    // Which value are we colouring? Overall composite, or one factor's per-hex
    // score (direction already applied → higher = more favourable for every factor).
    const factor = heatmapType || null;
    const scoreOf = (cell: HexGridCell): number | undefined =>
      factor ? cell.layerScores?.[factor] : cell.score;

    // Contrast-stretch across the actual value range so mid-range grids don't
    // wash out to a single colour (the old "everything looks green" problem).
    const vals = hexGrid
      .filter(c => !c.excluded)
      .map(scoreOf)
      .filter((v): v is number => typeof v === 'number');
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 10;
    const span = hi - lo > 0.1 ? hi - lo : 1;

    const renderer = L.canvas({ padding: 0.3 });
    const group = L.layerGroup();
    for (const cell of hexGrid) {
      if (!Array.isArray(cell.boundary) || cell.boundary.length < 3) continue;
      const v = scoreOf(cell);
      const hasVal = typeof v === 'number';
      const t = hasVal ? Math.max(0, Math.min(1, (v! - lo) / span)) : 0;  // 0=worst .. 1=best in view
      try {
        // v1.6.4 — when the analyst review withholds the recommendation, the
        // suitability surface must not keep advertising confident green/red
        // gradation (user-reported contradiction). Render it grey and label
        // it as context-only; relative shading is kept faint for orientation.
        const poly = L.polygon(cell.boundary, {
          renderer,
          stroke: false,
          fillColor: cell.excluded || !hasVal
            ? '#64748b'
            : recommendationWithheld ? '#94a3b8' : rampColor(t),
          fillOpacity: cell.excluded
            ? 0.22
            : !hasVal
              ? 0.12
              : recommendationWithheld ? 0.10 + t * 0.20 : 0.30 + t * 0.45,
          interactive: true,
        });
        const finalTag = (cell as any).refinedCandidate ? ' — FINAL refined score (chosen candidate)' : '';
        const label = cell.excluded
          ? 'Excluded zone'
          : !hasVal
            ? `${factor}: no data here`
            : recommendationWithheld
              ? `Screening value ${v!.toFixed(1)}/10 — context only: this result was flagged unreliable, no recommendation is made`
              : `${factor || 'Overall suitability'}: ${v!.toFixed(1)}/10${factor ? '' : finalTag}`;
        poly.bindTooltip(label, { sticky: true, direction: 'top', className: 'sg-tooltip-container' });
        group.addLayer(poly);
      } catch { /* skip malformed cell */ }
    }
    group.addTo(map);
    hexLayerRef.current = group;
  }, [hexGrid, showHexGrid, heatmapType, recommendationWithheld]);

  // ── Catchment isochrone outlines (v2 engine, selected location) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (catchmentLayerRef.current) {
      map.removeLayer(catchmentLayerRef.current);
      catchmentLayerRef.current = null;
    }
    if (!showCatchments || !catchments || catchments.length === 0) return;

    // Show catchments for the selected location, else for the #1 ranked one
    const focusName = selectedLocations[0]?.name || locations.filter(l => !l.excluded)[0]?.name;
    if (!focusName) return;
    const relevant = catchments.filter(c => c.locationName === focusName);
    if (relevant.length === 0) return;

    const group = L.layerGroup();
    for (const c of relevant) {
      if (!Array.isArray(c.polygon) || c.polygon.length < 3) continue;
      try {
        const poly = L.polygon(c.polygon, {
          color: CATCHMENT_COLORS[c.mode] || '#1d4ed8',
          weight: 2,
          dashArray: c.mode === 'drive' ? '8 5' : undefined,
          fill: false,
          interactive: true,
        });
        poly.bindTooltip(
          `${c.minutes}-min ${c.mode} — ${c.layerName}`,
          { sticky: true, direction: 'top', className: 'sg-tooltip-container' },
        );
        group.addLayer(poly);
      } catch { /* skip */ }
    }
    group.addTo(map);
    catchmentLayerRef.current = group;
  }, [catchments, showCatchments, selectedLocations, locations]);

  // User-uploaded points layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (userLayerRef.current) {
      map.removeLayer(userLayerRef.current);
      userLayerRef.current = null;
    }

    if (userPoints.length === 0) return;

    const group = L.layerGroup();

    const userIcon = L.divIcon({
      className: 'sg-marker',
      html: `<div class="user-marker-dot"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    for (const pt of userPoints) {
      const lat = Number(pt.lat);
      const lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const marker = L.marker([lat, lng], { icon: userIcon, interactive: false });
      if (pt.name) {
        marker.bindTooltip(pt.name, { direction: 'top', offset: [0, -8], className: 'sg-tooltip-container' });
      }
      group.addLayer(marker);

      // Buffer circles
      if (showBuffers && bufferRadiusM) {
        try {
          L.circle([lat, lng], {
            radius: bufferRadiusM,
            color: '#ef4444',
            fillColor: '#ef4444',
            fillOpacity: 0.05,
            weight: 1,
            dashArray: '4 3',
            interactive: false,
          }).addTo(group);
        } catch { /* skip */ }
      }
    }

    group.addTo(map);
    userLayerRef.current = group;

    // If no analysis locations yet, fit to user points
    if (locations.length === 0 && userPoints.length > 0) {
      const pts = userPoints
        .map(p => [Number(p.lat), Number(p.lng)] as [number, number])
        .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (pts.length > 0) {
        map.flyToBounds(pts, { padding: [60, 60], animate: true, duration: 1 });
      }
    }
  }, [userPoints, showBuffers, bufferRadiusM, locations.length]);

  return (
    <div className="sg-map-wrapper">
      <div ref={containerRef} className="sg-map" id="map-container" />

      {/* ── Basemap picker ── */}
      <div className="sg-basemap-control">
        <button
          className="sg-basemap-trigger"
          title="Change basemap"
          onClick={() => setPickerOpen(p => !p)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
            <line x1="9" y1="3" x2="9" y2="18"/>
            <line x1="15" y1="6" x2="15" y2="21"/>
          </svg>
          <span>Map</span>
        </button>
        {pickerOpen && (
          <div className="sg-basemap-picker">
            {config.basemaps.map(bm => (
              <button
                key={bm.id}
                className={`sg-basemap-option${basemapId === bm.id ? ' active' : ''}`}
                onClick={() => { onBasemapChange?.(bm.id); setPickerOpen(false); }}
              >
                <span className="sg-basemap-icon">{bm.icon}</span>
                <span className="sg-basemap-label">{bm.label}</span>
                {basemapId === bm.id && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" className="sg-basemap-check">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {(locations.length > 0 || userPoints.length > 0) && (
        <div className="sg-map-legend">
          <div className="sg-legend-title">Map Legend</div>
          {locations.length > 0 && (
            <>
              <div className="sg-legend-item">
                <span className="sg-legend-dot" style={{ background: '#059669' }} /> Candidate
              </div>
              <div className="sg-legend-item">
                <span className="sg-legend-dot" style={{ background: '#1d4ed8' }} /> Selected
              </div>
              <div className="sg-legend-item">
                <span className="sg-legend-dot" style={{ background: '#94a3b8' }} /> Excluded
              </div>
              <div className="sg-legend-item">
                <span className="sg-legend-circle" /> Search Radius
              </div>
            </>
          )}
          {hexGrid && hexGrid.length > 0 && (
            <>
              <label className="sg-legend-item sg-legend-toggle">
                <input type="checkbox" checked={showHexGrid} onChange={e => setShowHexGrid(e.target.checked)} />
                {heatmapType ? heatmapType : 'Overall suitability'}
              </label>
              {showHexGrid && (
                <>
                  <div className="sg-legend-gradient-row">
                    <span className="sg-legend-gradient" />
                    <span className="sg-legend-gradient-labels"><span>low</span><span>high</span></span>
                  </div>
                  <div className="sg-legend-note">
                    {heatmapType
                      ? 'Greener = more favourable for this factor (relative to this area).'
                      : 'Greener = higher overall score (relative to this area).'}
                  </div>
                </>
              )}
            </>
          )}
          {catchments && catchments.length > 0 && (
            <>
              <label className="sg-legend-item sg-legend-toggle">
                <input type="checkbox" checked={showCatchments} onChange={e => setShowCatchments(e.target.checked)} />
                Catchments
              </label>
              {showCatchments && (
                <>
                  <div className="sg-legend-item">
                    <span className="sg-legend-line" style={{ borderColor: '#059669' }} /> Walk isochrone
                  </div>
                  <div className="sg-legend-item">
                    <span className="sg-legend-line sg-legend-line-dashed" style={{ borderColor: '#7c3aed' }} /> Drive isochrone
                  </div>
                </>
              )}
            </>
          )}
          {userPoints.length > 0 && (
            <>
              <div className="sg-legend-item">
                <span className="sg-legend-dot" style={{ background: '#f97316' }} /> User Points
              </div>
              {showBuffers && bufferRadiusM && (
                <div className="sg-legend-item">
                  <span className="sg-legend-circle" style={{ borderColor: '#ef4444' }} /> Buffer Zone
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
