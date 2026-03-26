// Industry benchmark data for site suitability scoring across Indian cities.
// These are curated reference values (not computed from real analyses) that
// provide context when comparing individual MCDA scores.

export interface BenchmarkResult {
  sectorAvg: number;
  cityAvg: number | null;
  topCity: string;
  insight: string;
  rating: 'above' | 'at' | 'below';
}

export interface BenchmarkComparison {
  sectorAvg: number;
  cityAvg: number | null;
  topCity: string;
  insight: string;
  delta: number;
  cityDelta: number | null;
  rating: 'well above' | 'above' | 'at' | 'below' | 'well below';
  ratingLabel: string;
}

interface SectorBenchmark {
  overall: number;
  cities: Record<string, number>;
  topPerforming: string;
  insight: string;
}

export const SECTOR_BENCHMARKS: Record<string, SectorBenchmark> = {
  cafe: {
    overall: 6.2,
    cities: {
      Bengaluru: 6.8,
      Mumbai: 5.9,
      Delhi: 6.0,
      Hyderabad: 6.5,
      Pune: 6.4,
      Chennai: 5.8,
      Kolkata: 5.7,
      Ahmedabad: 5.6,
      Jaipur: 5.4,
      Lucknow: 5.2,
    },
    topPerforming: 'Bengaluru',
    insight:
      'Bengaluru leads for cafes due to dense commercial zones and a strong culture of casual dining among its tech workforce.',
  },
  preschool: {
    overall: 6.1,
    cities: {
      Bengaluru: 6.5,
      Mumbai: 6.3,
      Delhi: 6.0,
      Hyderabad: 6.2,
      Pune: 6.4,
      Chennai: 5.9,
      Kolkata: 5.7,
      Ahmedabad: 5.8,
      Jaipur: 5.5,
      Lucknow: 5.3,
    },
    topPerforming: 'Bengaluru',
    insight:
      'Bengaluru and Pune score highest for preschools owing to young professional demographics and growing residential townships.',
  },
  ev: {
    overall: 5.0,
    cities: {
      Bengaluru: 5.6,
      Mumbai: 5.3,
      Delhi: 5.4,
      Hyderabad: 5.2,
      Pune: 5.3,
      Chennai: 4.8,
      Kolkata: 4.4,
      Ahmedabad: 4.7,
      Jaipur: 4.3,
      Lucknow: 4.1,
    },
    topPerforming: 'Bengaluru',
    insight:
      'EV infrastructure is still developing across India; Bengaluru and Delhi lead with early charging network rollouts and policy incentives.',
  },
  logistics: {
    overall: 5.8,
    cities: {
      Bengaluru: 5.9,
      Mumbai: 6.2,
      Delhi: 6.1,
      Hyderabad: 5.7,
      Pune: 5.6,
      Chennai: 6.3,
      Kolkata: 5.5,
      Ahmedabad: 6.4,
      Jaipur: 5.3,
      Lucknow: 5.0,
    },
    topPerforming: 'Ahmedabad',
    insight:
      'Ahmedabad and Chennai score highest for logistics thanks to major port access, industrial corridors, and lower land costs.',
  },
  retail: {
    overall: 6.5,
    cities: {
      Bengaluru: 6.8,
      Mumbai: 7.0,
      Delhi: 6.9,
      Hyderabad: 6.4,
      Pune: 6.3,
      Chennai: 6.2,
      Kolkata: 6.1,
      Ahmedabad: 5.9,
      Jaipur: 5.8,
      Lucknow: 5.6,
    },
    topPerforming: 'Mumbai',
    insight:
      'Mumbai leads retail suitability with the highest consumer density, disposable income levels, and established commercial high streets.',
  },
  clinic: {
    overall: 6.3,
    cities: {
      Bengaluru: 6.5,
      Mumbai: 6.6,
      Delhi: 6.4,
      Hyderabad: 6.3,
      Pune: 6.2,
      Chennai: 6.5,
      Kolkata: 6.0,
      Ahmedabad: 5.9,
      Jaipur: 5.7,
      Lucknow: 5.5,
    },
    topPerforming: 'Mumbai',
    insight:
      'Mumbai and Chennai have strong clinic suitability due to high population density and established healthcare ecosystems.',
  },
  coworking: {
    overall: 6.0,
    cities: {
      Bengaluru: 6.9,
      Mumbai: 6.2,
      Delhi: 6.1,
      Hyderabad: 6.6,
      Pune: 6.5,
      Chennai: 5.7,
      Kolkata: 5.3,
      Ahmedabad: 5.4,
      Jaipur: 5.1,
      Lucknow: 4.8,
    },
    topPerforming: 'Bengaluru',
    insight:
      'Bengaluru dominates coworking demand driven by its startup ecosystem and large IT corridor presence.',
  },
  solar: {
    overall: 5.5,
    cities: {
      Bengaluru: 5.4,
      Mumbai: 4.6,
      Delhi: 5.2,
      Hyderabad: 5.8,
      Pune: 5.3,
      Chennai: 5.1,
      Kolkata: 4.5,
      Ahmedabad: 6.2,
      Jaipur: 6.5,
      Lucknow: 5.4,
    },
    topPerforming: 'Jaipur',
    insight:
      'Jaipur and Ahmedabad lead solar suitability with high irradiance levels, available open land, and supportive state policies.',
  },
  realestate: {
    overall: 6.4,
    cities: {
      Bengaluru: 6.8,
      Mumbai: 7.1,
      Delhi: 6.9,
      Hyderabad: 6.5,
      Pune: 6.3,
      Chennai: 6.1,
      Kolkata: 5.8,
      Ahmedabad: 5.9,
      Jaipur: 5.7,
      Lucknow: 5.4,
    },
    topPerforming: 'Mumbai',
    insight:
      'Mumbai commands the highest real estate scores with premium land value, infrastructure maturity, and sustained demand.',
  },
};

