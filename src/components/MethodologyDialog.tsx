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
            <strong>Describe your site need — in plain language</strong>
            <p>Tell the assistant what you want to build and where. Business type, city or sub-area, hard constraints ("within 10 min of X", "outside 1 km of metro", "along the river") — even Hindi/Hinglish. You're talking to a location consultant, not filling a form.</p>
            <p className="guide-example">"Dark kitchen in South Kolkata within a 10-minute delivery drive of Ballygunge Phari, outside 1 km of any metro"</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">2</div>
          <div>
            <strong>Review the proposed framework</strong>
            <p>The assistant replies with a <strong>methodology</strong>: a feasibility check, the factors it will score with weights, and the hard constraints it will enforce. Adjust anything you disagree with, then say <strong>"run"</strong> to hand it to the engine. Nothing is scored until you approve.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">3</div>
          <div>
            <strong>Read the ranked results — and the Analyst Review</strong>
            <p>The <strong>left panel</strong> ranks the strongest sites, each with per-factor evidence (what was observed, from which source). At the top, the <strong>Analyst Review</strong> is a senior-consultant audit of the result — <em>Reliable / Weak / Unreliable</em> — flagging thin data or dead factors. If it judges the result untrustworthy, the ranking is withheld rather than shown as a fake recommendation.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">4</div>
          <div>
            <strong>Explore the map</strong>
            <p>Toggle the <strong>per-factor suitability heatmaps</strong> (green = better, direction-correct for every factor). Numbered markers show each ranked site; click one for its score and computed <strong>network routes</strong> (real drive/walk times). Greyed hexes are masked out — outside a constraint, inside a buffer, or in water.</p>
          </div>
        </div>

        <div className="guide-item">
          <div className="guide-num">5</div>
          <div>
            <strong>Export, save & share</strong>
            <p>Export a <strong>PDF report</strong> from the top bar, or open <strong>My Analyses</strong> to revisit past runs and copy a shareable link.</p>
          </div>
        </div>
      </div>

      <h3>Quick Tips</h3>
      <ul className="guide-tips">
        <li><strong>State your hard constraints explicitly</strong> — "must", "within", "outside", "without" become real pass/fail gates, not soft preferences</li>
        <li><strong>Trust the Analyst Review</strong> — a "Weak/Unreliable" verdict means the data couldn't support a confident ranking; it tells you what would make it reliable</li>
        <li><strong>Results count</strong> — change the dropdown (default: 3) to rank more locations</li>
        <li><strong>Analysis Assumptions</strong> — expand this in the results panel to see exactly what the consultant assumed and which factors carried weight</li>
        <li><strong>New analysis</strong> — the <strong>+</strong> button starts fresh; the clock icon switches between past analyses in this session</li>
      </ul>
    </>
  );
}

function MethodologyTab() {
  return (
    <>
      <h3>Three cooperating layers of intelligence</h3>
      <p className="dialog-note">The portal isn't a single AI guessing answers. It's three distinct layers — language and judgment are kept separate from the analytical maths.</p>
      <ol className="dialog-steps">
        <li><strong>The conversation — "what should we measure?"</strong> A senior-consultant LLM (GPT-4o) frames the brief: classifies the business archetype, runs a feasibility check, derives factor weights from business logic, flags misleading variables, and proposes a transparent methodology you approve before anything runs.</li>
        <li><strong>The engine — "measure it precisely."</strong> A deterministic Python engine builds the grid, gathers real-world data, computes routes, enforces hard rules, and scores every cell. <em>No LLM touches the scoring maths</em> — the numbers are auditable and reproducible.</li>
        <li><strong>The critic — "do I believe this answer?"</strong> After ranking, a second senior-consultant pass (GPT-4o) audits the computed result for geographic sanity, dead/non-discriminating factors, thin data, and constraint satisfaction, returning the Analyst Review verdict.</li>
      </ol>

      <h3>How the engine scores a site</h3>
      <ol className="dialog-steps">
        <li><strong>Feasibility gate</strong> — Hard constraints are checked for joint satisfiability first. A contradictory or unvalidatable brief is flagged (or blocked) before any ranking — no fake "top 3" for an impossible spec.</li>
        <li><strong>Study area &amp; H3 grid</strong> — The area resolves to real localities (or a point-radius) and is tiled with thousands of H3 hexagonal cells. Cells inside water bodies are masked out.</li>
        <li><strong>Data gathering</strong> — Per factor, features come from <strong>OpenStreetMap</strong> (Overpass) for land/infrastructure and <strong>Google Places</strong> for consumer POIs and competition (OSM undercounts these in India).</li>
        <li><strong>Two-pass MCDA</strong> — Pass A scores every cell with calibrated Euclidean catchments; Pass B re-scores the top candidates with <strong>true OpenRouteService isochrones</strong>, and for destination businesses, <strong>traffic-aware drive catchments</strong>. Weights are renormalized preserving ratios — never clamped.</li>
        <li><strong>Constraints, corridors &amp; exclusions</strong> — Point-to-point rules ("within 7-min walk of the metro, without crossing a railway") run real network routing; "within X of a highway/river" runs true distance-to-line on real geometry; "outside 1 km of Y" masks hexes. These are computed pass/fail gates, not soft penalties.</li>
        <li><strong>Discrimination-aware ranking</strong> — A factor that doesn't vary across the shortlist carries no ranking information and is scored neutral, never a fabricated extreme. Surviving sites are ranked and named; the explanation cites the real evidence behind each score.</li>
      </ol>

      <h3>Honesty is enforced, not optional</h3>
      <table className="dialog-table">
        <thead>
          <tr><th>Situation</th><th>What the engine does</th></tr>
        </thead>
        <tbody>
          <tr><td>A factor has no data</td><td>Marked <em>insufficient data</em> and excluded — never silently scored 0 or 10</td></tr>
          <tr><td>A factor doesn't separate the sites</td><td>Flagged and scored neutral, so a meaningless number can't dominate</td></tr>
          <tr><td>A requirement is stated</td><td>Enforced as a pass/fail constraint — never re-encoded as a weighted factor that contradicts it</td></tr>
          <tr><td>The critic judges the result unreliable</td><td>The ranking is <em>withheld</em>; you see the reasons and what would make it reliable</td></tr>
          <tr><td>A hard constraint can't be validated (e.g. rent)</td><td>Shown as "Feasible with caveats — flag for site visit", never a clean pass</td></tr>
        </tbody>
      </table>

      <h3>Data sources</h3>
      <ul className="guide-tips">
        <li><strong>OpenStreetMap (Overpass)</strong> — roads, land use, buildings, transit, water and infrastructure geometry</li>
        <li><strong>Google Places</strong> — consumer POIs and competition (restaurants, retail, clinics, gyms, hotels)</li>
        <li><strong>OpenRouteService</strong> — true walk/drive isochrones and network routing (with railway-crossing detection)</li>
        <li><strong>Google Routes</strong> — traffic-aware drive catchments for destination businesses</li>
        <li><strong>Nominatim</strong> — geocoding and locality naming</li>
        <li><strong>AI models</strong> — GPT-4o for the consultant conversation and the Analyst Review; GPT-4o-mini for result explanations</li>
      </ul>

      <h3>Limitations</h3>
      <p>This is a screening-level tool built on open and commodity spatial data. Scores indicate <em>relative</em> suitability from observable signals — OSM coverage varies by area, and the Analyst Review flags when that depresses a result. Full site-suitability studies by Stratageo add proprietary datasets, satellite imagery, demographic analysis, and on-ground validation for production-grade recommendations.</p>
    </>
  );
}
