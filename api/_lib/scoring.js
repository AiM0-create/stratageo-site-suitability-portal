/**
 * MCDA scoring engine — server-side port of src/services/mcdaEngine.ts.
 *
 * All functions are pure (no side effects, no I/O).
 * Input types use plain JS objects matching the frontend TypeScript shapes.
 */

// ─── Interpolation helpers ───

function lerp(value, fromLow, fromHigh, toLow, toHigh) {
  if (fromHigh === fromLow) return toHigh;
  return toLow + ((value - fromLow) / (fromHigh - fromLow)) * (toHigh - toLow);
}

/**
 * Positive criterion: more = better.
 * Breakpoints t[0..4] map to score anchors [1, 3, 5, 7, 8.5], beyond → 9.5.
 */
export function interpolatePositive(raw, t) {
  const anchors = [1, 3, 5, 7, 8.5, 9.5];
  if (raw <= t[0]) return anchors[0];
  if (raw <= t[1]) return lerp(raw, t[0], t[1], anchors[0], anchors[1]);
  if (raw <= t[2]) return lerp(raw, t[1], t[2], anchors[1], anchors[2]);
  if (raw <= t[3]) return lerp(raw, t[2], t[3], anchors[2], anchors[3]);
  if (raw <= t[4]) return lerp(raw, t[3], t[4], anchors[3], anchors[4]);
  const excess = raw - t[4];
  const range = t[4] - t[3] || 1;
  return anchors[4] + (anchors[5] - anchors[4]) * (1 - Math.exp(-excess / range));
}

/**
 * Negative criterion: fewer = better.
 * 0 → 9; beyond t[4] → 1.
 */
export function interpolateNegative(raw, t) {
  const anchors = [9, 7, 5, 3.5, 2, 1];
  if (raw === 0) return anchors[0];
  if (raw <= t[1]) return lerp(raw, 0, t[1], anchors[0], anchors[1]);
  if (raw <= t[2]) return lerp(raw, t[1], t[2], anchors[1], anchors[2]);
  if (raw <= t[3]) return lerp(raw, t[2], t[3], anchors[2], anchors[3]);
  if (raw <= t[4]) return lerp(raw, t[3], t[4], anchors[3], anchors[4]);
  const excess = raw - t[4];
  const range = t[4] - t[3] || 1;
  return anchors[4] - (anchors[4] - anchors[5]) * (1 - Math.exp(-excess / range));
}

// ─── Single criterion scoring ───

/**
 * Score one dynamic criterion.
 *
 * criterion: { name, direction, weight, scoringThresholds, signalKey }
 * rawValue: observed count from OSM
 * radiusM: search radius used (for justification text)
 *
 * Returns an MCDACriteria-shaped object.
 */
export function scoreDynamicCriterion(criterion, rawValue, radiusM) {
  const { name, direction, weight } = criterion;
  const t = criterion.scoringThresholds || [0, 3, 8, 15, 25];

  const score = direction === 'positive'
    ? interpolatePositive(rawValue, t)
    : interpolateNegative(rawValue, t);

  const radiusKm = (radiusM / 1000).toFixed(1);
  let justification;

  if (direction === 'negative') {
    if (rawValue === 0) justification = `No ${name.toLowerCase()} detected within ${radiusKm}km — ideal.`;
    else if (score >= 7) justification = `Minimal ${name.toLowerCase()} (${rawValue}) within ${radiusKm}km — low risk.`;
    else if (score >= 4) justification = `Moderate ${name.toLowerCase()} concentration (${rawValue} within ${radiusKm}km).`;
    else justification = `High ${name.toLowerCase()} density (${rawValue} within ${radiusKm}km) — concern.`;
  } else {
    if (rawValue === 0) justification = `No ${name.toLowerCase()} found within ${radiusKm}km — a gap for this use case.`;
    else if (score >= 8) justification = `Strong ${name.toLowerCase()} coverage (${rawValue} within ${radiusKm}km).`;
    else if (score >= 5) justification = `Moderate ${name.toLowerCase()} presence (${rawValue} within ${radiusKm}km).`;
    else justification = `Limited ${name.toLowerCase()} nearby (${rawValue} within ${radiusKm}km).`;
  }

  // Flag zero rawValue as potentially missing data, not confirmed absence
  const evidenceBasis = rawValue > 0 ? 'osm-observed' : 'osm-absent';

  return {
    name,
    weight,
    score: Math.round(score * 10) / 10,
    rawValue,
    direction,
    justification,
    evidenceBasis,
  };
}

/**
 * Score all dynamic criteria for a location.
 * osmSignals: Record<signalKey, count>
 * dynamicCriteria: Array of { name, signalKey, direction, weight, scoringThresholds }
 */
