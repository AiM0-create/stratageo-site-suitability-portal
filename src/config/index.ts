export const config = {
  appName: 'Stratageo',
  tagline: 'AI-Assisted Site Suitability Portal',
  companyUrl: 'https://stratageo.in/',
  contactUrl: 'https://stratageo.in/contact.php',

  /** The Python engine (Cloud Run). Every call — clarify, chat, analyses,
   *  map config — goes to /api/v2 on this host. Required. */
  pyBackendUrl: (import.meta.env.VITE_PY_BACKEND_URL || '').replace(/\/+$/, ''),
  /** Rotatable kill-switch token sent as X-App-Token to the engine (not a secret). */
  appToken: import.meta.env.VITE_APP_TOKEN || '',

  /* v1.12.0 — the Mapbox token deliberately does NOT live here. Baking it in
   * at build time put it in the shipped JS, which GitHub push protection
   * rejected on every deploy. It is fetched at runtime from the engine's
   * /api/v2/map-config instead — see services/mapConfig.ts. */

  map: {
    // v2.4.1 — India, not the globe: on a phone "tap the map where the shop
    // would be" started from a world view.
    defaultCenter: [21.5, 79.0] as [number, number],
    defaultZoom: 4,
  },

  /** v1.12.0 — Mapbox GL JS vector styles, replacing the previous raster tile
   *  URLs (CARTO / Esri / OSM). All five picker options are preserved; each is
   *  mapped to its closest Mapbox equivalent. `style` is what GL JS consumes;
   *  `rasterTile` is the Static Tiles endpoint for the SAME style, used by the
   *  PDF report figure so the printed basemap matches what was on screen. */
  basemaps: [
    {
      id: 'light',
      label: 'Light',
      icon: '☀️',
      style: 'mapbox://styles/mapbox/light-v11',
      rasterStyle: 'light-v11',
    },
    {
      id: 'dark',
      label: 'Dark',
      icon: '🌙',
      style: 'mapbox://styles/mapbox/dark-v11',
      rasterStyle: 'dark-v11',
    },
    {
      id: 'voyager',
      label: 'Voyager',
      icon: '🗺️',
      style: 'mapbox://styles/mapbox/outdoors-v12',
      rasterStyle: 'outdoors-v12',
    },
    {
      id: 'satellite',
      label: 'Satellite',
      icon: '🛰️',
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      rasterStyle: 'satellite-streets-v12',
    },
    {
      id: 'osm',
      label: 'Street',
      icon: '🛣️',
      style: 'mapbox://styles/mapbox/streets-v12',
      rasterStyle: 'streets-v12',
    },
  ] as const,

} as const;
