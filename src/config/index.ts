export const config = {
  appName: 'Stratageo',
  tagline: 'AI-Assisted Site Suitability Portal',
  companyUrl: 'https://stratageo.in/',
  contactUrl: 'https://stratageo.in/contact.php',

  mode: (import.meta.env.VITE_APP_MODE as 'demo' | 'live') || 'demo',
  aiBackendUrl: (import.meta.env.VITE_AI_BACKEND_URL || '').replace(/\/+$/, ''),
  /** Python conversational engine (v1.0.1). When set with VITE_CONVERSATIONAL_MODE=1,
   *  the chat becomes multi-turn and analyses run via /api/v2 on this host. */
  pyBackendUrl: (import.meta.env.VITE_PY_BACKEND_URL || '').replace(/\/+$/, ''),
  /** Rotatable kill-switch token sent as X-App-Token to the engine (not a secret). */
  appToken: import.meta.env.VITE_APP_TOKEN || '',

  /** Demo mode = no backend URL configured. If backend URL exists, we're live. */
  get isDemoMode(): boolean {
    return !this.aiBackendUrl && !this.isConversationalMode;
  },

  /** Live mode = backend URL is configured (regardless of VITE_APP_MODE). */
  get isLiveMode(): boolean {
    return !!this.aiBackendUrl || this.isConversationalMode;
  },

  /** Conversational mode = Python backend configured + flag on. */
  get isConversationalMode(): boolean {
    return !!this.pyBackendUrl && import.meta.env.VITE_CONVERSATIONAL_MODE === '1';
  },

  map: {
    defaultCenter: [20, 0] as [number, number],
    defaultZoom: 2,
    tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },

  basemaps: [
    {
      id: 'light',
      label: 'Light',
      icon: '☀️',
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
    },
    {
      id: 'dark',
      label: 'Dark',
      icon: '🌙',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
    },
    {
      id: 'voyager',
      label: 'Voyager',
      icon: '🗺️',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
    },
    {
      id: 'satellite',
      label: 'Satellite',
      icon: '🛰️',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
      subdomains: '',
    },
    {
      id: 'osm',
      label: 'Street',
      icon: '🛣️',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: '',
    },
  ] as const,

  sectors: [
    { id: 'cafe', label: 'Cafe / Restaurant', icon: '☕', osmTags: ['amenity=cafe', 'amenity=restaurant'] },
    { id: 'preschool', label: 'Preschool / School', icon: '🎓', osmTags: ['amenity=school', 'amenity=kindergarten'] },
    { id: 'retail', label: 'Retail Store', icon: '🛍️', osmTags: ['shop=supermarket', 'shop=convenience'] },
    { id: 'clinic', label: 'Clinic / Healthcare', icon: '🏥', osmTags: ['amenity=clinic', 'amenity=pharmacy'] },
    { id: 'ev', label: 'EV Charging', icon: '⚡', osmTags: ['amenity=charging_station'] },
    { id: 'logistics', label: 'Logistics / Warehouse', icon: '📦', osmTags: ['building=warehouse', 'industrial=warehouse'] },
    { id: 'realestate', label: 'Real Estate / Mixed-use', icon: '🏢', osmTags: ['building=commercial', 'building=retail'] },
    { id: 'coworking', label: 'Coworking Space', icon: '💻', osmTags: ['amenity=coworking_space', 'office=coworking'] },
  ],

  featuredCities: [
    { name: 'Bengaluru', country: 'India' },
    { name: 'Mumbai', country: 'India' },
    { name: 'Delhi', country: 'India' },
    { name: 'Hyderabad', country: 'India' },
    { name: 'Pune', country: 'India' },
    { name: 'Chennai', country: 'India' },
  ],
} as const;
