/**
 * Google Places API Proxy — Nearby Search
 *
 * Keeps the API key server-side (never exposed to frontend).
 * Request: POST { lat, lng, radius, types }
 * Response: { results: [...], source: 'google_places' }
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Google Places API key not configured' });
  }

  try {
    const { lat, lng, radius, types } = req.body;

    if (!lat || !lng || !radius || !types || !Array.isArray(types)) {
      return res.status(400).json({ error: 'Missing required fields: lat, lng, radius, types[]' });
    }

    // Query each type separately and aggregate (Places API New takes one type at a time)
    const allResults = {};

    for (const placeType of types) {
      try {
        const url = `https://places.googleapis.com/v1/places:searchNearby`;
        const body = {
          includedTypes: [placeType],
          maxResultCount: 20,
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius: Math.min(radius, 50000), // Max 50km
            },
          },
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.displayName,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          console.error(`Places API error for type ${placeType}:`, response.status, await response.text());
          allResults[placeType] = { count: 0, places: [] };
          continue;
        }

        const data = await response.json();
        const places = (data.places || []).map(p => ({
          name: p.displayName?.text || '',
          lat: p.location?.latitude,
          lng: p.location?.longitude,
          types: p.types || [],
          rating: p.rating || null,
          ratingCount: p.userRatingCount || 0,
          priceLevel: p.priceLevel || null,
        }));

        allResults[placeType] = { count: places.length, places };
      } catch (err) {
        console.error(`Places API fetch error for ${placeType}:`, err.message);
        allResults[placeType] = { count: 0, places: [] };
      }
    }

    return res.status(200).json({
      results: allResults,
      source: 'google_places',
      lat,
      lng,
      radius,
    });
  } catch (err) {
    console.error('Places proxy error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
