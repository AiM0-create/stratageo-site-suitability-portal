/**
 * Context Resolver — Detects follow-up queries and enriches prompts
 * with session context for conversational continuity.
 */

import type { WorkingMemory, SessionMessage } from '../types/session';
import { isResetIntent } from './resetPatterns';

export interface ResolvedContext {
  isFollowUp: boolean;
  effectivePrompt: string;
  contextSummary: string;
  changes: string[];
  resetDetected: boolean;
}

// RESET_PATTERNS live in ./resetPatterns.ts — shared source of truth with the backend.
// Use isResetIntent() below instead of duplicating the array here.

// Words/phrases that signal a follow-up rather than a new query
const FOLLOW_UP_STARTERS = [
  'rerun', 're-run', 'same but', 'same with', 'change', 'try again',
  'now ', 'what about', 'instead', 'also ', 'but ', 'with ',
  'without ', 'increase', 'decrease', 'reduce', 'expand',
  'how about', 'switch to', 'update', 'modify', 'adjust',
  // Scoring / weight modifications
  'recalculate', 'rerank', 're-rank', 'reweight', 'reprioritize',
  'penaliz', 'penalis', 'boost', 'weight ', 'higher weight', 'lower weight',
  'score ', 'rescore',
  // Referring to previous suggestions / results
  'one of your', 'one of those', 'that suggestion', 'your suggestion',
  'that location', 'isn\'t that', 'is that', 'that\'s too', 'that is too',
  'too close', 'too far', 'not good', 'looks good', 'seems good',
  // Geographic modifications
  'exclude ', 'add ', 'remove ', 'drop ',
  'closer to', 'further from', 'near ', 'away from',
];

const RESULT_REFERENCES = [
  'those locations', 'the top', 'location #', 'the best',
  'that area', 'those areas', 'the results', 'previous',
  'last analysis', 'earlier', 'the same',
  // References to portal output
  'your suggestion', 'your result', 'you suggested', 'you recommended',
  'one of your', 'lower parel', 'the locations you', 'ranked location',
  'existing sites', 'existing branch', 'my branch', 'our branch',
  'my existing', 'our existing',
  // Hindi/Hinglish industrial vocabulary that commonly appears in follow-ups
  // (RIICO, MIDC, GIDC = Indian industrial development authority names)
  'riico', 'midc', 'gidc', 'kiadb', 'sidco', 'apiic',
  'industrial area', 'industrial zone', 'industrial estate',
  'theek hai', 'theek he', 'sahi hai',   // "that's okay/fine"
  'lekin ', 'par ', 'magar ',            // "but" — follows a reference to prior result
  'wahan ', 'wahan ke',                  // "there" — refers to previously mentioned area
  'include kar', 'shamil kar', 'add kar', // "include" — wants to add to prior results
  'dekhna chahte', 'dekhna chahiye',     // "want to see" — refers to prior analysis
  'dobaara', 'dobara', 'phir se',        // "again/redo" — re-run prior analysis
];

export function resolveContext(
  rawPrompt: string,
  memory: WorkingMemory,
  recentMessages: SessionMessage[],
): ResolvedContext {
  // Explicit reset request — always discard prior context, even if memory exists
  if (isResetIntent(rawPrompt)) {
    return {
      isFollowUp: false,
      effectivePrompt: rawPrompt,
      contextSummary: '',
      changes: [],
      resetDetected: true,
    };
  }

  // No memory = nothing to follow up on
  if (!memory.lastAnalysisTimestamp) {
    return {
      isFollowUp: false,
      effectivePrompt: rawPrompt,
      contextSummary: '',
      changes: [],
      resetDetected: false,
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
      resetDetected: false,
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

  // Build a self-sufficient effective prompt so GPT can always extract businessType + locationName.
  // The follow-up text alone (e.g. "recalculate penalizing proximity more") doesn't contain
  // these fields — we need to inject them explicitly.
  const bizPart = memory.businessType ? `${memory.businessType}` : 'the business';
  const cityPart = memory.city ? ` in ${memory.city}` : '';
  const constraintPart = memory.constraints.length > 0
    ? ` Existing constraints: ${memory.constraints.join(', ')}.` : '';
  const effectivePrompt =
    `Continuing site suitability analysis for a ${bizPart}${cityPart}.${constraintPart} ` +
    `User modification: ${rawPrompt}`;

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
    resetDetected: false,
  };
}

function detectFollowUp(lower: string, memory: WorkingMemory): boolean {
  // 1. Starts with follow-up words
  if (FOLLOW_UP_STARTERS.some(s => lower.startsWith(s))) return true;

  // 2. Contains follow-up words anywhere (for longer phrases)
  if (FOLLOW_UP_STARTERS.some(s => s.length > 6 && lower.includes(s))) return true;

  // 3. References prior results
  if (RESULT_REFERENCES.some(r => lower.includes(r))) return true;

  // 4. Short prompt that modifies a single dimension
  if (lower.length < 40) {
    // Just a city name
    if (detectCityChange(lower) && !lower.includes(' in ') && !detectBusinessType(lower)) return true;
    // Just a radius change
    if (detectRadiusChange(lower)) return true;
    // Just a number (result count)
    if (/^\d+\s*(results?|locations?)?\s*$/.test(lower)) return true;
  }

  // 5. Smart fallback: if we have prior memory AND the prompt doesn't introduce a
  //    fresh business type + Indian city together, it's almost certainly a follow-up.
  //    This catches conversational phrases like "Isn't that too close to Worli?"
  //    that reference prior results without using standard follow-up keywords.
  if (memory.businessType && memory.city) {
    const hasNewCity = /\b(in|at|near|for)\s+(mumbai|delhi|bengaluru|bangalore|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|lucknow|surat|nagpur|indore|bhopal|chandigarh|kochi|coimbatore|nashik|vadodara|gurgaon|gurugram|noida|faridabad|meerut)\b/i.test(lower);
    const hasNewBizType = detectBusinessType(lower) && !lower.includes(memory.businessType.toLowerCase().split(' ')[0]);
    const looksLikeNewQuery = hasNewCity && hasNewBizType;
    // Increased from 200 → 300 chars to catch longer Hinglish follow-ups
    if (!looksLikeNewQuery && lower.length < 300) return true;
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
