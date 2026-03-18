import React, { useEffect, useRef } from 'react';
import type { LocationData, HeatmapType, UserPoint } from '../types';
import { config } from '../config';

declare const L: any;

interface MapViewProps {
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  onDeselectAll: () => void;
  heatmapType: HeatmapType;
  userPoints?: UserPoint[];
  showBuffers?: boolean;
  bufferRadiusM?: number;
}

const getMarkerIcon = (rank: number, isSelected: boolean, excluded: boolean) => {
  const color = excluded ? '#94a3b8' : isSelected ? '#1d4ed8' : '#059669';
  const bgColor = excluded ? '#f1f5f9' : isSelected ? '#dbeafe' : '#d1fae5';

  return L.divIcon({
    className: 'sg-marker',
    html: `<div class="sg-marker-pin" style="--marker-color: ${color}; --marker-bg: ${bgColor}">
      <span class="sg-marker-rank">${excluded ? '✕' : rank}</span>
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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any>(null);
  const heatRef = useRef<any>(null);
  const userLayerRef = useRef<any>(null);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: config.map.defaultCenter,
      zoom: config.map.defaultZoom,
      zoomControl: false,
    });

    L.tileLayer(config.map.tileUrl, {
      attribution: config.map.attribution,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.on('click', onDeselectAll);

    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);

    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      if (mapRef.current) {
        mapRef.current.stop();
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Update markers
  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    map.stop();
    markers.clearLayers();
    if (heatRef.current) {
      map.removeLayer(heatRef.current);
      heatRef.current = null;
    }

    if (locations.length === 0) {
      map.flyTo(config.map.defaultCenter, config.map.defaultZoom, { animate: true, duration: 1 });
      return;
    }

    const bounds: [number, number][] = [];
    const heatPoints: [number, number, number][] = [];

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
      const icon = getMarkerIcon(displayRank, isSelected, loc.excluded);

      // Heatmap data
      if (heatmapType && loc.pois) {
        loc.pois.filter(p => p.type === heatmapType).forEach(p => {
          const pLat = Number(p.lat);
          const pLng = Number(p.lng);
          if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
            heatPoints.push([pLat, pLng, 1]);
          }
        });
      }

      try {
        const marker = L.marker([lat, lng], { icon });
        const excludedLabel = loc.excluded ? ' <span style="color:#ef4444;font-size:9px">[EXCLUDED]</span>' : '';
        marker.bindTooltip(
          `<div class="sg-tooltip"><strong>#${loc.excluded ? '✕' : displayRank}</strong> ${loc.name}${excludedLabel}<br/><span class="sg-tooltip-score">${loc.mcda_score}/10</span></div>`,
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

    // Heatmap
    if (heatPoints.length > 0 && typeof L.heatLayer === 'function') {
      try {
        heatRef.current = L.heatLayer(heatPoints, { radius: 25, blur: 15, maxZoom: 15 }).addTo(map);
      } catch { /* skip */ }
    }

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
  }, [locations, selectedLocations, onSelectLocation, heatmapType]);

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
