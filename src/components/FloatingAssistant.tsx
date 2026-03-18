import React, { useState, useRef, useEffect } from 'react';
import type { AnalysisStatus } from '../types';
import { config } from '../config';
import { demoScenarios } from '../data/demoScenarios';

interface FloatingAssistantProps {
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  isLoading: boolean;
  analysisStatus: AnalysisStatus;
  error: string | null;
  onRunAnalysis: (rawPrompt: string) => void;
  onDismissError: () => void;
  hasResults: boolean;
  onToggleResults: () => void;
  drawerOpen: boolean;
  resultCount: number;
  onResultCountChange: (count: number) => void;
}

const SCENARIOS = [
  ...demoScenarios.map(s => ({ label: s.label, prompt: `${s.businessType} in ${s.city}` })),
  { label: 'Clinic in Hyderabad', prompt: 'Clinic in Hyderabad' },
  { label: 'Retail in Pune', prompt: 'Retail Store in Pune' },
];

export const FloatingAssistant: React.FC<FloatingAssistantProps> = ({
  messages,
  isLoading,
  analysisStatus,
  error,
  onRunAnalysis,
  onDismissError,
  hasResults,
  onToggleResults,
  drawerOpen,
  resultCount,
  onResultCountChange,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [input, setInput] = useState('');
  const [showSectors, setShowSectors] = useState(false);
  const [selectedSector, setSelectedSector] = useState('');
  const [city, setCity] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading, expanded]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onRunAnalysis(text);
    setInput('');
  };

  const handleStructuredSubmit = () => {
    if (!selectedSector || !city.trim()) return;
    const label = config.sectors.find(s => s.id === selectedSector)?.label || selectedSector;
    onRunAnalysis(`${label} in ${city.trim()}`);
    setShowSectors(false);
    setSelectedSector('');
    setCity('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={`assistant ${expanded ? 'assistant-expanded' : 'assistant-collapsed'}`}>
      {/* Header bar */}
      <div className="assistant-header" onClick={() => setExpanded(!expanded)}>
        <div className="assistant-header-left">
          <div className="assistant-indicator" />
          <span className="assistant-title">Site Suitability Assistant</span>
        </div>
        <div className="assistant-header-right">
          {hasResults && (
            <button
              className="assistant-results-toggle"
              onClick={(e) => { e.stopPropagation(); onToggleResults(); }}
              title={drawerOpen ? 'Hide results' : 'Show results'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
              </svg>
            </button>
          )}
          <button className="assistant-toggle" aria-label={expanded ? 'Collapse' : 'Expand'}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <>
          {/* Conversation area */}
          <div className="assistant-body" ref={scrollRef}>
            {messages.length === 0 && !isLoading && (
              <div className="assistant-welcome">
                <p className="assistant-welcome-text">
                  Describe what you want to site and where. Use natural language — include constraints like distances, preferences, and exclusions.
                </p>
                <p className="assistant-welcome-examples" style={{ fontSize: '11px', color: '#64748b', margin: '6px 0 8px' }}>
                  Try: "Cafe in Bengaluru near metro, low competition"
                  <br />
                  or: "Warehouse near highway in Pune, away from residential"
                  <br />
                  or: "Preschool in Mumbai within 2km of parks, not near industrial zones"
                </p>
                <div className="assistant-chips">
                  {SCENARIOS.map(s => (
                    <button
                      key={s.label}
                      className="assistant-chip"
                      onClick={() => onRunAnalysis(s.prompt)}
                      disabled={isLoading}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`assistant-msg assistant-msg-${msg.role}`}>
                {msg.role === 'assistant' && <div className="assistant-avatar" />}
                <div className={`assistant-bubble assistant-bubble-${msg.role}`}>
                  {msg.text}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="assistant-msg assistant-msg-assistant">
                <div className="assistant-avatar" />
                <div className="assistant-bubble assistant-bubble-assistant">
                  <div className="assistant-progress">
                    <div className="assistant-progress-text">{analysisStatus.message}</div>
                    <div className="assistant-progress-track">
                      <div className="assistant-progress-fill" style={{ width: `${analysisStatus.progress}%` }} />
                    </div>
                    <div className="assistant-progress-pct">{Math.round(analysisStatus.progress)}%</div>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="assistant-error">
                <span>{error}</span>
                <button onClick={onDismissError} className="assistant-error-dismiss">&times;</button>
              </div>
            )}
          </div>

          {/* Structured input toggle */}
          {showSectors && (
            <div className="assistant-structured">
              <div className="assistant-sector-grid">
                {config.sectors.map(s => (
                  <button
                    key={s.id}
                    className={`assistant-sector ${selectedSector === s.id ? 'active' : ''}`}
                    onClick={() => setSelectedSector(s.id)}
                  >
                    <span>{s.icon}</span>
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
              <div className="assistant-structured-row">
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Target city..."
                  className="assistant-input-field"
                  list="city-list"
                />
                <datalist id="city-list">
                  {config.featuredCities.map(c => <option key={c.name} value={c.name} />)}
                </datalist>
                <button
                  onClick={handleStructuredSubmit}
                  disabled={!selectedSector || !city.trim() || isLoading}
                  className="assistant-send"
                >
                  Analyze
                </button>
              </div>
            </div>
          )}

          {/* Result count control */}
          <div className="assistant-controls">
            <label className="assistant-count-label">
              Results:
              <select
                value={resultCount}
                onChange={(e) => onResultCountChange(parseInt(e.target.value))}
                className="assistant-count-select"
                disabled={isLoading}
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Input bar */}
          <div className="assistant-input">
            <button
              className="assistant-mode-btn"
              onClick={() => setShowSectors(!showSectors)}
              title={showSectors ? 'Free text input' : 'Pick business type'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                {showSectors
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
                  : <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
                }
              </svg>
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Cafe in Bengaluru near metro, low competition"
              className="assistant-text-input"
              disabled={isLoading}
            />
            <button
              onClick={handleSubmit}
              disabled={isLoading || !input.trim()}
              className="assistant-send"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
