/**
 * Business Classifier — Multi-signal, scoring-based sector classification.
 *
 * Replaces the naive keyword-loop-with-cafe-fallback in detectSector().
 * Uses weighted keyword matching from the ontology, contextual phrase
 * boosting, and confidence scoring to correctly classify prompts.
 *
 * HARD RULE: Never fallback to a generic category when strong domain
 * signals exist.
 */

import { DOMAIN_ONTOLOGY, type DomainEntry } from './keywordOntology';

// ─── Types ───

export interface ClassificationResult {
  sectorId: string;
  label: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  matchedKeywords: string[];
  reasoning: string;
}

interface DomainScore {
  domain: DomainEntry;
  score: number;
  matchedKeywords: string[];
  contextualHit: boolean;
}

// ─── Helpers ───

/**
 * Build a word-boundary regex for a keyword term.
 * Multi-word phrases use boundaries at start/end only.
 */
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

// ─── Main classifier ───

export function classifyBusinessType(text: string): ClassificationResult {
  const lower = text.toLowerCase();

  const scores: DomainScore[] = DOMAIN_ONTOLOGY.map(domain => {
    let score = 0;
    const matchedKeywords: string[] = [];
    const matchedPositions = new Set<number>(); // track character positions to avoid double-counting

    // Sort keywords by term length descending (longest match first)
    const sortedKeywords = [...domain.keywords].sort(
      (a, b) => b.term.length - a.term.length,
    );

    for (const kw of sortedKeywords) {
      const regex = termRegex(kw.term);
      const match = regex.exec(lower);
      if (match) {
        // Check if this position was already claimed by a longer match
        const start = match.index;
        const end = start + match[0].length;
        let alreadyCounted = false;
        for (let i = start; i < end; i++) {
          if (matchedPositions.has(i)) {
            alreadyCounted = true;
            break;
          }
        }

        if (!alreadyCounted) {
          score += kw.weight;
          matchedKeywords.push(kw.term);
          for (let i = start; i < end; i++) {
            matchedPositions.add(i);
          }
        }
      }
    }

    // Contextual phrase bonus
    let contextualHit = false;
    for (const pattern of domain.contextualPatterns) {
      if (pattern.test(lower)) {
        score += domain.contextualBonus;
        contextualHit = true;
        break; // one bonus per domain max
      }
    }

    return { domain, score, matchedKeywords, contextualHit };
  });

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];

  // ─── Confidence decision ───

  let confidence: ClassificationResult['confidence'];
  let sectorId: string;
  let label: string;
  let reasoning: string;

  if (best.score >= 4) {
    confidence = 'high';
    sectorId = best.domain.id;
    label = best.domain.label;
    reasoning = `Strong match: ${best.matchedKeywords.join(', ')} (score ${best.score})`;
  } else if (best.score >= 2) {
    confidence = 'medium';
    sectorId = best.domain.id;
    label = best.domain.label;
    reasoning = `Moderate match: ${best.matchedKeywords.join(', ')} (score ${best.score})`;
  } else if (best.score > 0 && second && second.score > 0 && best.score - second.score <= 1) {
    // Ambiguous — two domains close in score
    confidence = 'low';
    sectorId = best.domain.id;
    label = best.domain.label;
    reasoning = `Ambiguous: ${best.domain.label} (${best.score}) vs ${second.domain.label} (${second.score})`;
  } else if (best.score > 0) {
    confidence = 'low';
    sectorId = best.domain.id;
    label = best.domain.label;
    reasoning = `Weak match: ${best.matchedKeywords.join(', ')} (score ${best.score})`;
  } else {
    // No matches at all — legitimate fallback
    confidence = 'low';
    sectorId = 'cafe';
    label = 'Cafe / Restaurant';
    reasoning = 'No domain keywords detected. Using default.';
  }

  // ─── HARD RULE: never fallback to cafe when another domain scored ≥ 2 ───
  if (sectorId === 'cafe' && confidence === 'low') {
    const nonCafeBest = scores.find(s => s.domain.id !== 'cafe' && s.score >= 2);
    if (nonCafeBest) {
      sectorId = nonCafeBest.domain.id;
      label = nonCafeBest.domain.label;
      confidence = 'medium';
      reasoning = `Overrode default: ${nonCafeBest.matchedKeywords.join(', ')} (score ${nonCafeBest.score})`;
    }
  }

  return {
    sectorId,
    label,
    confidence,
    score: best.score,
    matchedKeywords: best.matchedKeywords,
    reasoning,
  };
}

/**
 * Extract the best display name for the business type from the prompt.
 * Uses matched keywords to find the most specific phrase the user actually wrote.
 */
export function extractBusinessLabel(text: string, classification: ClassificationResult): string {
  const lower = text.toLowerCase();

  // Find the longest matched keyword that appears in the text — use as label
  const sorted = [...classification.matchedKeywords].sort((a, b) => b.length - a.length);
  for (const kw of sorted) {
    if (termRegex(kw).test(lower)) {
      // Capitalize each word
      return kw.replace(/\b\w/g, c => c.toUpperCase());
    }
  }

  return classification.label;
}