export function scoreWithDynamicCriteria(osmSignals, dynamicCriteria, radiusM) {
  return dynamicCriteria.map(c => {
    const raw = osmSignals[c.signalKey] ?? 0;
    return scoreDynamicCriterion(c, raw, radiusM);
  });
}

// ─── Profile alignment scoring ───

/**
 * Add profile-level criteria: land availability, location-type fit, and
 * (for industrial profiles) industrial zone compatibility.
 *
 * profile: { landIntensity, urbanPreference, marketPositioning }
 * osmSignals: Record<signalKey, count> — used to infer density and zone type
 */
export function scoreProfileAlignment(osmSignals, profile) {
  const criteria = [];
  const totalPOIs = Object.values(osmSignals).reduce((a, b) => a + b, 0);

  if (profile.landIntensity === 'high' || profile.landIntensity === 'medium') {
    const isHigh = profile.landIntensity === 'high';
    let score, justification, dynamicWeight;

    if (totalPOIs > 80) {
      score = isHigh ? 1.0 : 2.5;
      dynamicWeight = isHigh ? 0.45 : 0.15;
      justification = `Dense urban area (${totalPOIs} features). ${isHigh ? 'No viable open land — dealbreaker for land-intensive use.' : 'Limited land for medium-footprint operations.'}`;
    } else if (totalPOIs > 40) {
      score = isHigh ? 2.5 : 4.5;
      dynamicWeight = isHigh ? 0.30 : 0.12;
      justification = `Moderate density (${totalPOIs} features). ${isHigh ? 'Land likely insufficient for large-footprint operations.' : 'Some plots may be available but constrained.'}`;
    } else if (totalPOIs > 15) {
      score = isHigh ? 5.0 : 6.5;
      dynamicWeight = isHigh ? 0.20 : 0.10;
      justification = `Suburban density (${totalPOIs} features). ${isHigh ? 'Land parcels may exist — verify with site survey.' : 'Reasonable land availability for medium footprint.'}`;
    } else if (totalPOIs > 5) {
      score = isHigh ? 7.5 : 7.0;
      dynamicWeight = isHigh ? 0.15 : 0.08;
      justification = `Low density (${totalPOIs} features). Good land availability expected.`;
    } else {
      score = isHigh ? 9.0 : 7.0;
      dynamicWeight = isHigh ? 0.10 : 0.08;
      justification = `Very sparse area (${totalPOIs} features). Ample open land likely available.`;
    }

    criteria.push({
      name: 'Land availability',
      weight: dynamicWeight,
      score: Math.round(score * 10) / 10,
      rawValue: totalPOIs,
      direction: 'negative',
      justification,
      evidenceBasis: 'osm-observed',
    });
  }

  const urbanPref = profile.urbanPreference;
  if (urbanPref && urbanPref !== 'flexible') {
    const prefersUrban = urbanPref === 'urban_core' || urbanPref === 'urban';
    const prefersRural = urbanPref === 'rural' || urbanPref === 'periurban';
    const isDense = totalPOIs > 40;
    const isSparse = totalPOIs < 10;
    let score, justification;

    if (prefersUrban && isDense) {
      score = 8.5;
      justification = `Urban location matches ${urbanPref.replace('_', ' ')} preference (${totalPOIs} features).`;
    } else if (prefersUrban && isSparse) {
      score = 2.0;
      justification = `Sparse area doesn't match ${urbanPref.replace('_', ' ')} preference — insufficient urban development.`;
    } else if (prefersRural && isSparse) {
      score = 8.5;
      justification = `Low-density area matches ${urbanPref} preference (${totalPOIs} features).`;
    } else if (prefersRural && isDense) {
      score = 2.5;
      justification = `Dense urban area conflicts with ${urbanPref} preference — too developed.`;
    } else {
      score = 5.5;
      justification = `Moderate density (${totalPOIs} features) — partial match for ${urbanPref.replace('_', ' ')}.`;
    }

    criteria.push({
      name: 'Location-type fit',
      weight: 0.15,
      score: Math.round(score * 10) / 10,
      rawValue: totalPOIs,
      direction: prefersUrban ? 'positive' : 'negative',
      justification,
      evidenceBasis: 'osm-observed',
    });
  }

  // ── Industrial zone compatibility ─────────────────────────────────────
  // For industrial / warehouse / logistics profiles, score based on the
  // presence of industrial-type OSM signals (landuse=industrial,
  // building=industrial, building=warehouse etc.) in the candidate area.
  // This prevents commercial/residential areas from outranking industrial
  // estates purely on road-proximity when they have zero industrial land use.
  if (profile.marketPositioning === 'industrial') {
    // Sum all signal keys that relate to industrial land use
    const industrialSignalCount = Object.entries(osmSignals)
      .filter(([key]) => /industrial|warehouse|freight|logistics/i.test(key))
      .reduce((sum, [, val]) => sum + val, 0);

    // Thresholds tuned for industrial OSM sparseness in India:
    // 0 features → 1/10 (strong penalty for non-industrial area)
    // 1 → ~3, 3 → ~5, 7 → ~7, 15 → ~8.5+
    const indScore = interpolatePositive(industrialSignalCount, [0, 1, 3, 7, 15]);

    let indJustification;
    if (industrialSignalCount === 0) {
      indJustification = 'No industrial land use detected — area may not be suitable for warehouse/industrial operations.';
    } else if (indScore >= 7) {
      indJustification = `Strong industrial land use presence (${industrialSignalCount} features) — well-suited for warehouse operations.`;
    } else if (indScore >= 4) {
      indJustification = `Moderate industrial land use (${industrialSignalCount} features) — partial suitability for logistics/warehouse use.`;
    } else {
      indJustification = `Light industrial presence (${industrialSignalCount} features) — verify industrial zoning before committing.`;
    }

    criteria.push({
      name: 'Industrial zone compatibility',
      weight: 0.25,
      score: Math.round(indScore * 10) / 10,
      rawValue: industrialSignalCount,
      direction: 'positive',
      justification: indJustification,
      evidenceBasis: industrialSignalCount > 0 ? 'osm-observed' : 'osm-absent',
    });
  }

  return criteria;
}

