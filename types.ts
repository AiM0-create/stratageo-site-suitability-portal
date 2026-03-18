
export interface ChatMessage {
    id: string;
    sender: 'user' | 'ai';
    text: string;
    file?: {
        name: string;
        type: string;
    };
}

export interface MCDACriteria {
    name: string;
    weight: number; // 0 to 1
    score: number; // 1 to 10
    justification: string;
}

export interface POI {
    lat: number;
    lng: number;
    name?: string;
    type: 'competitor' | 'transport' | 'commercial' | 'residential';
}

export interface LocationData {
    name: string;
    lat: number;
    lng: number;
    reasoning: string;
    footfall: string;
    demographics: string;
    marketing_radius_km: number;
    marketing_strategy: string;
    public_transport?: string;
    local_initiatives?: string;
    eco_score?: number;
    eco_score_reasoning?: string;
    closeness_to_nature?: string;
    
    // New MCDA fields
    mcda_score: number; // Total weighted score (1-10)
    criteria_breakdown: MCDACriteria[];
    pois?: POI[];
}

export interface GroundingSource {
    title: string;
    uri: string;
    retrievedAt: string;
    reliability: string;
}

export interface GeoInsightsResponse {
    summary: string;
    business_type: string;
    target_location: string;
    methodology: string; // Explanation of the chosen MCDA criteria
    locations: LocationData[];
    grounding_sources?: GroundingSource[];
}

// This type is now a direct alias for consistency, as conversational refinement is removed.
export type GeoInsightsResult = GeoInsightsResponse;

export interface FileAttachment {
    name: string;
    base64: string;
    mimeType: string;
}

export interface DailyForecast {
    time: string[];
    weathercode: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
}

export interface WeatherData {
    daily: DailyForecast;
}
