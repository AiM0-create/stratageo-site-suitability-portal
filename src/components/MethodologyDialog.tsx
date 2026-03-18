import React from 'react';

interface MethodologyDialogProps {
  open: boolean;
  onClose: () => void;
}

export const MethodologyDialog: React.FC<MethodologyDialogProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">Demo Methodology</h2>
          <button onClick={onClose} className="dialog-close" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          <h3>How the analysis works</h3>
          <ol className="dialog-steps">
            <li><strong>Candidate identification</strong> — 3-4 neighborhoods are selected for the target city, using local knowledge or AI-assisted parsing.</li>
            <li><strong>Place-based signals</strong> — Real-world data is gathered from OpenStreetMap: competitor counts, transit stops, commercial density, and residential buildings within a 1km radius.</li>
            <li><strong>Deterministic scoring</strong> — Each location is scored across 6 MCDA criteria using deterministic functions. No AI is used for scoring math.</li>
            <li><strong>Explanation</strong> — Template-based or AI-enhanced narratives provide business-readable rationale for each ranking.</li>
          </ol>

          <h3>Scoring criteria</h3>
          <table className="dialog-table">
            <thead>
              <tr><th>Criteria</th><th>Weight</th><th>Source</th></tr>
            </thead>
            <tbody>
              <tr><td>Competitive Landscape</td><td>0.20</td><td>OSM competitor count</td></tr>
              <tr><td>Transit Accessibility</td><td>0.15</td><td>OSM transit stops</td></tr>
              <tr><td>Commercial Vibrancy</td><td>0.20</td><td>OSM shops/offices</td></tr>
              <tr><td>Residential Catchment</td><td>0.15</td><td>OSM residential buildings</td></tr>
              <tr><td>Pedestrian Footfall</td><td>0.15</td><td>Commercial + transit density</td></tr>
              <tr><td>Complementary Infrastructure</td><td>0.15</td><td>Amenity density</td></tr>
            </tbody>
          </table>

          <h3>Limitations</h3>
          <p>This is a screening-level tool using publicly available data. Scores indicate relative suitability based on available spatial signals. Real site suitability studies by Stratageo use proprietary data, sector-specific criteria, and on-ground validation.</p>

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
