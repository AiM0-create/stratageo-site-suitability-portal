import type { MCDACriteria, LocationData } from '../types';
import type { OSMData } from './osmService';

interface ScoredNeighborhood {
  name: string;
  lat: number;
  lng: number;
  osmData: OSMData;
}

function scoreCriteria(name: string, value: number, context: string): { score: number; justification: string } {
  const score = Math.min(10, Math.max(1, value));
  return { score: Math.round(score * 10) / 10, justification: context };
}

function computeCompetitiveLandscape(competitors: number): { score: number; justification: string } {
  // Lower competition = higher score, but some competition validates demand
  if (competitors === 0) return scoreCriteria('Competitive Landscape', 7, `No direct competitors found within 1km. Low competition but market demand is unvalidated.`);
  if (competitors <= 3) return scoreCriteria('Competitive Landscape', 9, `Only ${competitors} competitor(s) within 1km indicates an underserved market with validated demand.`);
  if (competitors <= 8) return scoreCriteria('Competitive Landscape', 7, `${competitors} competitors within 1km suggests healthy demand with manageable competition.`);
  if (competitors <= 15) return scoreCriteria('Competitive Landscape', 5, `${competitors} competitors within 1km indicates a moderately saturated market. Differentiation is key.`);
  return scoreCriteria('Competitive Landscape', 3, `${competitors} competitors within 1km reflects high saturation. Strong differentiation required to compete.`);
}

function computeTransitAccessibility(transport: number): { score: number; justification: string } {
  if (transport === 0) return scoreCriteria('Transit Accessibility', 2, 'No public transit stops found within 1km. Area is vehicle-dependent.');
  if (transport <= 3) return scoreCriteria('Transit Accessibility', 4, `${transport} transit stops within 1km provide basic but limited public transport access.`);
  if (transport <= 8) return scoreCriteria('Transit Accessibility', 7, `${transport} transit stops within 1km ensure reasonable commuter access and walk-in potential.`);
  if (transport <= 15) return scoreCriteria('Transit Accessibility', 8, `${transport} transit stops within 1km indicate strong public transport connectivity.`);
  return scoreCriteria('Transit Accessibility', 9, `${transport} transit stops within 1km reflect excellent multi-modal transit access.`);
}

function computeCommercialVibrancy(commercial: number): { score: number; justification: string } {
  if (commercial === 0) return scoreCriteria('Commercial Vibrancy', 1, 'No commercial establishments found within 1km. Area lacks commercial ecosystem.');
  if (commercial <= 5) return scoreCriteria('Commercial Vibrancy', 3, `${commercial} commercial establishments within 1km suggest a nascent commercial environment.`);
  if (commercial <= 15) return scoreCriteria('Commercial Vibrancy', 5, `${commercial} commercial establishments within 1km indicate a developing commercial area.`);
  if (commercial <= 30) return scoreCriteria('Commercial Vibrancy', 7, `${commercial} commercial establishments within 1km reflect a vibrant commercial ecosystem with good footfall potential.`);
  return scoreCriteria('Commercial Vibrancy', 9, `${commercial} commercial establishments within 1km indicate a thriving commercial district with high foot traffic.`);
}

function computeResidentialCatchment(residential: number): { score: number; justification: string } {
  if (residential === 0) return scoreCriteria('Residential Catchment', 2, 'No residential buildings mapped within 1km. Limited local customer base.');
  if (residential <= 5) return scoreCriteria('Residential Catchment', 4, `${residential} residential buildings within 1km provide a small but present local customer base.`);
  if (residential <= 15) return scoreCriteria('Residential Catchment', 6, `${residential} residential buildings within 1km offer a moderate local population catchment.`);
  if (residential <= 30) return scoreCriteria('Residential Catchment', 8, `${residential} residential buildings within 1km ensure a strong base of potential repeat customers.`);
  return scoreCriteria('Residential Catchment', 9, `${residential} residential buildings within 1km indicate a dense residential catchment with high repeat-visit potential.`);
}

