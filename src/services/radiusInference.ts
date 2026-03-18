/**
 * Radius Inference — Determines appropriate exclusion/inclusion radius
 * when the user doesn't specify one explicitly.
 *
 * Based on sector type and urban density context.
 */

export interface InferredRadius {
  radiusM: number;
  reason: string;
}

// Sector-specific default exclusion radii (meters)
const SECTOR_DEFAULTS: Record<string, number> = {
  cafe: 2000,
  retail: 2000,
  preschool: 1500,
  clinic: 1500,
  coworking: 2000,
  ev: 4000,
  realestate: 3000,
  logistics: 8000,
  warehouse: 10000,
  solar: 15000,
};

// Known metro/dense cities get a tighter radius
const METRO_CITIES = new Set([
  'mumbai', 'delhi', 'bengaluru', 'bangalore', 'chennai',
  'kolkata', 'hyderabad', 'pune', 'ahmedabad', 'gurugram',
  'gurgaon', 'noida', 'navi mumbai', 'thane',
]);

/**
 * Infer a reasonable buffer radius based on business type and city.
 *
 * @param sectorId — The sector template ID (e.g., 'cafe', 'logistics')
 * @param cityName — Optional city name for urban density adjustment
 * @returns radius in meters + human-readable explanation
 */
export function inferRadius(sectorId: string, cityName?: string): InferredRadius {
  const baseRadius = SECTOR_DEFAULTS[sectorId] ?? 3000;
  const sectorLabel = sectorId.charAt(0).toUpperCase() + sectorId.slice(1);

  let radiusM = baseRadius;
  let densityNote = '';

  if (cityName) {
    const normalizedCity = cityName.toLowerCase().trim();
    if (METRO_CITIES.has(normalizedCity)) {
      radiusM = Math.round(baseRadius * 0.7);
      densityNote = ` (adjusted down for dense urban area: ${cityName})`;
    }
  }

  const radiusKm = (radiusM / 1000).toFixed(1);
  return {
    radiusM,
    reason: `Inferred ${radiusKm}km radius for ${sectorLabel} sector${densityNote}. Based on typical spacing patterns for this business type.`,
  };
}
