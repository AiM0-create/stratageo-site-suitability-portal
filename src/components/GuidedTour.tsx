import React, { useState, useEffect, useCallback, useRef } from 'react';

const TOUR_SEEN_KEY = 'sg_tour_seen_v14';

/** Returns true if this is the user's first visit (tour not yet seen). */
export function isTourFirstVisit(): boolean {
  try {
    return !localStorage.getItem(TOUR_SEEN_KEY);
  } catch {
    return false;
  }
}

/** Mark the tour as seen so it won't auto-start again. */
export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
  } catch {
    // localStorage unavailable — non-fatal
  }
}

interface TourStep {
  selector: string;
  title: string;
  description: string;
  position: 'top' | 'bottom' | 'left' | 'right';
  fallbackSelector?: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: '.assistant',
    title: 'Your location consultant',
    description: 'This is a consultative assistant, not a search box. Describe your site need in plain language; it proposes a methodology (factors, weights, hard constraints) that you approve before anything is scored. Hindi/Hinglish works too.',
    position: 'left',
  },
  {
    selector: 'input[placeholder*="Cafe"]',
    title: 'Describe the brief',
    description: 'Say what you want and where, with any hard constraints. Example: "Dark kitchen in South Kolkata within a 10-min drive of Ballygunge Phari, outside 1 km of any metro". Then review the framework and say "run".',
    position: 'top',
  },
  {
    selector: '.assistant-chips',
    title: 'Quick-Start Presets',
    description: 'Click any of these to instantly run a demo analysis — great for first-time exploration.',
    position: 'top',
    fallbackSelector: '.assistant-chip',
  },
  {
    selector: '.topbar-right',
    title: 'Toolbar',
    description: 'From left to right: Session history (clock icon), How this works (info), Export PDF (download), New analysis (+), and Contact link.',
    position: 'bottom',
  },
  {
    selector: 'button[title="Export PDF"]',
    title: 'Export PDF Report',
    description: 'After running an analysis, click here to download a professional PDF with scores, criteria breakdowns, and map snapshot — ready to share with stakeholders.',
    position: 'bottom',
    fallbackSelector: '.topbar-right',
  },
  {
    selector: '.analyst-review',
    title: 'Analyst Review',
    description: 'A senior-consultant audit of the computed result — Reliable, Weak, or Unreliable — flagging thin data or factors that did not separate the sites. If it judges the result untrustworthy, the ranking is withheld instead of shown as a fake recommendation.',
    position: 'right',
    fallbackSelector: '.drawer',
  },
  {
    selector: '.leaflet-container',
    title: 'Interactive Map',
    description: 'After analysis, the map shows numbered markers for each ranked site. Click any marker for its score and computed network routes. Greyed hexes are masked out — outside a constraint, inside a buffer, or in water.',
    position: 'right',
  },
  {
    selector: '.drawer-layers',
    title: 'Suitability heatmaps',
    description: 'Toggle a per-factor suitability surface on the map — green is always more favourable (direction-correct for every factor, including competition). "Overall" shows the combined composite score.',
    position: 'right',
    fallbackSelector: '.drawer',
  },
  {
    selector: '.drawer-chart',
    title: 'Criteria Comparison Chart',
    description: 'Bar chart comparing all candidate locations across every scoring criterion. Quickly spot which location excels at what — and where each one falls short.',
    position: 'right',
    fallbackSelector: '.drawer',
  },
];

interface GuidedTourProps {
  active: boolean;
  onEnd: () => void;
  hasResults: boolean;
}

