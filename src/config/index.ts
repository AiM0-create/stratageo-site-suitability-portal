export const config = {
  appName: 'Stratageo',
  tagline: 'AI-Assisted Site Suitability Portal',
  companyUrl: 'https://stratageo.in/',
  contactUrl: 'https://stratageo.in/contact.php',

  mode: (import.meta.env.VITE_APP_MODE as 'demo' | 'live') || 'demo',
  aiBackendUrl: import.meta.env.VITE_AI_BACKEND_URL || '',

  get isDemoMode(): boolean {
    return this.mode === 'demo' || !this.aiBackendUrl;
  },

  get isLiveMode(): boolean {
    return this.mode === 'live' && !!this.aiBackendUrl;
  },

  map: {
    defaultCenter: [20, 0] as [number, number],
    defaultZoom: 2,
    tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },

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
