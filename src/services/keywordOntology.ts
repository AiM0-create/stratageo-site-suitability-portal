/**
 * Keyword Ontology — Structured domain-to-keyword mapping for business classification.
 *
 * Each domain has weighted keywords (multi-word phrases score higher)
 * and contextual phrase patterns that boost confidence.
 */

export interface WeightedKeyword {
  term: string;
  weight: number;
}

export interface DomainEntry {
  id: string;
  label: string;
  keywords: WeightedKeyword[];
  /** Regex patterns that, if matched, add bonus score */
  contextualPatterns: RegExp[];
  contextualBonus: number;
}

/**
 * Weight guide:
 *   3 = multi-word exact phrase (strongest signal, e.g. "solar farm")
 *   2 = single strong keyword (e.g. "warehouse", "preschool")
 *   1 = contextual / supporting term (e.g. "substation", "freight")
 */

export const DOMAIN_ONTOLOGY: DomainEntry[] = [
  // ─── Solar / Renewable Energy ───
  {
    id: 'solar',
    label: 'Solar / Renewable Energy',
    keywords: [
      { term: 'solar farm', weight: 3 },
      { term: 'solar plant', weight: 3 },
      { term: 'solar park', weight: 3 },
      { term: 'solar power', weight: 3 },
      { term: 'solar energy', weight: 3 },
      { term: 'photovoltaic', weight: 3 },
      { term: 'pv plant', weight: 3 },
      { term: 'renewable energy', weight: 3 },
      { term: 'wind farm', weight: 3 },
      { term: 'wind energy', weight: 3 },
      { term: 'solar', weight: 2 },
      { term: 'pv', weight: 2 },
      { term: 'substation', weight: 1 },
      { term: 'transmission line', weight: 1 },
      { term: 'transmission', weight: 1 },
      { term: 'grid connection', weight: 1 },
      { term: 'irradiance', weight: 1 },
      { term: 'renewable', weight: 1 },
      { term: 'panel', weight: 1 },
      { term: 'inverter', weight: 1 },
      { term: 'megawatt', weight: 1 },
    ],
    contextualPatterns: [
      /solar.*(?:substation|grid|transmission|slope)/i,
      /(?:substation|grid|transmission).*solar/i,
      /(?:irradiance|megawatt|photovoltaic)/i,
    ],
    contextualBonus: 2,
  },

  // ─── Logistics / Warehouse ───
  {
    id: 'logistics',
    label: 'Logistics / Warehouse',
    keywords: [
      { term: 'distribution center', weight: 3 },
      { term: 'distribution centre', weight: 3 },
      { term: 'logistics hub', weight: 3 },
      { term: 'logistics park', weight: 3 },
      { term: 'fulfillment center', weight: 3 },
      { term: 'fulfilment centre', weight: 3 },
      { term: 'cold storage', weight: 3 },
      { term: 'supply chain', weight: 3 },
      { term: 'freight terminal', weight: 3 },
      { term: 'warehouse', weight: 2 },
      { term: 'logistics', weight: 2 },
      { term: 'distribution', weight: 2 },
      { term: 'fulfillment', weight: 2 },
      { term: 'storage', weight: 2 },
      { term: 'godown', weight: 2 },
      { term: 'freight', weight: 1 },
      { term: 'trucking', weight: 1 },
      { term: 'industrial', weight: 1 },
      { term: 'last mile', weight: 1 },
      { term: 'inventory', weight: 1 },
    ],
    contextualPatterns: [
      /warehouse.*(?:highway|freight|logistics)/i,
      /(?:freight|trucking|supply\s+chain).*(?:warehouse|hub)/i,
    ],
    contextualBonus: 2,
  },

  // ─── Cafe / Restaurant ───
  {
    id: 'cafe',
    label: 'Cafe / Restaurant',
    keywords: [
      { term: 'coffee shop', weight: 3 },
      { term: 'food court', weight: 3 },
      { term: 'fine dining', weight: 3 },
      { term: 'fast food', weight: 3 },
      { term: 'ice cream', weight: 3 },
      { term: 'juice bar', weight: 3 },
      { term: 'cafe', weight: 2 },
      { term: 'coffee', weight: 2 },
      { term: 'restaurant', weight: 2 },
      { term: 'bakery', weight: 2 },
      { term: 'eatery', weight: 2 },
      { term: 'dining', weight: 2 },
      { term: 'food', weight: 1 },
      { term: 'bistro', weight: 1 },
      { term: 'canteen', weight: 1 },
      { term: 'dhaba', weight: 1 },
      { term: 'pizzeria', weight: 1 },
    ],
    contextualPatterns: [
      /(?:cafe|coffee|restaurant).*(?:foot\s+traffic|walk-in|dine)/i,
    ],
    contextualBonus: 1,
  },

  // ─── Retail ───
  {
    id: 'retail',
    label: 'Retail Store',
    keywords: [
      { term: 'retail store', weight: 3 },
      { term: 'department store', weight: 3 },
      { term: 'shopping mall', weight: 3 },
      { term: 'shopping center', weight: 3 },
      { term: 'shopping centre', weight: 3 },
      { term: 'convenience store', weight: 3 },
      { term: 'retail', weight: 2 },
      { term: 'store', weight: 2 },
      { term: 'supermarket', weight: 2 },
      { term: 'mall', weight: 2 },
      { term: 'boutique', weight: 2 },
      { term: 'outlet', weight: 2 },
      { term: 'shop', weight: 2 },
      { term: 'showroom', weight: 1 },
      { term: 'kiosk', weight: 1 },
    ],
    contextualPatterns: [
      /(?:retail|store|shop).*(?:foot\s+traffic|catchment|walk-in)/i,
    ],
    contextualBonus: 1,
  },

  // ─── EV / Mobility ───
  {
    id: 'ev',
    label: 'EV Charging Station',
    keywords: [
      { term: 'ev charging station', weight: 3 },
      { term: 'ev charging', weight: 3 },
      { term: 'electric vehicle', weight: 3 },
      { term: 'charging station', weight: 3 },
      { term: 'battery swap', weight: 3 },
      { term: 'ev hub', weight: 3 },
      { term: 'charger', weight: 2 },
      { term: 'ev', weight: 2 },
      { term: 'charging', weight: 1 },
    ],
    contextualPatterns: [
      /(?:ev|electric\s+vehicle|charging).*(?:highway|parking|station)/i,
    ],
    contextualBonus: 2,
  },

  // ─── Education / Preschool ───
  {
    id: 'preschool',
    label: 'Preschool / School',
    keywords: [
      { term: 'play school', weight: 3 },
      { term: 'play group', weight: 3 },
      { term: 'learning center', weight: 3 },
      { term: 'learning centre', weight: 3 },
      { term: 'preschool', weight: 2 },
      { term: 'pre-school', weight: 2 },
      { term: 'kindergarten', weight: 2 },
      { term: 'school', weight: 2 },
      { term: 'daycare', weight: 2 },
      { term: 'nursery', weight: 2 },
      { term: 'montessori', weight: 2 },
      { term: 'education', weight: 1 },
      { term: 'academy', weight: 1 },
      { term: 'tuition', weight: 1 },
      { term: 'coaching', weight: 1 },
    ],
    contextualPatterns: [
      /(?:school|preschool|daycare).*(?:residential|family|children)/i,
    ],
    contextualBonus: 1,
  },

  // ─── Healthcare ───
  {
    id: 'clinic',
    label: 'Clinic / Healthcare',
    keywords: [
      { term: 'diagnostic center', weight: 3 },
      { term: 'diagnostic centre', weight: 3 },
      { term: 'health center', weight: 3 },
      { term: 'health centre', weight: 3 },
      { term: 'medical center', weight: 3 },
      { term: 'medical centre', weight: 3 },
      { term: 'nursing home', weight: 3 },
      { term: 'clinic', weight: 2 },
      { term: 'hospital', weight: 2 },
      { term: 'pharmacy', weight: 2 },
      { term: 'medical', weight: 2 },
      { term: 'healthcare', weight: 2 },
      { term: 'diagnostic', weight: 2 },
      { term: 'health', weight: 1 },
      { term: 'pathology', weight: 1 },
      { term: 'lab', weight: 1 },
    ],
    contextualPatterns: [
      /(?:clinic|hospital|medical).*(?:residential|patient|emergency)/i,
    ],
    contextualBonus: 1,
  },

  // ─── Coworking ───
  {
    id: 'coworking',
    label: 'Coworking Space',
    keywords: [
      { term: 'shared office', weight: 3 },
      { term: 'office space', weight: 3 },
      { term: 'coworking space', weight: 3 },
      { term: 'co-working space', weight: 3 },
      { term: 'coworking', weight: 2 },
      { term: 'co-working', weight: 2 },
      { term: 'workspace', weight: 2 },
      { term: 'incubator', weight: 1 },
      { term: 'accelerator', weight: 1 },
    ],
    contextualPatterns: [
      /(?:cowork|workspace|office).*(?:tech|startup|freelanc)/i,
    ],
    contextualBonus: 1,
  },

  // ─── Real Estate ───
  {
    id: 'realestate',
    label: 'Real Estate / Mixed-use',
    keywords: [
      { term: 'residential project', weight: 3 },
      { term: 'mixed-use', weight: 3 },
      { term: 'mixed use', weight: 3 },
      { term: 'apartment complex', weight: 3 },
      { term: 'real estate', weight: 3 },
      { term: 'gated community', weight: 3 },
      { term: 'housing', weight: 2 },
      { term: 'apartment', weight: 2 },
      { term: 'township', weight: 2 },
      { term: 'villa', weight: 2 },
      { term: 'property', weight: 1 },
      { term: 'development', weight: 1 },
      { term: 'plot', weight: 1 },
    ],
    contextualPatterns: [
      /(?:residential|mixed[\s-]use|township).*(?:development|project|land)/i,
    ],
    contextualBonus: 1,
  },
];