// ─── Weighted MCDA score ───

/**
 * Compute the weighted average of all criteria scores.
 * criteria: Array of { score, weight }
 */
export function computeMCDAScore(criteria) {
  let totalWeighted = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    if (c.weight <= 0) continue;
    totalWeighted += c.score * c.weight;
    totalWeight += c.weight;
  }
  return totalWeight > 0 ? Math.round((totalWeighted / totalWeight) * 10) / 10 : 0;
}

// ─── Hard exclusion checks ───

/**
 * Check OSM-based hard exclusion rules.
 *
 * exclusions: Array of { target, direction }
 *   direction='away' means "this feature must NOT be present in signals"
 * osmSignals: Record<signalKey, count>
 *
 * Returns Array of { rule, passed, detail, evidenceBasis }
 */
export function checkExclusions(osmSignals, exclusions) {
  const checks = [];
  for (const exc of exclusions) {
    if (exc.direction !== 'away') continue;
    const signalKey = exc.target.toLowerCase().replace(/\s+/g, '_');
    const count = osmSignals[signalKey] || 0;
    const passed = count === 0;
    checks.push({
      rule: `Exclude: ${exc.target}`,
      passed,
      detail: passed
        ? `No ${exc.target.toLowerCase()} found within search radius — exclusion passed.`
        : `${count} ${exc.target.toLowerCase()} found — exclusion failed.`,
      evidenceBasis: 'osm-observed',
    });
  }
  return checks;
}

// ─── Human-readable reasoning ───

/**
 * Generate a concise reasoning string for a candidate location.
 * Mirrors generateReasoning() in mcdaEngine.ts.
 */
export function generateReasoning(name, criteria, exclusions, radiusM) {
  const radiusKm = (radiusM / 1000).toFixed(1);
  const parts = [];

  const positives = criteria
    .filter(c => c.direction === 'positive' && c.score >= 6)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);

  if (positives.length > 0) {
    const signals = positives.slice(0, 2)
      .map(c => `${c.name.toLowerCase()} (${c.score}/10)`)
      .join(' and ');
    parts.push(`${name} scores well on ${signals} within ${radiusKm}km.`);
  }

  const profileConcerns = criteria.filter(
    c => (c.name === 'Land availability' || c.name === 'Location-type fit') && c.score <= 3.5,
  );
  for (const c of profileConcerns) parts.push(c.justification);

  const negatives = criteria
    .filter(c => c.direction === 'negative' && c.score <= 4 && c.name !== 'Land availability' && c.name !== 'Location-type fit')
    .sort((a, b) => a.score - b.score);

  if (negatives.length > 0) {
    parts.push(`Concern: high ${negatives[0].name.toLowerCase()} (score ${negatives[0].score}/10).`);
  }

  const failed = exclusions.filter(e => !e.passed);
  if (failed.length > 0) {
    parts.push(`Warning: ${failed.length} hard exclusion rule(s) failed.`);
  }

  if (parts.length === 0) {
    parts.push(`${name}: ${criteria.length} criteria evaluated within ${radiusKm}km radius.`);
  }

  return parts.join(' ');
}

// ─── Sparse-data detection ───

/**
 * Returns true if more than half the criteria have zero raw values.
 * Used to flag potentially unreliable scores.
 */
export function isSparseData(criteria) {
  if (criteria.length === 0) return true;
  const zeroCount = criteria.filter(c => c.rawValue === 0).length;
  return zeroCount > criteria.length * 0.5;
}
