
import { GoogleGenAI, Type } from "@google/genai";
import type { GeoInsightsResponse, FileAttachment, GroundingSource } from '../types';
import { geocodeLocation, fetchOSMData } from './osmService';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

/**
 * Helper to retry Gemini API calls with exponential backoff
 */
const withRetry = async <T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 3000
): Promise<T> => {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            const errorStr = JSON.stringify(error).toUpperCase();
            const isRateLimit = 
                error?.status === 429 || 
                error?.code === 429 ||
                error?.error?.code === 429 ||
                errorStr.includes("RESOURCE_EXHAUSTED") || 
                errorStr.includes("429") ||
                errorStr.includes("QUOTA") ||
                (error?.message && error.message.toUpperCase().includes("RESOURCE_EXHAUSTED"));
            
            if (isRateLimit && i < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, i);
                console.warn(`Rate limit hit. Retrying in ${delay}ms (Attempt ${i + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

// --- Schema 1: Search Strategy (Planning Phase) ---
const searchStrategySchema = {
    type: Type.OBJECT,
    properties: {
        business_type: { type: Type.STRING, description: "The type of business (e.g., 'Cafe')." },
        target_city: { type: Type.STRING, description: "The target city or region (e.g., 'Bengaluru')." },
        candidate_neighborhoods: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "List of 3-4 specific, popular neighborhoods or districts in the target city that would be good candidates for this business." 
        },
        competitor_osm_tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "List of OpenStreetMap tags representing direct competitors. Format: 'key=value' (e.g., 'amenity=cafe', 'shop=coffee')."
        },
        methodology_explanation: { type: Type.STRING, description: "Brief explanation of why these neighborhoods and tags were chosen." }
    },
    required: ["business_type", "target_city", "candidate_neighborhoods", "competitor_osm_tags", "methodology_explanation"]
};

// --- Schema 2: Final Analysis (Synthesis Phase) ---
const mcdaCriteriaSchema = {
    type: Type.OBJECT,
    properties: {
        name: { type: Type.STRING, description: "Name of the criteria." },
        weight: { type: Type.NUMBER, description: "Weight (0.0-1.0)." },
        score: { type: Type.NUMBER, description: "Score (1-10) based on the REAL DATA provided." },
        justification: { type: Type.STRING, description: "Justification referencing the specific data counts (e.g., 'High score due to 15 nearby transport stops')." }
    },
    required: ["name", "weight", "score", "justification"]
};

const locationItemSchema = {
    type: Type.OBJECT,
    properties: {
        name: { type: Type.STRING },
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
        reasoning: { type: Type.STRING },
        footfall: { type: Type.STRING, description: "Inferred from commercial density data." },
        demographics: { type: Type.STRING, description: "Inferred from residential density data." },
        marketing_radius_km: { type: Type.NUMBER },
        marketing_strategy: { type: Type.STRING },
        public_transport: { type: Type.STRING, description: "Specific details based on the transport count provided." },
        local_initiatives: { type: Type.STRING },
        mcda_score: { type: Type.NUMBER },
        criteria_breakdown: { type: Type.ARRAY, items: mcdaCriteriaSchema }
    },
    required: ["name", "lat", "lng", "reasoning", "footfall", "demographics", "marketing_radius_km", "marketing_strategy", "public_transport", "local_initiatives", "mcda_score", "criteria_breakdown"]
};

const finalResponseSchema = {
    type: Type.OBJECT,
    properties: {
        business_type: { type: Type.STRING },
        target_location: { type: Type.STRING },
        summary: { type: Type.STRING, description: "A concise executive summary of the findings, including a recommendation. MUST end with a paragraph inviting the user to contact Stratageo for further detailed analysis." },
        methodology: { type: Type.STRING },
        locations: { type: Type.ARRAY, items: locationItemSchema }
    },
    required: ["business_type", "target_location", "summary", "methodology", "locations"]
};

export const getGeoInsights = async (
    prompt: string, 
    file: FileAttachment | null,
    onStatusUpdate?: (status: string, progress: number) => void
): Promise<GeoInsightsResponse> => {
    
    // --- Step 1: Plan the Search (Gemini) ---
    onStatusUpdate?.("Planning search strategy...", 10);
    console.log("Phase 1: Planning Search Strategy...");
    const planResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: `Analyze this request: "${prompt}". Identify the business type, target city, and suggest 3-4 specific candidate neighborhoods/areas to analyze. Also list the OpenStreetMap tags (key=value) that define direct competitors.` }] }],
        config: {
            responseMimeType: "application/json",
            responseSchema: searchStrategySchema,
        }
    }));

    const plan = JSON.parse(planResponse.text.trim());
    console.log("Search Plan:", plan);

    // --- Step 2: Gather Real Data (OSM) ---
    onStatusUpdate?.(`Gathering real-world data for ${plan.candidate_neighborhoods.length} neighborhoods...`, 25);
    console.log("Phase 2: Gathering Real World Data...");
    const analyzedLocations: any[] = [];
    let geocodingFailedCount = 0;
    let osmFailedCount = 0;

    for (let i = 0; i < plan.candidate_neighborhoods.length; i++) {
        const neighborhood = plan.candidate_neighborhoods[i];
        onStatusUpdate?.(`Analyzing ${neighborhood}...`, 25 + (i * 10));
        const query = `${neighborhood}, ${plan.target_city}`;
        const coords = await geocodeLocation(query);

        if (coords) {
            try {
                const osmData = await fetchOSMData(coords.lat, coords.lng, plan.competitor_osm_tags, plan.business_type);
                analyzedLocations.push({
                    name: coords.display_name.split(',')[0], // Shorten name
                    full_name: coords.display_name,
                    lat: coords.lat,
                    lng: coords.lng,
                    data: osmData
                });
            } catch (osmError) {
                console.warn(`OSM data fetch failed for ${neighborhood}:`, osmError);
                osmFailedCount++;
            }
        } else {
            console.warn(`Geocoding failed for ${neighborhood}`);
            geocodingFailedCount++;
        }
    }

    if (analyzedLocations.length === 0) {
        if (geocodingFailedCount === plan.candidate_neighborhoods.length) {
            throw new Error(`GEOCODING_FAILED: Could not find coordinates for any suggested neighborhoods in ${plan.target_city}.`);
        } else if (osmFailedCount > 0) {
            throw new Error(`OSM_FAILED: Failed to fetch OpenStreetMap data for the locations in ${plan.target_city}.`);
        } else {
            throw new Error(`DATA_FETCH_FAILED: Could not gather sufficient data for ${plan.target_city}.`);
        }
    }

    // --- Step 3: Deep Dive with Google Maps & Search (Gemini Tools) ---
    onStatusUpdate?.("Performing deep dive with Google Maps & Search...", 60);
    console.log("Phase 3: Deep Dive with Google Maps & Search...");
    
    const toolPrompt = `
        Analyze the following locations for a ${plan.business_type} in ${plan.target_city}.
        Locations: ${analyzedLocations.map(l => `${l.name} (${l.lat}, ${l.lng})`).join(', ')}
        
        MANDATORY: 
        1. Use Google Maps (Google Places API) to find specific POIs (competitors, complementary businesses, high-traffic venues) in these areas.
        2. Use Google Search to find local open datasets (e.g., government portals, city census, urban planning reports) or trends related to ${plan.business_type} in these specific neighborhoods.
        
        Focus on:
        - Specific popular venues and their popularity.
        - Local footfall trends or neighborhood demographic shifts.
        - Any recent urban development or open data insights that impact business suitability.
    `;

    const toolResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: toolPrompt }] }],
        config: {
            tools: [{ googleMaps: {} }, { googleSearch: {} }],
            toolConfig: {
                retrievalConfig: {
                    latLng: {
                        latitude: analyzedLocations[0].lat,
                        longitude: analyzedLocations[0].lng
                    }
                }
            }
        }
    }));

    const toolAnalysis = toolResponse.text;
    const groundingSources: GroundingSource[] = [];
    
    // Extract grounding sources
    const chunks = toolResponse.candidates?.[0]?.groundingMetadata?.groundingChunks;
    const retrievalTime = "2026-03-06T11:43:53-08:00"; // Current time from metadata

    if (chunks) {
        chunks.forEach((chunk: any) => {
            if (chunk.web) {
                groundingSources.push({ 
                    title: chunk.web.title, 
                    uri: chunk.web.uri,
                    retrievedAt: retrievalTime,
                    reliability: "Moderate to High (Web Search Result)"
                });
            } else if (chunk.maps) {
                groundingSources.push({ 
                    title: chunk.maps.title, 
                    uri: chunk.maps.uri,
                    retrievedAt: retrievalTime,
                    reliability: "High (Google Places API)"
                });
            }
        });
    }

    // --- Step 4: Synthesize & Score (Gemini) ---
    onStatusUpdate?.("Synthesizing final report and scoring sites...", 85);
    console.log("Phase 4: Synthesizing Final Report...");
    
    const dataContext = analyzedLocations.map(loc => `
        Location: ${loc.name} (${loc.lat}, ${loc.lng})
        - OSM Competitor Count: ${loc.data.competitors}
        - OSM Transport Stops: ${loc.data.transport}
        - OSM Commercial Density: ${loc.data.commercial_density}
        - OSM Residential Density: ${loc.data.residential_density}
    `).join('\n\n');

    const synthesisPrompt = `
        You are the Stratageo Site Suitability Engine.
        User Request: "${prompt}"
        Business Type: ${plan.business_type}
        Target City: ${plan.target_city}
        
        I have gathered data from multiple sources:
        1. OSM INFRASTRUCTURE DATA:
        ${dataContext}

        2. GOOGLE MAPS & SEARCH INSIGHTS:
        ${toolAnalysis}

        Task:
        1. Perform a rigorous Multi-Criteria Decision Analysis (MCDA) based on ALL this data.
        2. You MUST define at least 5 to 6 distinct, highly pronounced criteria relevant to the specific business type (e.g., 'Competitive Saturation', 'Transit Accessibility', 'Commercial Vibrancy', 'Residential Catchment', 'Pedestrian Footfall Potential', 'Complementary Infrastructure').
        3. Assign scores (1-10) for each of these criteria based on the data.
        4. Generate the final JSON report.
        5. In the 'summary' field, provide a professional executive summary. 
        6. MANDATORY: At the end of the 'summary', add a paragraph that says: "For a more comprehensive and detailed site suitability analysis, including demographic deep-dives and custom traffic patterns, please contact Stratageo at https://stratageo.in/."
        
        CRITICAL: 
        - Use the provided counts and tool insights to justify your scores. 
        - Do not hallucinate data. 
    `;

    const finalResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: synthesisPrompt }] }],
        config: {
            responseMimeType: "application/json",
            responseSchema: finalResponseSchema,
            temperature: 0.2,
        }
    }));

    const jsonText = finalResponse.text.trim();
    const parsedResponse = JSON.parse(jsonText);
    
    // Validate and clean locations
    parsedResponse.locations = (parsedResponse.locations || []).filter((loc: any) => {
        const lat = parseFloat(loc.lat);
        const lng = parseFloat(loc.lng);
        const isValid = Number.isFinite(lat) && Number.isFinite(lng);
        if (!isValid) {
            console.warn(`Gemini returned invalid coordinates for location: ${loc.name}`, loc);
        } else {
            loc.lat = lat;
            loc.lng = lng;
        }
        return isValid;
    });

    // Add grounding sources to the response
    parsedResponse.grounding_sources = groundingSources;

    // Add POIs back to the locations
    parsedResponse.locations = parsedResponse.locations.map((loc: any) => {
        const originalLoc = analyzedLocations.find(l => l.name === loc.name);
        if (originalLoc) {
            loc.pois = originalLoc.data.pois;
        }
        return loc;
    });

    return parsedResponse as GeoInsightsResponse;
};