/**
 * Retrieve benchmark data for a given sector and optionally a specific city.
 */
export function getBenchmark(
  sectorId: string,
  city?: string
): BenchmarkResult | null {
  const benchmark = SECTOR_BENCHMARKS[sectorId];
  if (!benchmark) return null;

  const cityAvg =
    city && benchmark.cities[city] !== undefined
      ? benchmark.cities[city]
      : null;

  return {
    sectorAvg: benchmark.overall,
    cityAvg,
    topCity: benchmark.topPerforming,
    insight: benchmark.insight,
    rating: 'at', // placeholder — needs an actual score to compare
  };
}

/**
 * Compare a given MCDA score against the sector (and optionally city) benchmark.
 *
 * Rating thresholds (based on delta from sector average):
 *   well above : delta >  1.5
 *   above      : delta >  0.5
 *   at         : delta >= -0.5 and <= 0.5
 *   below      : delta >= -1.5 and < -0.5
 *   well below : delta <  -1.5
 */
export function compareToBenchmark(
  score: number,
  sectorId: string,
  city?: string
): BenchmarkComparison | null {
  const benchmark = SECTOR_BENCHMARKS[sectorId];
  if (!benchmark) return null;

  const sectorAvg = benchmark.overall;
  const cityAvg =
    city && benchmark.cities[city] !== undefined
      ? benchmark.cities[city]
      : null;

  const delta = parseFloat((score - sectorAvg).toFixed(1));
  const cityDelta =
    cityAvg !== null ? parseFloat((score - cityAvg).toFixed(1)) : null;

  let rating: BenchmarkComparison['rating'];
  if (delta > 1.5) {
    rating = 'well above';
  } else if (delta > 0.5) {
    rating = 'above';
  } else if (delta >= -0.5) {
    rating = 'at';
  } else if (delta >= -1.5) {
    rating = 'below';
  } else {
    rating = 'well below';
  }

  const absDelta = Math.abs(delta);
  let ratingLabel: string;
  if (rating === 'at') {
    ratingLabel = 'At sector average';
  } else {
    const direction = delta > 0 ? 'above' : 'below';
    ratingLabel = `${absDelta} point${absDelta === 1 ? '' : 's'} ${direction} sector average`;
  }

  return {
    sectorAvg,
    cityAvg,
    topCity: benchmark.topPerforming,
    insight: benchmark.insight,
    delta,
    cityDelta,
    rating,
    ratingLabel,
  };
}
