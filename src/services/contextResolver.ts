/**
 * Context Resolver — Detects follow-up queries and enriches prompts
 * with session context for conversational continuity.
 */

import type { WorkingMemory, SessionMessage } from '../types/session';

export interface ResolvedContext {
  isFollowUp: boolean;
  effectivePrompt: string;
  contextSummary: string;
  changes: string[];
}

// Words/phrases that signal a follow-up rather than a new query
const FOLLOW_UP_STARTERS = [
  'rerun', 're-run', 'same but', 'same with', 'change', 'try again',
  'now ', 'what about', 'instead', 'also ', 'but ', 'with ',
  'without ', 'increase', 'decrease', 'reduce', 'expand',
  'how about', 'switch to', 'update', 'modify', 'adjust',
];

const RESULT_REFERENCES = [
  'those locations', 'the top', 'location #', 'the best',
  'that area', 'those areas', 'the results', 'previous',
  'last analysis', 'earlier', 'the same',
];

export function resolveContext(
  rawPrompt: string,
  memory: WorkingMemory,
  recentMessages: SessionMessage[],
): ResolvedContext {
  // No memory = nothing to follow up on
  if (!memory.lastAnalysisTimestamp) {
    return {
      isFollowUp: false,
      effectivePrompt: rawPrompt,
      contextSummary: '',
      changes: [],
    };
  }

  const lower = rawPrompt.toLowerCase().trim();
  const isFollowUp = detectFollowUp(lower, memory);

  if (!isFollowUp) {
    return {
      isFollowUp: false,
      effectivePrompt: rawPrompt,
      contextSummary: '',
      changes: [],
    };
  }

  // Build context string for GPT
  const contextParts: string[] = [];
  const changes: string[] = [];

  if (memory.businessType) {
    contextParts.push(`Business type: ${memory.businessType}`);
  }
  if (memory.city) {
    contextParts.push(`City: ${memory.city}`);
  }
  if (memory.coordinates) {
    contextParts.push(`Coordinates: ${memory.coordinates.lat.toFixed(4)}, ${memory.coordinates.lng.toFixed(4)}`);
  }
  if (memory.constraints.length > 0) {
    contextParts.push(`Constraints: ${memory.constraints.join('; ')}`);
  }
  if (memory.csvPointCount > 0) {
    contextParts.push(`CSV: ${memory.csvPointCount} points${memory.csvFileName ? ` from ${memory.csvFileName}` : ''}`);
  }
  if (memory.lastSearchRadiusM) {
    contextParts.push(`Search radius: ${(memory.lastSearchRadiusM / 1000).toFixed(1)}km`);
  }
  if (memory.lastResultCount > 0) {
    contextParts.push(`Last results: ${memory.lastResultCount} locations`);
  }

  const contextSummary = contextParts.join('. ');
  const effectivePrompt = `[Context: Previously analyzed ${memory.businessType || 'unknown'} in ${memory.city || 'unknown location'}. ${contextSummary}.]\nUser's follow-up: ${rawPrompt}`;

  // Detect what's changing
  if (detectCityChange(lower)) changes.push('city');
  if (detectRadiusChange(lower)) changes.push('radius');
  if (detectCountChange(lower)) changes.push('result count');
  if (lower.includes('csv') || lower.includes('upload')) changes.push('CSV data');

  return {
    isFollowUp,
    effectivePrompt,
    contextSummary: `Carrying forward: ${contextSummary}`,
    changes,
  };
}

function detectFollowUp(lower: string, memory: WorkingMemory): boolean {
  // 1. Starts with follow-up words
  if (FOLLOW_UP_STARTERS.some(s => lower.startsWith(s))) return true;

  // 2. References prior results
  if (RESULT_REFERENCES.some(r => lower.includes(r))) return true;

  // 3. Short prompt that modifies a single dimension
  if (lower.length < 40) {
    // Just a city name
    if (detectCityChange(lower) && !lower.includes(' in ') && !detectBusinessType(lower)) return true;
    // Just a radius change
    if (detectRadiusChange(lower)) return true;
    // Just a number (result count)
    if (/^\d+\s*(results?|locations?)?\s*$/.test(lower)) return true;
  }

  return false;
}

function detectCityChange(lower: string): boolean {
  return /\b(in|to|for)\s+[A-Z]/.test(lower) || /\b(mumbai|delhi|bengaluru|bangalore|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur)\b/i.test(lower);
}

function detectRadiusChange(lower: string): boolean {
  return /\d+\s*(km|m|meter|kilometer|radius)/i.test(lower);
}

function detectCountChange(lower: string): boolean {
  return /\d+\s*(results?|locations?|sites?|places?)/i.test(lower);
}

function detectBusinessType(lower: string): boolean {
  const businessWords = ['cafe', 'store', 'warehouse', 'farm', 'clinic', 'school', 'preschool', 'restaurant', 'hotel', 'office', 'factory', 'station'];
  return businessWords.some(w => lower.includes(w));
}
