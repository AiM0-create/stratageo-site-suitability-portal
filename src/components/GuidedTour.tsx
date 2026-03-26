import React, { useState, useEffect, useCallback, useRef } from 'react';

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
    title: 'Site Suitability Assistant',
    description: 'This is your main interaction panel. Type your site need here in natural language — business type, city, constraints, even Hindi works.',
    position: 'left',
  },
  {
    selector: 'input[placeholder*="Cafe"]',
    title: 'Query Input',
    description: 'Describe what you\'re looking for. Example: "Cold storage warehouse near Gurgaon with truck access" or "Cafe in Koramangala, Bengaluru near metro".',
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
    selector: '.leaflet-container',
    title: 'Interactive Map',
    description: 'After analysis, the map shows numbered markers for each candidate location. Click any marker to see its score and details. Zoom and pan freely.',
    position: 'right',
  },
  {
    selector: '.drawer-layers',
    title: 'Heatmap Layers',
    description: 'Toggle spatial data overlays on the map — like "Nearby industrial zones", "Transit access", or "Residential density". Each layer visualizes real OSM data around your candidate locations.',
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
    if (!hasResults && (s.selector === '.drawer-layers' || s.selector === '.drawer-chart' || s.selector === 'button[title="Export PDF"]')) {
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

    if (pos === 'bottom') {
      tt.top = rect.bottom + pad + 8;
      tt.left = Math.max(12, rect.left + rect.width / 2 - 160);
    } else if (pos === 'top') {
      tt.bottom = window.innerHeight - rect.top + pad + 8;
      tt.left = Math.max(12, rect.left + rect.width / 2 - 160);
    } else if (pos === 'left') {
      tt.top = Math.max(12, rect.top + rect.height / 2 - 60);
      tt.right = window.innerWidth - rect.left + pad + 8;
    } else if (pos === 'right') {
      tt.top = Math.max(12, rect.top + rect.height / 2 - 60);
      tt.left = rect.right + pad + 8;
    }

    // Keep tooltip on screen
    if (tt.left && typeof tt.left === 'number') {
      tt.left = Math.min(tt.left, window.innerWidth - 340);
    }

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

  return (
    <>
      {/* Overlay */}
      <div className="tour-overlay" onClick={onEnd} />

      {/* Highlight cutout */}
      <div className="tour-highlight" style={highlightStyle} />

      {/* Tooltip */}
      <div className={`tour-tooltip ${arrowClass}`} style={tooltipStyle} ref={tooltipRef}>
        <div className="tour-step-counter">{step + 1} of {availableSteps.length}</div>
        <h4 className="tour-title">{currentStep.title}</h4>
        <p className="tour-desc">{currentStep.description}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={onEnd}>Skip tour</button>
          <div className="tour-nav">
            {step > 0 && (
              <button className="tour-btn tour-btn-prev" onClick={() => setStep(s => s - 1)}>Back</button>
            )}
            <button
              className="tour-btn tour-btn-next"
              onClick={() => isLast ? onEnd() : setStep(s => s + 1)}
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
