/**
 * Sector Templates — Business-type-specific MCDA configurations.
 *
 * Each sector defines:
 * - relevant criteria with directionality (positive/negative)
 * - baseline weights
 * - OSM signal mapping for each criterion
 * - search radius appropriate for the sector
 *
 * These templates are starting points. The prompt parser can
 * modify weights and add/remove criteria based on user intent.
 */

import type { CriterionDirection, EvidenceBasis } from '../types';

export interface CriterionTemplate {
  name: string;
  direction: CriterionDirection;
  defaultWeight: number;
  osmSignalKey: string;
  osmQuery: OsmQueryDef;
  scoringThresholds: number[];   // e.g. [0, 3, 8, 15, 25] — breakpoints for 1-9 scoring
  evidenceBasis: EvidenceBasis;
  description: string;
}

export interface OsmQueryDef {
  tags: string[];                 // OSM tags to query (key=value format)
  queryBothNodeAndWay: boolean;   // whether to query ways too
}

export interface SectorTemplate {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
  searchRadiusM: number;
  criteria: CriterionTemplate[];
  competitorTags: string[];       // OSM tags identifying direct competitors
}

// ─── Templates ───

export const SECTOR_TEMPLATES: SectorTemplate[] = [
  {
    id: 'cafe',
    label: 'Cafe / Restaurant',
    icon: '☕',
    keywords: ['cafe', 'coffee', 'restaurant', 'food', 'bakery', 'eatery', 'dining'],
    searchRadiusM: 1000,
    competitorTags: ['amenity=cafe', 'amenity=restaurant'],
    criteria: [
      {
        name: 'Competitor Density',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['amenity=cafe', 'amenity=restaurant'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 3, 8, 15, 25],
        evidenceBasis: 'osm-observed',
        description: 'Count of existing cafes/restaurants. Lower = less saturated market.',
      },
      {
        name: 'Transit Access',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'transit',
        osmQuery: { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station', 'railway=halt'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Public transport stops and stations nearby. More = better walk-in access.',
      },
      {
        name: 'Commercial Activity',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'commercial',
        osmQuery: { tags: ['shop=*', 'office=*', 'amenity=bank'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Shops, offices, and banks indicating commercial vibrancy.',
      },
      {
        name: 'Residential Presence',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential', 'landuse=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Residential buildings nearby indicating local customer base.',
      },
      {
        name: 'Amenity Ecosystem',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'amenities',
        osmQuery: { tags: ['amenity=atm', 'amenity=pharmacy', 'amenity=cinema', 'leisure=park', 'amenity=library'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 3, 8, 15, 25],
        evidenceBasis: 'osm-observed',
        description: 'Complementary amenities that generate foot traffic.',
      },
    ],
  },

  {
    id: 'preschool',
    label: 'Preschool / School',
    icon: '🎓',
    keywords: ['preschool', 'school', 'kindergarten', 'education', 'daycare', 'nursery', 'montessori'],
    searchRadiusM: 1500,
    competitorTags: ['amenity=school', 'amenity=kindergarten'],
    criteria: [
      {
        name: 'Residential Density',
        direction: 'positive',
        defaultWeight: 0.30,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential', 'landuse=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 60],
        evidenceBasis: 'osm-observed',
        description: 'Residential buildings as proxy for family households.',
      },
      {
        name: 'Existing Schools',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['amenity=school', 'amenity=kindergarten'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 10, 15],
        evidenceBasis: 'osm-observed',
        description: 'Existing schools and kindergartens. Fewer = less competition.',
      },
      {
        name: 'Road Access',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'roads',
        osmQuery: { tags: ['highway=primary', 'highway=secondary', 'highway=tertiary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Major road segments indicating accessibility for drop-off/pickup.',
      },
      {
        name: 'Parks & Open Spaces',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'parks',
        osmQuery: { tags: ['leisure=park', 'leisure=playground', 'leisure=garden'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Parks and playgrounds indicating child-friendly environment.',
      },
      {
        name: 'Healthcare Nearby',
        direction: 'positive',
        defaultWeight: 0.10,
        osmSignalKey: 'healthcare',
        osmQuery: { tags: ['amenity=hospital', 'amenity=clinic', 'amenity=pharmacy'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Hospitals, clinics, pharmacies for emergency proximity.',
      },
      {
        name: 'Industrial Proximity',
        direction: 'negative',
        defaultWeight: 0.10,
        osmSignalKey: 'industrial',
        osmQuery: { tags: ['landuse=industrial', 'building=industrial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Industrial zones nearby. More = less suitable for children.',
      },
    ],
  },

  {
    id: 'ev',
    label: 'EV Charging Station',
    icon: '⚡',
    keywords: ['ev', 'charging', 'electric vehicle', 'ev charging', 'charger'],
    searchRadiusM: 2000,
    competitorTags: ['amenity=charging_station'],
    criteria: [
      {
        name: 'Existing Chargers',
        direction: 'negative',
        defaultWeight: 0.25,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['amenity=charging_station'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Existing EV charging stations. Fewer = infrastructure gap.',
      },
      {
        name: 'Highway Access',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'highways',
        osmQuery: { tags: ['highway=trunk', 'highway=motorway', 'highway=primary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Highway/trunk roads nearby for en-route charging demand.',
      },
      {
        name: 'Commercial Zones',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'commercial',
        osmQuery: { tags: ['shop=*', 'amenity=restaurant', 'amenity=cafe', 'building=commercial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Commercial establishments where drivers can wait during charging.',
      },
      {
        name: 'Parking Infrastructure',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'parking',
        osmQuery: { tags: ['amenity=parking', 'amenity=fuel'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Parking lots and fuel stations as installation sites.',
      },
      {
        name: 'Residential Base',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Residential buildings indicating overnight-charging demand.',
      },
    ],
  },

  {
    id: 'logistics',
    label: 'Logistics / Warehouse',
    icon: '📦',
    keywords: ['warehouse', 'logistics', 'distribution', 'storage', 'fulfillment', 'supply chain', 'godown'],
    searchRadiusM: 3000,
    competitorTags: ['building=warehouse', 'industrial=warehouse'],
    criteria: [
      {
        name: 'Highway Connectivity',
        direction: 'positive',
        defaultWeight: 0.30,
        osmSignalKey: 'highways',
        osmQuery: { tags: ['highway=trunk', 'highway=motorway', 'highway=primary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 2, 4, 7],
        evidenceBasis: 'osm-observed',
        description: 'Major highway segments for freight movement.',
      },
      {
        name: 'Industrial/Commercial Cluster',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'industrial',
        osmQuery: { tags: ['landuse=industrial', 'building=industrial', 'building=warehouse', 'building=commercial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 10, 20],
        evidenceBasis: 'osm-observed',
        description: 'Existing industrial/warehouse cluster indicating suitable zoning.',
      },
      {
        name: 'Dense Residential Proximity',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Dense residential zones. More = potential zoning/noise conflict.',
      },
      {
        name: 'Road Network Density',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'roads',
        osmQuery: { tags: ['highway=secondary', 'highway=tertiary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Secondary/tertiary roads for last-mile access.',
      },
      {
        name: 'Existing Competitors',
        direction: 'negative',
        defaultWeight: 0.10,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['building=warehouse', 'industrial=warehouse'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 8, 12],
        evidenceBasis: 'osm-observed',
        description: 'Existing warehouses. Some validates demand; many = saturated.',
      },
    ],
  },

  {
    id: 'retail',
    label: 'Retail Store',
    icon: '🛍️',
    keywords: ['retail', 'store', 'shop', 'supermarket', 'mall', 'boutique', 'outlet'],
    searchRadiusM: 1000,
    competitorTags: ['shop=supermarket', 'shop=convenience', 'shop=department_store'],
    criteria: [
      {
        name: 'Competitor Density',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['shop=supermarket', 'shop=convenience', 'shop=department_store'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 3, 8, 15, 25],
        evidenceBasis: 'osm-observed',
        description: 'Existing retail stores. Fewer = less competition.',
      },
      {
        name: 'Transit Access',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'transit',
        osmQuery: { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Transit stops for walk-in customer access.',
      },
      {
        name: 'Residential Catchment',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential', 'landuse=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Residential presence for regular customer base.',
      },
      {
        name: 'Commercial Ecosystem',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'commercial',
        osmQuery: { tags: ['shop=*', 'office=*', 'amenity=bank', 'amenity=restaurant'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Surrounding commercial activity for co-location benefit.',
      },
      {
        name: 'Parking Availability',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'parking',
        osmQuery: { tags: ['amenity=parking'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Parking facilities for drive-in customers.',
      },
    ],
  },

  {
    id: 'clinic',
    label: 'Clinic / Healthcare',
    icon: '🏥',
    keywords: ['clinic', 'health', 'hospital', 'pharmacy', 'medical', 'healthcare', 'diagnostic'],
    searchRadiusM: 1500,
    competitorTags: ['amenity=clinic', 'amenity=hospital', 'amenity=doctors'],
    criteria: [
      {
        name: 'Residential Density',
        direction: 'positive',
        defaultWeight: 0.30,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential', 'landuse=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 60],
        evidenceBasis: 'osm-observed',
        description: 'Residential buildings as patient catchment area.',
      },
      {
        name: 'Existing Healthcare',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['amenity=clinic', 'amenity=hospital', 'amenity=doctors'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 10, 15],
        evidenceBasis: 'osm-observed',
        description: 'Existing clinics/hospitals. Fewer = less saturated catchment.',
      },
      {
        name: 'Road Access',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'roads',
        osmQuery: { tags: ['highway=primary', 'highway=secondary', 'highway=tertiary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Major roads for emergency and patient access.',
      },
      {
        name: 'Pharmacy Proximity',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'pharmacies',
        osmQuery: { tags: ['amenity=pharmacy'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 2, 4, 7],
        evidenceBasis: 'osm-observed',
        description: 'Pharmacies nearby for complementary services.',
      },
      {
        name: 'Transit Access',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'transit',
        osmQuery: { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Public transport for patient accessibility.',
      },
    ],
  },

  {
    id: 'coworking',
    label: 'Coworking Space',
    icon: '💻',
    keywords: ['coworking', 'co-working', 'shared office', 'workspace', 'office space'],
    searchRadiusM: 1500,
    competitorTags: ['amenity=coworking_space', 'office=coworking'],
    criteria: [
      {
        name: 'Office Cluster',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'offices',
        osmQuery: { tags: ['office=*', 'building=office', 'building=commercial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Existing offices indicating business district.',
      },
      {
        name: 'Existing Coworking',
        direction: 'negative',
        defaultWeight: 0.20,
        osmSignalKey: 'competitors',
        osmQuery: { tags: ['amenity=coworking_space', 'office=coworking'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 8, 12],
        evidenceBasis: 'osm-observed',
        description: 'Existing coworking spaces. Fewer = less competition.',
      },
      {
        name: 'Transit Access',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'transit',
        osmQuery: { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Transit connectivity for daily commuters.',
      },
      {
        name: 'Cafe/Food Options',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'food',
        osmQuery: { tags: ['amenity=cafe', 'amenity=restaurant', 'amenity=fast_food'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 3, 8, 15, 25],
        evidenceBasis: 'osm-observed',
        description: 'Food options for lunch breaks and meetings.',
      },
      {
        name: 'Residential Catchment',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=apartments', 'building=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Residential base for freelancers and remote workers.',
      },
    ],
  },

  {
    id: 'solar',
    label: 'Solar / Renewable Energy',
    icon: '☀️',
    keywords: ['solar', 'solar farm', 'solar plant', 'photovoltaic', 'pv', 'renewable energy', 'wind farm'],
    searchRadiusM: 5000,
    competitorTags: ['generator:source=solar', 'power=generator'],
    criteria: [
      {
        name: 'Open Land Availability',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'open_land',
        osmQuery: { tags: ['landuse=farmland', 'landuse=meadow', 'natural=scrub', 'landuse=grass'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 2, 5, 10, 20],
        evidenceBasis: 'osm-observed',
        description: 'Open land (farmland, meadows, scrubland) suitable for solar installation.',
      },
      {
        name: 'Power Infrastructure',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'power_infra',
        osmQuery: { tags: ['power=substation', 'power=line', 'power=tower'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Substations, transmission lines, and power towers for grid connectivity.',
      },
      {
        name: 'Road Access',
        direction: 'positive',
        defaultWeight: 0.15,
        osmSignalKey: 'roads',
        osmQuery: { tags: ['highway=primary', 'highway=secondary', 'highway=tertiary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Road access for construction and maintenance vehicles.',
      },
      {
        name: 'Settlement Distance',
        direction: 'negative',
        defaultWeight: 0.15,
        osmSignalKey: 'residential',
        osmQuery: { tags: ['building=residential', 'building=apartments', 'landuse=residential'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Dense residential areas nearby. More = less suitable (land competition, shadow concerns).',
      },
      {
        name: 'Industrial Zone Proximity',
        direction: 'positive',
        defaultWeight: 0.10,
        osmSignalKey: 'industrial',
        osmQuery: { tags: ['landuse=industrial', 'building=industrial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Industrial zones as potential offtake customers for power.',
      },
      {
        name: 'Water Body Proximity',
        direction: 'positive',
        defaultWeight: 0.10,
        osmSignalKey: 'water',
        osmQuery: { tags: ['natural=water', 'waterway=river', 'waterway=canal'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 2, 4, 6],
        evidenceBasis: 'osm-observed',
        description: 'Water bodies nearby for panel cleaning and cooling.',
      },
    ],
  },

  {
    id: 'realestate',
    label: 'Real Estate / Mixed-use',
    icon: '🏢',
    keywords: ['real estate', 'mixed-use', 'mixed use', 'property', 'development', 'housing', 'apartment'],
    searchRadiusM: 2000,
    competitorTags: ['building=commercial', 'building=retail'],
    criteria: [
      {
        name: 'Transit Connectivity',
        direction: 'positive',
        defaultWeight: 0.25,
        osmSignalKey: 'transit',
        osmQuery: { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 2, 5, 10, 18],
        evidenceBasis: 'osm-observed',
        description: 'Transit access drives property value.',
      },
      {
        name: 'Commercial Activity',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'commercial',
        osmQuery: { tags: ['shop=*', 'office=*', 'amenity=bank', 'amenity=restaurant'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 5, 15, 30, 50],
        evidenceBasis: 'osm-observed',
        description: 'Surrounding commercial ecosystem.',
      },
      {
        name: 'Road Access',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'roads',
        osmQuery: { tags: ['highway=primary', 'highway=secondary'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 1, 3, 6, 10],
        evidenceBasis: 'osm-observed',
        description: 'Major road connectivity.',
      },
      {
        name: 'Amenity Ecosystem',
        direction: 'positive',
        defaultWeight: 0.20,
        osmSignalKey: 'amenities',
        osmQuery: { tags: ['amenity=school', 'amenity=hospital', 'leisure=park', 'amenity=pharmacy'], queryBothNodeAndWay: false },
        scoringThresholds: [0, 3, 8, 15, 25],
        evidenceBasis: 'osm-observed',
        description: 'Schools, hospitals, parks indicating livability.',
      },
      {
        name: 'Industrial Proximity',
        direction: 'negative',
        defaultWeight: 0.15,
        osmSignalKey: 'industrial',
        osmQuery: { tags: ['landuse=industrial', 'building=industrial'], queryBothNodeAndWay: true },
        scoringThresholds: [0, 1, 3, 5, 8],
        evidenceBasis: 'osm-observed',
        description: 'Industrial zones nearby reduce residential appeal.',
      },
    ],
  },
];

// ─── Lookup helpers ───

export function findSectorTemplate(businessType: string): SectorTemplate | undefined {
  const lower = businessType.toLowerCase();
  return SECTOR_TEMPLATES.find(t => t.keywords.some(k => lower.includes(k)));
}

export function getSectorById(id: string): SectorTemplate {
  return SECTOR_TEMPLATES.find(t => t.id === id) || SECTOR_TEMPLATES[0];
}
