import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { LocationData, HeatmapType, UserPoint, HexGridCell, CatchmentOutline } from '../types';
import { config } from '../config';
import {
  toLngLatRing, circleRingLngLat, boundsOfLatLng, stretch, rampColor,
} from '../services/mapGeo';
import { loadMapConfig } from '../services/mapConfig';

/**
 * v1.12.0 — migrated from Leaflet (CDN globals) to Mapbox GL JS.
 *
 * Two structural differences drive the shape of this file:
 *
 * 1. STYLE RELOADS WIPE LAYERS. Calling map.setStyle() (the basemap picker)
 *    destroys every custom source and layer. Leaflet kept them. So all data
 *    layers are (re)built by one idempotent installer that runs on 'load' AND
 *    on every 'style.load'; `styleEpoch` bumps to re-fire the data effects.
 *    Markers are DOM overlays and survive style swaps, so they are managed
 *    separately.
 *
 * 2. HUNDREDS OF POLYGONS BECOME ONE SOURCE. The Leaflet build created one
 *    L.polygon per H3 cell. Here the whole grid is a single GeoJSON source
 *    coloured by a data-driven paint expression on a per-feature `fill`
 *    property, so recolouring on a factor toggle or weight change is a GPU
 *    paint update instead of rebuilding the layer tree.
 *
 * Coordinate order is handled exclusively in services/mapGeo (Leaflet is
 * [lat,lng]; Mapbox is [lng,lat]) — never inline here.
 */

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
  /** v1.6.7 — h3 → rank (1 = best) over eligible cells, under current weights */
  cellRanks?: { ranks: Record<string, number>; total: number };
  /** v1.6.7 — screening-basis top-X re-selected under custom weights (unverified) */
  screeningCandidates?: { h3: string; lat: number; lng: number; score: number; rank: number }[];
  studyAreaBoundary?: [number, number][];        // [lat,lng] ring of the AOI
}

const CATCHMENT_COLORS: Record<string, string> = { walk: '#059669', drive: '#7c3aed' };

// Source / layer ids — kept in one place so the installer and the updaters agree.
const SRC = {
  hex: 'sg-hex', aoi: 'sg-aoi', catchment: 'sg-catchment',
  radius: 'sg-radius', buffer: 'sg-buffer',
} as const;
const LYR = {
  hexFill: 'sg-hex-fill', aoiLine: 'sg-aoi-line', catchmentLine: 'sg-catchment-line',
  radiusLine: 'sg-radius-line', radiusFill: 'sg-radius-fill',
  bufferLine: 'sg-buffer-line', bufferFill: 'sg-buffer-fill',
} as const;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Ranked candidate pin — same markup/CSS classes as the Leaflet build so the
 *  existing pin styling and the permanent label carry over unchanged. */