export const GuidedTour: React.FC<GuidedTourProps> = ({ active, onEnd, hasResults }) => {
  const [step, setStep] = useState(0);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [arrowClass, setArrowClass] = useState('');
  const [highlightStyle, setHighlightStyle] = useState<React.CSSProperties>({});
  const [visible, setVisible] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Filter steps based on what's visible
  const availableSteps = TOUR_STEPS.filter(s => {
    // Skip results-only steps if no results
    if (!hasResults && (s.selector === '.drawer-layers' || s.selector === '.drawer-chart' || s.selector === '.analyst-review' || s.selector === 'button[title="Export PDF"]')) {
      return false;
    }
    const el = document.querySelector(s.selector) || (s.fallbackSelector ? document.querySelector(s.fallbackSelector) : null);
    return !!el;
  });

  const currentStep = availableSteps[step];

  const positionTooltip = useCallback(() => {
    if (!currentStep) return;
    const el = document.querySelector(currentStep.selector) || (currentStep.fallbackSelector ? document.querySelector(currentStep.fallbackSelector) : null);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const pad = 8;

    // Highlight the element
    setHighlightStyle({
      top: rect.top - 4,
      left: rect.left - 4,
      width: rect.width + 8,
      height: rect.height + 8,
    });

    const pos = currentStep.position;
    const tt: React.CSSProperties = {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TW = Math.min(320, vw - 24); // tooltip width clamped for mobile
    const isMobile = vw < 600;

    if (isMobile) {
      // On mobile always place at bottom center — avoids off-screen clipping
      tt.bottom = 16;
      tt.left = 12;
      tt.right = 12;
      tt.width = 'auto';
    } else if (pos === 'bottom') {
      tt.top = Math.min(rect.bottom + pad + 8, vh - 180);
      tt.left = Math.max(12, Math.min(rect.left + rect.width / 2 - TW / 2, vw - TW - 12));
    } else if (pos === 'top') {
      const preferredBottom = vh - rect.top + pad + 8;
      tt.bottom = Math.min(preferredBottom, vh - 12);
      tt.left = Math.max(12, Math.min(rect.left + rect.width / 2 - TW / 2, vw - TW - 12));
    } else if (pos === 'left') {
      const rightOfTooltip = rect.left - pad - 8;
      if (rightOfTooltip < TW + 12) {
        // Not enough space on left → fall to bottom
        tt.top = Math.min(rect.bottom + pad + 8, vh - 180);
        tt.left = Math.max(12, Math.min(rect.left, vw - TW - 12));
      } else {
        tt.top = Math.max(12, Math.min(rect.top + rect.height / 2 - 80, vh - 200));
        tt.right = vw - rect.left + pad + 8;
      }
    } else if (pos === 'right') {
      const leftOfTooltip = rect.right + pad + 8;
      if (leftOfTooltip + TW > vw - 12) {
        // Not enough space on right → fall to bottom
        tt.top = Math.min(rect.bottom + pad + 8, vh - 180);
        tt.left = Math.max(12, Math.min(rect.left, vw - TW - 12));
      } else {
        tt.top = Math.max(12, Math.min(rect.top + rect.height / 2 - 80, vh - 200));
        tt.left = leftOfTooltip;
      }
    }

    // Final clamp: never overflow viewport
    if (typeof tt.left === 'number') tt.left = Math.min(tt.left, vw - TW - 12);
    if (typeof tt.top === 'number')  tt.top  = Math.min(tt.top,  vh - 180);

    setTooltipStyle(tt);
    setArrowClass(`tour-arrow-${pos}`);
    setVisible(true);
  }, [currentStep]);

  useEffect(() => {
    if (!active) { setVisible(false); return; }
    setStep(0);
  }, [active]);

  useEffect(() => {
    if (!active || !currentStep) return;
    // Small delay to let DOM settle
    const timer = setTimeout(positionTooltip, 150);
    window.addEventListener('resize', positionTooltip);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', positionTooltip);
    };
  }, [active, step, currentStep, positionTooltip]);

  if (!active || !visible || !currentStep) return null;

  const isLast = step >= availableSteps.length - 1;

  const handleEnd = () => {
    markTourSeen();
    onEnd();
  };

  return (
    <>
      {/* Overlay */}
      <div className="tour-overlay" onClick={handleEnd} />

      {/* Highlight cutout */}
      <div className="tour-highlight" style={highlightStyle} />

      {/* Tooltip */}
      <div className={`tour-tooltip ${arrowClass}`} style={{ ...tooltipStyle, maxWidth: 'min(320px, calc(100vw - 24px))' }} ref={tooltipRef}>
        <div className="tour-step-counter">{step + 1} of {availableSteps.length}</div>
        <h4 className="tour-title">{currentStep.title}</h4>
        <p className="tour-desc">{currentStep.description}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={handleEnd}>Skip tour</button>
          <div className="tour-nav">
            {step > 0 && (
              <button className="tour-btn tour-btn-prev" onClick={() => setStep(s => s - 1)}>Back</button>
            )}
            <button
              className="tour-btn tour-btn-next"
              onClick={() => isLast ? handleEnd() : setStep(s => s + 1)}
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
