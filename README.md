# Stratageo — Site Suitability Portal

**Spatial intelligence for smarter site selection.**

Stratageo is building decision-support tools that bring GIS-grade site suitability analysis to businesses, developers, and consultants — without requiring GIS expertise. The Site Suitability Portal is our public-facing demo that showcases this capability: given a business concept and a city, it evaluates candidate locations using real-world spatial data and transparent, explainable scoring.

> **Try it live:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

---

## What It Does

The portal accepts a natural-language business description — *"a mid-size warehouse near Bhiwadi"* or *"premium coworking space in Bengaluru"* — and returns a ranked shortlist of candidate neighborhoods with:

- **MCDA scores** derived from real OpenStreetMap point-of-interest data
- **Per-criteria breakdowns** (competitive landscape, transit access, commercial vibrancy, land availability, etc.)
- **Profile-aware reasoning** that penalizes infeasible matches (e.g., a solar farm in a dense urban core)
- **Interactive map** with marker clusters and heatmap overlays
- **AI-generated narrative** that reads like a GIS consultant's brief, not a chatbot response

The goal is not to replace a full site selection study — it's to demonstrate that spatial data, structured scoring, and domain reasoning can be combined into an accessible, instant workflow.

## How Scoring Works

Every location is scored using **Multi-Criteria Decision Analysis (MCDA)** — the same framework used in professional GIS suitability studies.

1. **Data collection** — For each candidate neighborhood, we query OpenStreetMap via Overpass API to count relevant features (competitors, transit stops, commercial establishments, residential density, healthcare, education, etc.) within a calibrated search radius.

2. **Criteria scoring** — Raw POI counts are mapped to 0–10 scores using continuous linear interpolation against sector-specific benchmarks. Each criterion has a direction: *positive* (more is better, e.g., transit access for retail) or *negative* (more is worse, e.g., competitor saturation).

3. **Profile alignment** — The engine infers a **site profile** from the business type: land intensity (does it need open acreage?), urban preference (does it thrive in density or need rural space?), and catchment type. Mismatches between the profile and the observed environment are scored as explicit penalty criteria with dynamic weights — a warehouse in a CBD gets penalized hard, not just footnoted.

4. **Weighted aggregation** — Criteria scores are combined using normalized weights into a single composite score per location.

5. **Feasibility validation** — Before results are presented, a validator checks for dealbreaker mismatches (e.g., land-intensive use in a high-density zone) and flags them as warnings that override raw scores.

Scores are **deterministic and reproducible** — they come from observed spatial data, not LLM generation.

## Supported Capabilities

| Capability | Details |
|---|---|
| **25+ business sectors** | Retail, F&B, healthcare, logistics, manufacturing, education, renewable energy, agriculture, and more |
| **NCR-aware geography** | "Delhi NCR" spans Delhi, Noida, Gurgaon neighborhoods automatically |
| **Named exclusions** | "not in Koramangala" creates a geocoded exclusion buffer |
| **Small-town support** | Directional offset fallback for towns without mapped neighborhoods |
| **Hindi/Hinglish input** | Natural language parsing handles mixed-script prompts |
| **Coordinate validation** | 100km sanity check rejects geocoding errors |
| **Dynamic search radius** | Calibrated per-city based on inter-neighborhood distances |

## Architecture

```
User prompt
    │
    ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Intent Extraction   │────►│  GPT-4o-mini (API)   │
│  (with local         │◄────│  Structured JSON out  │
│   parser fallback)   │     └──────────────────────┘
└─────────┬───────────┘
          │ sector, city, neighborhoods, profile, exclusions
          ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Spatial Data Layer  │────►│  Nominatim + Overpass │
│  Geocoding + POI     │◄────│  (OpenStreetMap)      │
│  collection          │     └──────────────────────┘
└─────────┬───────────┘
          │ coordinates, POI counts per neighborhood
          ▼
┌─────────────────────┐
│  MCDA Scoring Engine │  Deterministic, profile-aware
│  + Feasibility Check │  No AI in the scoring loop
└─────────┬───────────┘
          │ ranked locations with breakdowns
          ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Results Layer       │────►│  GPT-4o-mini (API)   │
│  Map + Charts +      │◄────│  Narrative explanation│
│  Exportable reports  │     └──────────────────────┘
└─────────────────────┘
```

**Key principle:** AI handles language (parsing prompts, writing narratives) but never controls scoring. The analytical core is deterministic and auditable.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 6 — static SPA deployed on GitHub Pages
- **Maps:** Leaflet + leaflet.heat (CDN), Recharts for score visualizations
- **Spatial data:** OpenStreetMap via Nominatim (geocoding) and Overpass API (POI queries)
- **AI layer:** OpenAI GPT-4o-mini via serverless proxy on Vercel (optional — demo mode works without it)
- **Scoring:** Custom MCDA engine with continuous interpolation, profile-aware criteria, and dynamic weight scaling

## Versioning

| Version | Status | Highlights |
|---------|--------|------------|
| **v0.5.0** | Current | Profile-aware MCDA scoring, NCR support, named exclusions, feasibility validation, professional GIS-grade explanations, Hindi/Hinglish support |
| **v0.4.0** | — | Continuous linear scoring, geocoding robustness, coordinate validation, search radius calibration |
| **v0.3.0** | — | LLM-first intent extraction, session memory, guided input flow |
| **v0.2.0** | — | Dynamic MCDA, CSV spatial constraints, sector classification |
| **v0.1.0** | — | Initial portal with basic scoring and map visualization |

## Roadmap

- Custom criteria definition and weight adjustment UI
- Multi-city comparative reports
- Traffic and footfall estimation from supplementary data sources
- Sector-specific scoring templates with editable parameters
- Saved analyses and user workspaces
- Richer demo scenarios across more cities and sectors
- Exportable PDF reports with branded formatting

## Known Limitations

- OpenStreetMap coverage varies by region — less-mapped cities may produce sparse or skewed results
- Scoring reflects *relative* suitability from available spatial signals, not absolute investment recommendations
- Heatmap quality depends on POI density in the area
- Demo scenarios are illustrative; production-grade analysis requires richer and proprietary data sources

## License

Proprietary. All rights reserved.
