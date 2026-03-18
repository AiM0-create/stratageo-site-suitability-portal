import React, { useEffect, useRef } from 'react';
import type { LocationData } from '../types';

// Leaflet is loaded from a CDN in index.html, declare it here for TypeScript
declare const L: any;

interface MapProps {
    locations: LocationData[];
    selectedLocations: LocationData[];
    onSelectLocation: (location: LocationData) => void;
    onDeselectLocation: () => void;
    heatmapType?: 'competitor' | 'transport' | 'commercial' | 'residential' | null;
    heatmapRadius?: number;
    heatmapBlur?: number;
    heatmapOpacity?: number;
}

const getMarkerIcon = (isSelected: boolean) => {
    const color = isSelected ? 'text-blue-600' : 'text-green-600';
    const shadow = isSelected ? 'drop-shadow-[0_2px_4px_rgba(59,130,246,0.7)]' : 'drop-shadow-[0_2px_4px_rgba(22,163,74,0.7)]';
    const animation = isSelected ? '' : 'animate-pulse';
    
    return L.divIcon({
        className: 'custom-location-marker',
        html: `<div class="animate-drop-in"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-8 w-8 ${color} ${shadow} ${animation}"><path fill-rule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 005.16-4.252C19.778 15.89 21 13.144 21 10.5 21 6.36 17.14 3 12 3S3 6.36 3 10.5c0 2.644 1.223 5.39 3.28 7.601a16.975 16.975 0 005.16 4.252zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" /></svg></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -35],
    });
};


export const Map: React.FC<MapProps> = ({ locations, selectedLocations, onSelectLocation, onDeselectLocation, heatmapType, heatmapRadius = 25, heatmapBlur = 15, heatmapOpacity = 0.8 }) => {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<any>(null);
    const markersLayerRef = useRef<any>(null);
    const heatLayerRef = useRef<any>(null);

    // Initialize map effect
    useEffect(() => {
        if (mapContainerRef.current && !mapInstanceRef.current) {
            const map = L.map(mapContainerRef.current, {
                center: [20, 0],
                zoom: 2,
                zoomControl: false, 
            });

            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 19,
            }).addTo(map);
            
            L.control.zoom({ position: 'bottomright' }).addTo(map);

            map.on('click', onDeselectLocation);

            mapInstanceRef.current = map;
            markersLayerRef.current = L.layerGroup().addTo(map);

            // Fix for map not rendering after landing page
            setTimeout(() => map.invalidateSize(), 100);
        }

        // Cleanup on unmount
        return () => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.stop();
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
            }
        };
    }, [onDeselectLocation]);

    // Update markers when locations or selection change
    useEffect(() => {
        const map = mapInstanceRef.current;
        const markersLayer = markersLayerRef.current;
        if (!map || !markersLayer) return;

        // Stop any ongoing animations (like flyTo) to prevent _leaflet_pos errors when removing layers
        map.stop();

        markersLayer.clearLayers();
        if (heatLayerRef.current) {
            map.removeLayer(heatLayerRef.current);
            heatLayerRef.current = null;
        }

        if (locations.length === 0) {
            map.flyTo([20, 0], 2, { animate: true, duration: 1.5 });
            return;
        }

        const markerBounds: [number, number][] = [];
        const heatPoints: [number, number, number][] = [];

        locations.forEach(loc => {
            const lat = Number(loc.lat);
            const lng = Number(loc.lng);
            
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                console.warn('Invalid location coordinates:', loc);
                return;
            }

            const isSelected = selectedLocations.some(sl => sl.name === loc.name);
            const customIcon = getMarkerIcon(isSelected);

            // Collect POIs for heatmap if a type is selected and this location is selected (or if we want to show all)
            // Let's show heatmaps for selected locations only to avoid clutter, or all if none selected.
            if (heatmapType && loc.pois) {
                const relevantPois = loc.pois.filter(p => p.type === heatmapType);
                relevantPois.forEach(p => {
                    const pLat = Number(p.lat);
                    const pLng = Number(p.lng);
                    if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
                        heatPoints.push([pLat, pLng, 1]); // lat, lng, intensity
                    }
                });
            }

            try {
                const marker = L.marker([lat, lng], { icon: customIcon });
                
                // Add permanent tooltip with location name
                marker.bindTooltip(loc.name, {
                    permanent: true,
                    direction: 'top',
                    className: 'bg-white/90 border-none shadow-md font-semibold text-blue-800 rounded px-2 py-1 text-xs',
                    offset: [0, -32]
                });
                
                marker.on('click', (e: any) => {
                    L.DomEvent.stopPropagation(e); // Prevent map click event from firing
                    onSelectLocation(loc);
                });

                markersLayer.addLayer(marker);
                markerBounds.push([lat, lng]);
            } catch (e) {
                console.error("Error adding marker for location:", loc, e);
            }
        });
        
        // Only show the buffer radius for the selected location(s)
        selectedLocations.forEach(sl => {
            const slLat = Number(sl.lat);
            const slLng = Number(sl.lng);
            
            if (!Number.isFinite(slLat) || !Number.isFinite(slLng)) {
                return;
            }
            
            const radius = Number.isFinite(Number(sl.marketing_radius_km)) 
                ? Number(sl.marketing_radius_km) * 1000 
                : 1000; // Default to 1km if invalid

            try {
                L.circle([slLat, slLng], {
                    radius: radius,
                    color: '#2563eb', // blue-600
                    fillColor: '#2563eb',
                    fillOpacity: 0.1,
                    weight: 1.5,
                }).addTo(markersLayer);
            } catch (e) {
                console.error("Error adding circle for location:", sl, e);
            }
        });
        
        // Add heatmap layer if we have points
        if (heatPoints.length > 0 && typeof L.heatLayer === 'function') {
            try {
                const gradient = heatmapType === 'competitor' ? { 0.4: 'blue', 0.6: 'cyan', 0.7: 'lime', 0.8: 'yellow', 1: 'red' } :
                                 heatmapType === 'transport' ? { 0.4: 'purple', 0.6: 'magenta', 0.8: 'pink', 1: 'white' } :
                                 { 0.4: 'green', 0.6: 'yellow', 0.8: 'orange', 1: 'red' };
                
                heatLayerRef.current = L.heatLayer(heatPoints, {
                    radius: heatmapRadius,
                    blur: heatmapBlur,
                    maxZoom: 15,
                    gradient: gradient
                }).addTo(map);

                // Apply opacity to the canvas element created by heatLayer
                if (heatLayerRef.current && heatLayerRef.current._canvas) {
                    heatLayerRef.current._canvas.style.opacity = heatmapOpacity.toString();
                }
            } catch (e) {
                console.error("Error adding heat layer:", e);
            }
        }

        const validSelectedLocations = selectedLocations
            .map(l => ({ ...l, lat: Number(l.lat), lng: Number(l.lng) }))
            .filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));

        if (validSelectedLocations.length === 1) {
             try {
                const center: [number, number] = [validSelectedLocations[0].lat, validSelectedLocations[0].lng];
                if (Number.isFinite(center[0]) && Number.isFinite(center[1])) {
                    map.flyTo(center, 13, { animate: true, duration: 1 });
                }
             } catch (e) {
                console.error("Error flying to location:", validSelectedLocations[0], e);
             }
        } else if (validSelectedLocations.length > 1) {
            const selectedBounds = validSelectedLocations
                .map(l => [l.lat, l.lng] as [number, number]);
            
            if (selectedBounds.length > 1) {
                try {
                    map.flyToBounds(selectedBounds, { padding: [50, 50], animate: true, duration: 1.5 });
                } catch (e) {
                    console.error("Error flying to bounds:", selectedBounds, e);
                }
            } else if (selectedBounds.length === 1) {
                try {
                    map.flyTo(selectedBounds[0], 13, { animate: true, duration: 1 });
                } catch (e) {
                    console.error("Error flying to single selected bound:", selectedBounds[0], e);
                }
            }
        }
        else if (markerBounds.length > 0) {
            if (markerBounds.length === 1) {
                try {
                    map.flyTo(markerBounds[0], 13, { animate: true, duration: 1 });
                } catch (e) {
                    console.error("Error flying to single marker:", markerBounds[0], e);
                }
            } else {
                try {
                    map.flyToBounds(markerBounds, { padding: [50, 50], animate: true, duration: 1.5 });
                } catch (e) {
                    console.error("Error flying to marker bounds:", markerBounds, e);
                }
            }
        }

    }, [locations, selectedLocations, onSelectLocation, heatmapType, heatmapRadius, heatmapBlur, heatmapOpacity]);

    return (
        <div id="map-tour-target" ref={mapContainerRef} className="absolute inset-0 z-0"></div>
    );
};