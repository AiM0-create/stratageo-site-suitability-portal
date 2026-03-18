import { config } from '../config';

interface AIExplanationRequest {
  businessType: string;
  city: string;
  locations: Array<{
    name: string;
    mcda_score: number;
    criteria_breakdown: Array<{ name: string; score: number; weight: number; justification: string }>;
    osmCounts: { competitors: number; transport: number; commercial: number; residential: number };
  }>;
}

interface AIExplanationResponse {
  summary: string;
  locationInsights: Array<{
    name: string;
    reasoning: string;
    strategy: string;
  }>;
}

export async function fetchAIExplanation(request: AIExplanationRequest): Promise<AIExplanationResponse | null> {
  if (!config.aiBackendUrl) return null;

  try {
    const response = await fetch(`${config.aiBackendUrl}/api/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      console.warn('AI backend returned error:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('AI backend unreachable, using template explanations:', error);
    return null;
  }
}

export async function fetchAIIntent(userPrompt: string): Promise<{ businessType: string; city: string; neighborhoods: string[]; osmTags: string[] } | null> {
  if (!config.aiBackendUrl) return null;

  try {
    const response = await fetch(`${config.aiBackendUrl}/api/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userPrompt }),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
