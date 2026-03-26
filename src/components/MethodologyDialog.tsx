import React, { useState } from 'react';

interface MethodologyDialogProps {
  open: boolean;
  onClose: () => void;
  onStartTour?: () => void;
}

export const MethodologyDialog: React.FC<MethodologyDialogProps> = ({ open, onClose, onStartTour }) => {
  const [tab, setTab] = useState<'guide' | 'methodology'>('guide');

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="dialog-tabs">
            <button
              className={`dialog-tab ${tab === 'guide' ? 'dialog-tab-active' : ''}`}
              onClick={() => setTab('guide')}
            >
              Portal Guide
            </button>
            <button
              className={`dialog-tab ${tab === 'methodology' ? 'dialog-tab-active' : ''}`}
              onClick={() => setTab('methodology')}
            >
              Methodology
            </button>
          </div>
          <button onClick={onClose} className="dialog-close" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body">
          {tab === 'guide' ? <GuideTab onStartTour={() => { onClose(); onStartTour?.(); }} /> : <MethodologyTab />}

          <div className="dialog-cta">
            <a href="https://stratageo.in/contact.php" target="_blank" rel="noopener noreferrer" className="dialog-cta-link">
              Contact Stratageo for production-grade analysis
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

function GuideTab({ onStartTour }: { onStartTour: () => void }) {
  return (
    <>
      <button className="tour-launch-btn" onClick={onStartTour}>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" width="16" height="16">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5" />
        </svg>
        Take an interactive tour
      </button>
      <h3>Getting Started</h3>
      <div className="guide-sections">
        <div className="guide-item">
          <div className="guide-num">1</div>
          <div>
            <strong>Describe your site need</strong>
            <p>Type a natural-language query in the input bar. Be as specific as you want — business type, city, neighborhoods, constraints, even Hindi/Hinglish works.</p>
            <p className="guide-example">"Cold storage warehouse near Gurgaon with truck access, away from residential"</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">2</div>
          <div>
            <strong>Review the results</strong>
            <p>The <strong>left panel</strong> shows ranked locations with an AI-generated summary explaining why each scored the way it did. Scroll down to see the <strong>criteria bar chart</strong> comparing all locations side by side.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">3</div>
          <div>
            <strong>Explore heatmaps</strong>
            <p>Click the <strong>heatmap layer buttons</strong> (e.g. "Nearby industrial zones", "Transit access") below the summary to visualize spatial data on the map. Each layer shows intensity around your candidate locations.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">4</div>
          <div>
            <strong>Interact with the map</strong>
            <p>Click any <strong>numbered marker</strong> on the map to see that location's score and details. The map auto-zooms to fit all candidate locations.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">5</div>
          <div>
            <strong>Export & share</strong>
            <p>Click the <strong>download icon</strong> in the top bar to export a PDF report with scores, criteria breakdowns, and map snapshot — ready to share with stakeholders.</p>
          </div>
        </div>
      </div>

      <h3>Quick Tips</h3>
      <ul className="guide-tips">
        <li><strong>Quick-start buttons</strong> — Use "Cafe in Bengaluru", "EV Charging in Delhi" etc. to try a preset query instantly</li>
        <li><strong>Results count</strong> — Change the dropdown (default: 3) to analyze up to 5 locations</li>
        <li><strong>Analysis Assumptions</strong> — Expand this section in the results panel to see what the AI understood from your query</li>
        <li><strong>New analysis</strong> — Click the <strong>+</strong> button in the top bar to start fresh without losing your current results</li>
        <li><strong>Session history</strong> — The clock icon lets you switch between past analyses in this session</li>
      </ul>
    </>
  );
}

function MethodologyTab() {
  return (
    <>
      <h3>How the analysis works</h3>
      <ol className="dialog-steps">
        <li><strong>Intent parsing</strong> — Your query is analyzed by AI to extract the business type, location, constraints, and a site-seeking profile (land intensity, urban preference, access needs, environmental sensitivity).</li>
        <li><strong>Candidate identification</strong> — 3-5 neighborhoods are selected for the target city using curated local knowledge or AI-extracted locations from your query.</li>
        <li><strong>Spatial data collection</strong> — Real-world POI data is gathered from Google Places API for commercial features (restaurants, transit, hospitals, shopping) and supplemented by OpenStreetMap for infrastructure signals (road networks, industrial zones, land use, residential density) — within a dynamically calculated search radius.</li>
        <li><strong>MCDA scoring</strong> — Each location is scored using Multi-Criteria Decision Analysis with continuous linear interpolation. Criteria and weights are dynamically generated per business type — a warehouse is scored on road access and industrial proximity, while a cafe is scored on foot traffic and competition.</li>
        <li><strong>Profile alignment</strong> — Scores are adjusted for site-profile fit. A solar farm in an urban core gets penalized for land unavailability. A retail store in a rural area gets flagged for low foot traffic. This prevents high scores for physically infeasible locations.</li>
        <li><strong>AI explanation</strong> — A GIS-aware AI generates a business-readable narrative explaining the rankings, flagging concerns, and contextualizing the scores.</li>
      </ol>

      <h3>Dynamic scoring criteria</h3>
      <p className="dialog-note">Unlike static scorecards, criteria are generated per query. A cold storage warehouse analysis might use:</p>
      <table className="dialog-table">
        <thead>
          <tr><th>Example Criteria</th><th>Direction</th><th>Source</th></tr>
        </thead>
        <tbody>
          <tr><td>Proximity to major roads</td><td>Positive</td><td>OSM road network</td></tr>
          <tr><td>Nearby industrial zones</td><td>Positive</td><td>OSM landuse data</td></tr>
          <tr><td>Access to utilities</td><td>Positive</td><td>OSM infrastructure</td></tr>
          <tr><td>Distance from residential</td><td>Negative</td><td>OSM building data</td></tr>
          <tr><td>Land availability</td><td>Profile-based</td><td>Total POI density vs. land need</td></tr>
        </tbody>
      </table>
      <p className="dialog-note">For a cafe, the criteria would instead include foot traffic, competitor density, transit access, and commercial vibrancy — each with appropriate weights.</p>

      <h3>Data sources</h3>
      <ul className="guide-tips">
        <li><strong>Google Places API</strong> — Accurate POI data for commercial features (restaurants, transit, hospitals, shopping, banks)</li>
        <li><strong>OpenStreetMap</strong> — Infrastructure and land-use data via Overpass API (road networks, industrial zones, residential density)</li>
        <li><strong>Nominatim</strong> — Geocoding for cities and neighborhoods</li>
        <li><strong>AI models</strong> — GPT-4o-mini for intent parsing and explanation generation</li>
      </ul>

      <h3>Limitations</h3>
      <p>This is a screening-level tool using Google Places and OpenStreetMap data. Scores indicate relative suitability based on observable spatial signals. Full site suitability studies by Stratageo incorporate proprietary datasets, satellite imagery, demographic analysis, and on-ground validation for production-grade recommendations.</p>
    </>
  );
}
