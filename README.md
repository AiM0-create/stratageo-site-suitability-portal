# Stratageo — AI-Assisted Site Suitability Portal

A polished interactive demo portal that combines place-based signals, spatial reasoning, and explainable scoring to evaluate candidate locations for any business type.

**Live demo:** Deploy to GitHub Pages (demo mode works with zero configuration).

## Architecture

```
Frontend (React + Vite)          Backend (Serverless, optional)
┌────────────────────────┐      ┌─────────────────────────┐
│  Static site on         │      │  Vercel/Netlify/CF      │
│  GitHub Pages           │ ───► │  Functions              │
│                         │      │                         │
│  - Guided input flow    │      │  /api/intent  ─► OpenAI │
│  - Deterministic scoring│      │  /api/explain ─► OpenAI │
│  - OSM data fetching    │      │                         │
│  - Map visualization    │      │  OPENAI_API_KEY is      │
│  - Template explanations│      │  server-side only       │
│  - Demo mode fallback   │      └─────────────────────────┘
└────────────────────────┘
```

**Key design decisions:**
- Frontend is fully static and deployable on GitHub Pages
- OpenAI API key is never exposed in browser code
- Demo Mode works completely without any backend or API keys
- AI enhances explanations but never controls scoring or core logic
- Deterministic MCDA scoring from real OSM data

## Quick Start

```bash
npm install
npm run dev
```

Opens at `http://localhost:3000`. Default mode is **Demo Mode** with pre-built scenarios.

## Modes

### Demo Mode (default)
- No API keys needed
- Uses curated scenario data for featured business types and cities
- Template-based explanations and scoring
- Safe for public deployment on GitHub Pages

### Live Mode
- Fetches real OSM data via Nominatim + Overpass APIs
- Deterministic MCDA scoring from real-world POI counts
- Optional AI enhancement via backend proxy (if configured)
- Graceful fallback to template explanations if AI is unavailable

To enable live mode:
```bash
# In .env
VITE_APP_MODE=live
VITE_AI_BACKEND_URL=https://your-backend.vercel.app
```

## GitHub Pages Deployment

1. Set `base` in `vite.config.ts` to your repo name:
   ```ts
   base: '/stratageo-site-suitability-portal/',
   ```

2. Build:
   ```bash
   npm run build
   ```

3. Deploy `dist/` folder to GitHub Pages:
   - Push to a `gh-pages` branch, or
   - Use GitHub Actions, or
   - Use `npx gh-pages -d dist`

No environment variables are needed for demo mode deployment.

## Backend Deployment (Optional)

The `api/` directory contains two serverless functions for OpenAI integration.

### Vercel

1. Create a new Vercel project from this repo
2. Set root directory to `api/`
3. Add environment variable: `OPENAI_API_KEY`
4. Deploy

The functions auto-deploy as `/api/explain` and `/api/intent`.

### Netlify Functions

Move the files to `netlify/functions/` and adapt the handler signature.

### Manual

```bash
cd api
npm install
# Set OPENAI_API_KEY in environment
# Deploy with your preferred platform
```

### API Endpoints

**POST /api/explain** — Generate AI explanations for scored locations
```json
{
  "businessType": "Cafe",
  "city": "Bengaluru",
  "locations": [
    {
      "name": "Koramangala",
      "mcda_score": 7.8,
      "criteria_breakdown": [...],
      "osmCounts": { "competitors": 23, "transport": 12, "commercial": 45, "residential": 18 }
    }
  ]
}
```

**POST /api/intent** — Parse natural language into analysis parameters
```json
{
  "prompt": "I want to open a cafe in Bengaluru"
}
```

## Project Structure

```
src/
├── App.tsx                 # Main app shell and state management
├── main.tsx                # Entry point
├── vite-env.d.ts           # Vite type declarations
├── config/
│   └── index.ts            # App configuration, sectors, cities
├── types/
│   └── index.ts            # TypeScript interfaces
├── data/
│   └── demoScenarios.ts    # Curated demo scenario data
├── services/
│   ├── analysisService.ts  # Orchestrates demo/live analysis
│   ├── osmService.ts       # Nominatim geocoding + Overpass queries
│   ├── scoringEngine.ts    # Deterministic MCDA scoring
│   └── aiClient.ts         # AI backend client (optional)
├── components/
│   ├── Header.tsx           # Navigation bar
│   ├── Hero.tsx             # Landing hero section
│   ├── AnalysisInput.tsx    # Business type + city selection
│   ├── AnalysisProgress.tsx # Loading/progress indicator
│   ├── MapView.tsx          # Leaflet map with markers/heatmaps
│   ├── ResultsPanel.tsx     # Ranked results, scores, charts
│   ├── Methodology.tsx      # How-it-works + disclaimer
│   ├── ErrorBanner.tsx      # Error display
│   └── Footer.tsx           # Site footer
└── styles/
    └── main.css             # Complete design system
api/
├── explain.js              # OpenAI explanation endpoint
├── intent.js               # OpenAI intent parsing endpoint
└── package.json            # Backend dependencies
```

## Scoring Methodology

The portal uses Multi-Criteria Decision Analysis (MCDA) with six criteria:

| Criteria | Weight | Signal Source |
|----------|--------|--------------|
| Competitive Landscape | 0.20 | OSM competitor POI count |
| Transit Accessibility | 0.15 | OSM transit stop count |
| Commercial Vibrancy | 0.20 | OSM shop/office/restaurant count |
| Residential Catchment | 0.15 | OSM residential building count |
| Pedestrian Footfall | 0.15 | Combined commercial + transit density |
| Complementary Infrastructure | 0.15 | Combined amenity density |

Scores are deterministic — computed from real OSM data, not AI-generated. Weights are interactively adjustable in the results panel.

## Cost Control

- AI is only called on explicit user action (never on slider changes or UI interactions)
- Default model: `gpt-4o-mini` (lowest cost)
- Prompts are compact (<300 tokens input, <600 tokens output)
- Template explanations serve as fallback when AI is unavailable
- Client-side scoring is fully deterministic — no AI needed for core functionality

## Known Limitations

- OSM data coverage varies by region; less-mapped cities may return sparse results
- Scoring reflects relative suitability from available spatial signals, not absolute recommendations
- Demo scenarios are illustrative; real-world analysis requires richer data sources
- Heatmap visualization depends on POI density in the area
- PDF export uses html2canvas which may not capture all map tile states

## Phase 2 Roadmap

- Custom criteria definition UI
- Comparison report export
- Sector-specific scoring templates
- Historical data overlays
- Traffic and footfall estimation from additional data sources
- User accounts and saved analyses
- Richer demo scenarios for more cities/sectors