function computeFootfallPotential(commercial: number, transport: number): { score: number; justification: string } {
  const combined = commercial + transport;
  if (combined <= 5) return scoreCriteria('Pedestrian Footfall Potential', 3, `Low combined commercial and transit density (${combined} POIs) suggests limited organic foot traffic.`);
  if (combined <= 15) return scoreCriteria('Pedestrian Footfall Potential', 5, `Moderate combined activity (${combined} POIs) provides some organic foot traffic.`);
  if (combined <= 30) return scoreCriteria('Pedestrian Footfall Potential', 7, `Good combined commercial and transit density (${combined} POIs) supports solid pedestrian footfall.`);
  return scoreCriteria('Pedestrian Footfall Potential', 9, `High combined activity (${combined} POIs) indicates excellent pedestrian footfall in the area.`);
}

export function scoreNeighborhood(data: OSMData): MCDACriteria[] {
  const criteria: MCDACriteria[] = [
    { name: 'Competitive Landscape', weight: 0.20, ...computeCompetitiveLandscape(data.competitors) },
    { name: 'Transit Accessibility', weight: 0.15, ...computeTransitAccessibility(data.transport) },
    { name: 'Commercial Vibrancy', weight: 0.20, ...computeCommercialVibrancy(data.commercial_density) },
    { name: 'Residential Catchment', weight: 0.15, ...computeResidentialCatchment(data.residential_density) },
    { name: 'Pedestrian Footfall Potential', weight: 0.15, ...computeFootfallPotential(data.commercial_density, data.transport) },
    { name: 'Complementary Infrastructure', weight: 0.15, ...computeComplementaryScore(data) },
  ];
  return criteria;
}

function computeComplementaryScore(data: OSMData): { score: number; justification: string } {
  const total = data.commercial_density + data.transport;
  if (total <= 5) return { score: 3, justification: 'Limited complementary services in the vicinity.' };
  if (total <= 20) return { score: 6, justification: `${total} nearby amenities provide moderate complementary infrastructure for customer synergy.` };
  return { score: 8, justification: `${total} nearby amenities create a strong ecosystem of complementary services.` };
}

export function computeMCDAScore(criteria: MCDACriteria[]): number {
  let totalWeighted = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    totalWeighted += c.score * c.weight;
    totalWeight += c.weight;
  }
  return totalWeight > 0 ? Math.round((totalWeighted / totalWeight) * 10) / 10 : 0;
}

export function recalculateWithWeights(locations: LocationData[], customWeights: Record<string, number>): LocationData[] {
  if (Object.keys(customWeights).length === 0) return locations;

  return locations.map(loc => {
    let totalWeightedScore = 0;
    let totalWeight = 0;

    const newCriteria = loc.criteria_breakdown.map(c => {
      const weight = customWeights[c.name] ?? c.weight;
      totalWeightedScore += c.score * weight;
      totalWeight += weight;
      return { ...c, weight };
    });

    const newScore = totalWeight > 0 ? Math.round((totalWeightedScore / totalWeight) * 10) / 10 : 0;
    return { ...loc, mcda_score: newScore, criteria_breakdown: newCriteria };
  });
}

export function inferFootfall(commercial: number, transport: number): string {
  const combined = commercial + transport;
  if (combined > 25) return 'High';
  if (combined > 10) return 'Medium';
  return 'Low';
}

export function generateTemplateReasoning(name: string, businessType: string, osmData: OSMData): string {
  const { competitors, transport, commercial_density, residential_density } = osmData;
  return `${name} shows ${competitors} direct competitors, ${transport} transit stops, ${commercial_density} commercial establishments, and ${residential_density} residential buildings within a 1km radius. ` +
    `This combination suggests ${commercial_density > 20 ? 'a vibrant commercial environment' : 'a developing commercial area'} ` +
    `with ${transport > 8 ? 'strong' : 'moderate'} transit access for a ${businessType} venture.`;
}

export function generateTemplateStrategy(businessType: string, osmData: OSMData): string {
  if (osmData.competitors > 15) {
    return `In a competitive market for ${businessType}, differentiation through unique offerings, superior customer experience, and targeted marketing will be essential. Consider niche positioning and local partnerships.`;
  }
  if (osmData.competitors > 5) {
    return `Moderate competition creates opportunity for a well-positioned ${businessType}. Focus on quality, convenience, and building a loyal local customer base through community engagement.`;
  }
  return `Low existing competition presents a first-mover advantage for ${businessType}. Focus on establishing brand presence early and building community awareness through local outreach and partnerships.`;
}