function buildMarkerEl(
  rank: number, isSelected: boolean, excluded: boolean, raw: boolean,
  name: string, score: number,
): HTMLDivElement {
  const color = excluded ? '#94a3b8' : raw ? '#64748b' : isSelected ? '#1d4ed8' : '#059669';
  const bgColor = excluded ? '#f1f5f9' : raw ? '#e2e8f0' : isSelected ? '#dbeafe' : '#d1fae5';
  const glyph = excluded ? '✕' : raw ? '?' : String(rank);
  const headGlyph = excluded ? '✕' : raw ? '?' : `#${rank}`;
  const excludedLabel = excluded
    ? ' <span style="color:#ef4444;font-size:9px">[EXCLUDED]</span>'
    : raw ? ' <span style="color:#64748b;font-size:9px">[RAW — NOT RECOMMENDED]</span>' : '';

  const el = document.createElement('div');
  el.className = 'sg-marker';
  // vNext (v1.8.0) — zone-centroid honesty: the pin marks the H3 cell's
  // representative point, never an exact site or address (§6.5).
  el.innerHTML =
    `<div class="sg-tooltip-container sg-marker-label">` +
      `<div class="sg-tooltip"><strong>${headGlyph}</strong> ${name}${excludedLabel}<br/>` +
      `<span class="sg-tooltip-score">${score}/10</span><br/>` +
      `<span style="font-size:9px;color:#64748b">Investigation-zone centroid (approximate)</span></div>` +
    `</div>` +
    `<div class="sg-marker-pin" style="--marker-color: ${color}; --marker-bg: ${bgColor}">` +
      `<span class="sg-marker-rank">${glyph}</span>` +
    `</div>`;
  return el;
}

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
  cellRanks,
  screeningCandidates = [],
  studyAreaBoundary,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const userMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const screeningMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const hoverPopupRef = useRef<mapboxgl.Popup | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHexGrid, setShowHexGrid] = useState(true);
  const [showCatchments, setShowCatchments] = useState(true);
  // Bumped on every style (re)load so the data effects re-install their layers.
  const [styleEpoch, setStyleEpoch] = useState(0);

  // v1.12.0 — the token is fetched from the engine at runtime (never bundled),
  // so map creation waits for it. null = still loading, '' = unavailable.
  const [mapboxToken, setMapboxToken] = useState<string | null>(null);
  const [tokenRejected, setTokenRejected] = useState(false);
  useEffect(() => {
    let alive = true;
    loadMapConfig().then(cfg => {
      if (!alive) return;
      setMapboxToken(cfg.token);
      setTokenRejected(cfg.rejected);
    });
    return () => { alive = false; };
  }, []);

  const tokenLoading = mapboxToken === null;
  const tokenMissing = mapboxToken === '';

  /** Create every source + layer this map uses, empty. Idempotent: safe to call
   *  again after a style swap, which destroys them all. */
  const installLayers = useCallback((map: mapboxgl.Map) => {
    const addSource = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
    };
    Object.values(SRC).forEach(addSource);

    if (!map.getLayer(LYR.hexFill)) {
      map.addLayer({
        id: LYR.hexFill, type: 'fill', source: SRC.hex,
        paint: {
          // Colour and opacity are carried per-feature so the whole grid
          // recolours as one GPU paint update, not a layer rebuild.
          'fill-color': ['get', 'fill'],
          'fill-opacity': ['get', 'opacity'],
        },
      });
    }
    if (!map.getLayer(LYR.radiusFill)) {
      map.addLayer({
        id: LYR.radiusFill, type: 'fill', source: SRC.radius,
        paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: LYR.radiusLine, type: 'line', source: SRC.radius,
        paint: { 'line-color': '#1d4ed8', 'line-width': 1.5, 'line-dasharray': [6, 4] },
      });
    }
    if (!map.getLayer(LYR.bufferFill)) {
      map.addLayer({
        id: LYR.bufferFill, type: 'fill', source: SRC.buffer,
        paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.05 },
      });
      map.addLayer({
        id: LYR.bufferLine, type: 'line', source: SRC.buffer,
        paint: { 'line-color': '#ef4444', 'line-width': 1, 'line-dasharray': [4, 3] },
      });
    }
    if (!map.getLayer(LYR.catchmentLine)) {
      map.addLayer({
        id: LYR.catchmentLine, type: 'line', source: SRC.catchment,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-dasharray': ['case', ['==', ['get', 'mode'], 'drive'], ['literal', [8, 5]], ['literal', [1, 0]]],
        },
      });
    }
    if (!map.getLayer(LYR.aoiLine)) {
      map.addLayer({
        id: LYR.aoiLine, type: 'line', source: SRC.aoi,
        paint: { 'line-color': '#475569', 'line-width': 1.5, 'line-dasharray': [5, 5] },
      });
    }
  }, []);

  /**
   * v1.12.2 — BUG FIX: this used to be
   *   `if (!map || !map.isStyleLoaded()) return;`
   * which DROPPED the payload whenever the style happened to be mid-settle.
   * A finished analysis pushes `hexGrid` in as a new prop exactly once; if that
   * instant collided with style loading, the grid was discarded and nothing
   * ever retried it — `hexGrid` never changes again and `styleEpoch` does not
   * bump — so the H3 surface simply never appeared over the basemap.
   *
   * Every payload is now remembered and re-applied once the style is ready, so
   * the last write always wins regardless of arrival timing.
   */
  const pendingRef = useRef<Record<string, GeoJSON.FeatureCollection>>({});
  /** The style URL currently applied — see the basemap-swap effect. */
  const appliedStyleRef = useRef<string | null>(null);

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    pendingRef.current[id] = data;               // always keep the latest
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;    // flushed by installLayers()
    const src = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
    if (src) src.setData(data);
  }, []);

  /** Re-apply every buffered payload — after first load and after each style swap. */
  const flushPending = useCallback((map: mapboxgl.Map) => {
    for (const [id, data] of Object.entries(pendingRef.current)) {
      const src = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    }
  }, []);

  // ── Initialise map ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !mapboxToken) return;

    mapboxgl.accessToken = mapboxToken;
    const bm = config.basemaps.find(b => b.id === basemapId) ?? config.basemaps[0];

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: bm.style,
      center: [config.map.defaultCenter[1], config.map.defaultCenter[0]],  // [lng,lat]
      zoom: config.map.defaultZoom,
      // v1.12.1 — compact attribution: an (i) that expands on click. Mapbox's
      // terms require attribution to stay visible, and the inherited mobile CSS
      // used to hide the corner outright (acceptable for OSM/CARTO, not here).
      attributionControl: false,
    });
    appliedStyleRef.current = bm.style;
    // v1.12.1 — the full native Mapbox control set. v1.12.0 passed
    // showCompass:false, which reduced NavigationControl to a bare +/- pair
    // visually indistinguishable from the Leaflet control it replaced — the
    // migration's capabilities were invisible. The compass exposes what GL JS
    // actually adds over raster Leaflet: drag-rotate and pitch, with a
    // click-to-reset-north affordance. Scale matters for a spatial-screening
    // tool (a zone is only meaningful against a distance reference), and
    // fullscreen is genuinely useful when reading a dense hex surface.
    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }),
      'top-right',
    );
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(
      new mapboxgl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
      'bottom-left',
    );
    map.on('click', () => onDeselectAll());
    // installLayers() recreates the (empty) sources; flushPending() then
    // re-applies whatever data has arrived so far — this is what makes a grid
    // that landed while the style was busy actually show up, and what restores
    // it after a basemap swap wipes every custom source.
    const ready = () => { installLayers(map); flushPending(map); setStyleEpoch(e => e + 1); };
    map.on('load', ready);
    // Fires after every setStyle() — the style reload wiped our layers, rebuild.
    map.on('style.load', ready);

    mapRef.current = map;
    setTimeout(() => map.resize(), 100);

    return () => {
      markersRef.current.forEach(m => m.remove());
      userMarkersRef.current.forEach(m => m.remove());
      screeningMarkersRef.current.forEach(m => m.remove());
      markersRef.current = []; userMarkersRef.current = []; screeningMarkersRef.current = [];
      hoverPopupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // Re-runs once the token arrives; guarded above so it builds the map once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapboxToken]);

  // ── Basemap swap: setStyle wipes layers; 'style.load' reinstalls them ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bm = config.basemaps.find(b => b.id === basemapId) ?? config.basemaps[0];
    // v1.12.2 — track what we actually applied. The previous guard inspected
    // `getStyle()?.sprite`, which says nothing about WHICH of our styles is
    // live, so the effect both fired a redundant setStyle on mount (the initial
    // style is already basemapId's) and could skip a real swap.
    if (appliedStyleRef.current === bm.style) return;
    appliedStyleRef.current = bm.style;
    map.setStyle(bm.style);
  }, [basemapId]);

  // ── Ranked candidate markers + fly-to ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (locations.length === 0) {
      map.flyTo({
        center: [config.map.defaultCenter[1], config.map.defaultCenter[0]],
        zoom: config.map.defaultZoom, duration: 1000,
      });
      return;
    }

    const ranked = [...locations].sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      return b.mcda_score - a.mcda_score;
    });

    const pts: { lat: number; lng: number }[] = [];
    let visibleRank = 0;
    for (const loc of ranked) {
      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      if (!loc.excluded) visibleRank++;
      const displayRank = loc.excluded ? 0 : visibleRank;
      const isSelected = selectedLocations.some(sl => sl.name === loc.name);
      const raw = recommendationWithheld && !loc.excluded;

      const el = buildMarkerEl(displayRank, isSelected, loc.excluded, raw, loc.name, loc.mcda_score);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelectLocation(loc); });

      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .addTo(map);
      markersRef.current.push(marker);
      pts.push({ lat, lng });
    }

    // Search-radius rings around selected zones (Leaflet's L.circle had no
    // Mapbox equivalent — emitted as real polygons instead).
    const radiusFeatures: GeoJSON.Feature[] = [];
    for (const sl of selectedLocations) {
      const ring = circleRingLngLat(Number(sl.lat), Number(sl.lng), sl.searchRadiusM || 1000);
      if (ring) {
        radiusFeatures.push({
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }
    setData(SRC.radius, { type: 'FeatureCollection', features: radiusFeatures });

    const selPts = selectedLocations
      .map(l => ({ lat: Number(l.lat), lng: Number(l.lng) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const focus = selPts.length > 0 ? selPts : pts;
    if (focus.length === 1) {
      map.flyTo({ center: [focus[0].lng, focus[0].lat], zoom: 13, duration: 1000 });
    } else if (focus.length > 1) {
      const b = boundsOfLatLng(focus);
      if (b) map.fitBounds(b, { padding: 60, duration: 1200 });
    }
  }, [locations, selectedLocations, onSelectLocation, recommendationWithheld, styleEpoch, setData]);

  // ── Study-area (AOI) boundary outline (v1.0.3) ──
  useEffect(() => {
    const ring = toLngLatRing(studyAreaBoundary);
    setData(SRC.aoi, ring
      ? { type: 'FeatureCollection', features: [{
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [ring] },
        }] }
      : EMPTY);
  }, [studyAreaBoundary, styleEpoch, setData]);

  // ── Hex suitability surface (v2 engine choropleth) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!showHexGrid || !hexGrid || hexGrid.length === 0) {
      setData(SRC.hex, EMPTY);
      return;
    }

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

    const features: GeoJSON.Feature[] = [];
    for (const cell of hexGrid) {
      const ring = toLngLatRing(cell.boundary as [number, number][]);
      if (!ring) continue;
      const v = scoreOf(cell);
      const hasVal = typeof v === 'number';
      const t = hasVal ? stretch(v!, lo, hi) : 0;
      // v1.6.4 — when the analyst review withholds the recommendation, the
      // suitability surface must not keep advertising confident green/red
      // gradation (user-reported contradiction). Render it grey and label
      // it as context-only; relative shading is kept faint for orientation.
      const fill = cell.excluded || !hasVal
        ? '#64748b'
        : recommendationWithheld ? '#94a3b8' : rampColor(t);
      const opacity = cell.excluded
        ? 0.22
        : !hasVal
          ? 0.12
          : recommendationWithheld ? 0.10 + t * 0.20 : 0.30 + t * 0.45;

      const finalTag = (cell as any).refinedCandidate ? ' — FINAL refined score (chosen candidate)' : '';
      const label = cell.excluded
        ? 'Excluded zone'
        : !hasVal
          ? `${factor}: no data here`
          : recommendationWithheld
            ? `Screening value ${v!.toFixed(1)}/10 — context only: this result was flagged unreliable, no recommendation is made`
            : `${factor || 'Overall suitability'}: ${v!.toFixed(1)}/10${factor ? '' : finalTag}${
                !factor && cellRanks?.ranks?.[cell.h3]
                  ? ` — rank ${cellRanks.ranks[cell.h3]} of ${cellRanks.total} eligible cells`
                  : ''}`;

      features.push({
        type: 'Feature',
        properties: { fill, opacity, label },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
    setData(SRC.hex, { type: 'FeatureCollection', features });
  }, [hexGrid, showHexGrid, heatmapType, recommendationWithheld, cellRanks, styleEpoch, setData]);

  // ── Hex hover tooltip (Leaflet bindTooltip{sticky} equivalent) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const popup = new mapboxgl.Popup({
      closeButton: false, closeOnClick: false, className: 'sg-tooltip-container',
    });
    hoverPopupRef.current = popup;

    const onMove = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      popup.setLngLat(e.lngLat).setText(String(f.properties?.label ?? '')).addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    };
    map.on('mousemove', LYR.hexFill, onMove);
    map.on('mouseleave', LYR.hexFill, onLeave);
    return () => {
      map.off('mousemove', LYR.hexFill, onMove);
      map.off('mouseleave', LYR.hexFill, onLeave);
      popup.remove();
    };
  }, [styleEpoch]);

  // ── v1.6.7: screening-basis top-X under custom weights (amber, unverified) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    screeningMarkersRef.current.forEach(m => m.remove());
    screeningMarkersRef.current = [];
    if (!screeningCandidates || screeningCandidates.length === 0) return;

    screeningCandidates.forEach((c, i) => {
      const el = document.createElement('div');
      el.innerHTML =
        `<div title="Top ${i + 1} under YOUR weights — screening basis only (score ${c.score.toFixed(1)}/10, grid rank ${c.rank}). Not yet verified with travel-time / routing / Places data." ` +
        `style="width:26px;height:26px;border-radius:50%;background:#fffbeb;border:2.5px dashed #d97706;color:#92400e;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.3)">${i + 1}</div>`;
      const m = new mapboxgl.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(map);
      screeningMarkersRef.current.push(m);
    });
  }, [screeningCandidates, styleEpoch]);

  // ── Catchment isochrone outlines (v2 engine, selected location) ──
  useEffect(() => {
    if (!showCatchments || !catchments || catchments.length === 0) {
      setData(SRC.catchment, EMPTY);
      return;
    }
    // Show catchments for the selected location, else for the #1 ranked one
    const focusName = selectedLocations[0]?.name || locations.filter(l => !l.excluded)[0]?.name;
    if (!focusName) { setData(SRC.catchment, EMPTY); return; }

    const features: GeoJSON.Feature[] = [];
    for (const c of catchments.filter(c => c.locationName === focusName)) {
      const ring = toLngLatRing(c.polygon as [number, number][]);
      if (!ring) continue;
      features.push({
        type: 'Feature',
        properties: { color: CATCHMENT_COLORS[c.mode] || '#1d4ed8', mode: c.mode },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
    setData(SRC.catchment, { type: 'FeatureCollection', features });
  }, [catchments, showCatchments, selectedLocations, locations, styleEpoch, setData]);

  // ── User-uploaded points layer ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    userMarkersRef.current.forEach(m => m.remove());
    userMarkersRef.current = [];

    if (userPoints.length === 0) { setData(SRC.buffer, EMPTY); return; }

    const bufferFeatures: GeoJSON.Feature[] = [];
    const pts: { lat: number; lng: number }[] = [];
    for (const pt of userPoints) {
      const lat = Number(pt.lat);
      const lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const el = document.createElement('div');
      el.className = 'sg-marker';
      el.innerHTML = `<div class="user-marker-dot"${pt.name ? ` title="${pt.name}"` : ''}></div>`;
      userMarkersRef.current.push(
        new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map),
      );
      pts.push({ lat, lng });

      if (showBuffers && bufferRadiusM) {
        const ring = circleRingLngLat(lat, lng, bufferRadiusM);
        if (ring) {
          bufferFeatures.push({
            type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [ring] },
          });
        }
      }
    }
    setData(SRC.buffer, { type: 'FeatureCollection', features: bufferFeatures });

    // If no analysis locations yet, fit to user points
    if (locations.length === 0 && pts.length > 0) {
      const b = boundsOfLatLng(pts);
      if (b) map.fitBounds(b, { padding: 60, duration: 1000 });
    }
  }, [userPoints, showBuffers, bufferRadiusM, locations.length, styleEpoch, setData]);

  return (
    <div className="sg-map-wrapper">
      <div ref={containerRef} className="sg-map" id="map-container" />

      {tokenLoading && (
        <div className="sg-map-token-missing">
          <span>Loading map…</span>
        </div>
      )}
      {tokenMissing && (
        <div className="sg-map-token-missing">
          <strong>Map unavailable</strong>
          <span>
            {tokenRejected
              ? 'The configured Mapbox token is not a public (pk.) token, so it was refused.'
              : 'No Mapbox token is configured on the analysis engine (MAPBOX_TOKEN).'}
          </span>
        </div>
      )}

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
