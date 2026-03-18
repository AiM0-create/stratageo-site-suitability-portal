import React, { useEffect, useRef } from 'react';
import type { LocationData, HeatmapType } from '../types';
import { config } from '../config';

declare const L: any;

interface MapViewProps {
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  onDeselectAll: () => void;
  heatmapType: HeatmapType;
}

const getMarkerIcon = (rank: number, isSelected: boolean) => {
  const color = isSelected ? '#1d4ed8' : '#059669';
  const bgColor = isSelected ? '#dbeafe' : '#d1fae5';

  return L.divIcon({
    className: 'sg-marker',
    html: `<div class="sg-marker-pin" style="--marker-color: ${color}; --marker-bg: ${bgColor}">
      <span class="sg-marker-rank">${rank}</span>
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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any>(null);
  const heatRef = useRef<any>(null);

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

    // Sort by score to get ranks
    const ranked = [...locations].sort((a, b) => b.mcda_score - a.mcda_score);

    ranked.forEach((loc, index) => {
      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const isSelected = selectedLocations.some(sl => sl.name === loc.name);
      const icon = getMarkerIcon(index + 1, isSelected);

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
        marker.bindTooltip(
          `<div class="sg-tooltip"><strong>#${index + 1}</strong> ${loc.name}<br/><span class="sg-tooltip-score">${loc.mcda_score}/10</span></div>`,
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

    // Selected location radius
    selectedLocations.forEach(sl => {
      const lat = Number(sl.lat);
      const lng = Number(sl.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const radius = Number.isFinite(Number(sl.marketing_radius_km)) ? Number(sl.marketing_radius_km) * 1000 : 1000;
      try {
        L.circle([lat, lng], {
          radius,
          color: '#1d4ed8',
          fillColor: '#1d4ed8',
          fillOpacity: 0.08,
          weight: 1.5,
          dashArray: '6 4',
        }).addTo(markers);
      } catch { /* skip */ }
    });

    // Heatmap
    if (heatPoints.length > 0 && typeof L.heatLayer === 'function') {
      const gradient = heatmapType === 'competitor'
        ? { 0.4: '#3b82f6', 0.6: '#06b6d4', 0.8: '#eab308', 1: '#ef4444' }
        : { 0.4: '#8b5cf6', 0.6: '#a855f7', 0.8: '#f472b6', 1: '#fbbf24' };
      try {
        heatRef.current = L.heatLayer(heatPoints, { radius: 25, blur: 15, maxZoom: 15, gradient }).addTo(map);
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

  return (
    <div className="sg-map-wrapper">
      <div ref={containerRef} className="sg-map" id="map-container" />
      {locations.length > 0 && (
        <div className="sg-map-legend">
          <div className="sg-legend-title">Map Legend</div>
          <div className="sg-legend-item">
            <span className="sg-legend-dot" style={{ background: '#059669' }} /> Candidate Location
          </div>
          <div className="sg-legend-item">
            <span className="sg-legend-dot" style={{ background: '#1d4ed8' }} /> Selected
          </div>
          <div className="sg-legend-item">
            <span className="sg-legend-circle" /> Marketing Radius
          </div>
        </div>
      )}
    </div>
  );
};
