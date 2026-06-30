import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnalysisStatus } from '../types';
import type { WorkingMemory } from '../types/session';
import type { SpecV2 } from '../types/chat';
import { config } from '../config';
import { demoScenarios } from '../data/demoScenarios';
import { useAuth } from '../contexts/AuthContext';
import { MAX_PROMPTS_PER_USER } from '../config/firebase';
import { SpecSummaryCard } from './SpecSummaryCard';

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
  onCSVUpload: (file: File) => void;
  onClearCSV: () => void;
  csvPointCount: number;
  memory: WorkingMemory;
  onNewChat: () => void;
  onClearMemoryField: (field: keyof WorkingMemory) => void;
  sessionTitle: string;
  // ─── Conversational mode (v1.0.1) ───
  chatSpec?: SpecV2 | null;
  chatSpecStatus?: 'empty' | 'draft' | 'complete';
  chatReady?: boolean;
  /** Staged flow: the plan card stays hidden while the conversation is exploratory */
  chatStage?: 'chat' | 'framework' | 'ready';
  isExecuting?: boolean;
  onConfirmExecute?: () => void;
  onSpecEdit?: (updated: SpecV2) => void;
  /** v1.4.1 — cancel a running analysis; shown alongside the progress bar. */
  onCancelAnalysis?: () => void;
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
  onCSVUpload,
  onClearCSV,
  csvPointCount,
  onResultCountChange,
  memory,
  onNewChat,
  onClearMemoryField,
  sessionTitle,
  chatSpec,
  chatSpecStatus = 'empty',
  chatReady = false,
  chatStage = 'chat',
  isExecuting = false,
  onConfirmExecute,
  onSpecEdit,
  onCancelAnalysis,
}) => {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(true);
  const [input, setInput] = useState('');
  const [showSectors, setShowSectors] = useState(false);
  const [showPromptGuide, setShowPromptGuide] = useState(false);
  const [selectedSector, setSelectedSector] = useState('');
  const [city, setCity] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the input with content (up to ~6 lines), shrink back when cleared
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };
  useEffect(autoGrow, [input]);

  const promptsLeft = user ? (user.isAdmin ? Infinity : Math.max(0, MAX_PROMPTS_PER_USER - user.promptsUsed)) : 0;

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
    <div className={`assistant ${expanded ? 'assistant-expanded' : 'assistant-collapsed'}${drawerOpen ? ' assistant-drawer-shift' : ''}`}>
      {/* Header bar */}
      <div className="assistant-header" onClick={() => setExpanded(!expanded)}>
        <div className="assistant-header-left">
          <div className="assistant-indicator" />
          <span className="assistant-title">{memory.lastAnalysisTimestamp ? sessionTitle : 'Site Suitability Assistant'}</span>
        </div>
        <div className="assistant-header-right">
          {messages.length > 0 && (
            <button
              className="new-chat-btn"
              onClick={(e) => { e.stopPropagation(); onNewChat(); }}
              title="New chat"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          )}
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
                <p className="assistant-welcome-text" style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b', marginBottom: '4px' }}>
                  AI-Powered Site Suitability Analysis
                </p>
                <p className="assistant-welcome-desc" style={{ fontSize: '12px', marginBottom: '8px', color: '#64748b', lineHeight: '1.5' }}>
                  Describe your business, location, and constraints in natural language. We score real locations using Google Places and OpenStreetMap data with multi-criteria decision analysis.
                </p>

                {/* Prompt limit reminder for non-admin users */}
                {user && !user.isAdmin && (
                  <div className="assistant-prompt-reminder">
                    <span className="assistant-prompt-reminder-icon">💡</span>
                    <span>You have <strong>{promptsLeft} of {MAX_PROMPTS_PER_USER} queries</strong> remaining. Make each one count — <button className="assistant-guide-link" onClick={() => setShowPromptGuide(!showPromptGuide)}>see tips for better results</button>.</span>
                  </div>
                )}

                {/* Prompt guide — shown on click */}
                {showPromptGuide && (
                  <div className="assistant-prompt-guide">
                    <div className="assistant-guide-header">
                      <strong>How to write better site suitability queries</strong>
                      <button className="assistant-guide-close" onClick={() => setShowPromptGuide(false)}>&times;</button>
                    </div>
                    <div className="assistant-guide-body">
                      <div className="assistant-guide-item">
                        <span className="assistant-guide-do">✅</span>
                        <div>
                          <strong>Be specific about business type</strong>
                          <p>"Premium co-working space" not just "office"</p>
                        </div>
                      </div>
                      <div className="assistant-guide-item">
                        <span className="assistant-guide-do">✅</span>
                        <div>
                          <strong>Name a city or area</strong>
                          <p>"in Bengaluru HSR Layout" or "near 12.97, 77.59"</p>
                        </div>
                      </div>
                      <div className="assistant-guide-item">
                        <span className="assistant-guide-do">✅</span>
                        <div>
                          <strong>Add spatial constraints</strong>
                          <p>"near metro stations", "away from industrial zones", "not in Whitefield"</p>
                        </div>
                      </div>
                      <div className="assistant-guide-item">
                        <span className="assistant-guide-do">✅</span>
                        <div>
                          <strong>Mention what matters for the site</strong>
                          <p>"high foot traffic", "good road access", "low competition"</p>
                        </div>
                      </div>
                      <div className="assistant-guide-item">
                        <span className="assistant-guide-dont">❌</span>
                        <div>
                          <strong>Avoid vague prompts</strong>
                          <p>"best place for business" → too generic, no location</p>
                        </div>
                      </div>
                      <div className="assistant-guide-example">
                        <strong>Great example:</strong> "Cold storage warehouse near Gurgaon, close to NH-48, away from residential areas, needs truck access and power infrastructure"
                      </div>
                    </div>
                  </div>
                )}

                <p className="assistant-welcome-examples" style={{ fontSize: '11px', color: '#64748b', margin: '0 0 8px', lineHeight: '1.6' }}>
                  Try: "EV charging station in Delhi NCR near highways, away from existing chargers"
                  <br />
                  or: "Premium retail store in Mumbai BKC area, high foot traffic"
                  <br />
                  or: "Solar farm near 26.9, 70.9 — flat terrain, away from settlements"
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
                  {msg.role === 'assistant' ? (
                    <div className="assistant-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                    </div>
                  ) : (
                    msg.text
                  )}
                </div>
              </div>
            ))}

            {/* Conversational mode: agreed analysis plan + confirm chip.
                Hidden during the exploratory "chat" stage — the framework only
                appears once the user asks to move ahead. */}
            {config.isConversationalMode && chatSpec && !isLoading && chatStage !== 'chat' && (
              <SpecSummaryCard
                spec={chatSpec}
                specStatus={chatSpecStatus}
                readyToExecute={chatReady}
                isExecuting={isExecuting}
                onConfirmExecute={onConfirmExecute ?? (() => {})}
                onSpecEdit={onSpecEdit}
              />
            )}

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
                    {/* v1.4.1 — always-available recovery: an analysis can legitimately
                        take a while on a large study area, but the user must never be
                        stuck waiting with no way out. */}
                    {isExecuting && onCancelAnalysis && (
                      <button
                        type="button"
                        className="assistant-cancel-btn"
                        onClick={onCancelAnalysis}
                        title="Stop this analysis and unlock the chat"
                      >
                        Cancel analysis
                      </button>
                    )}
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

          {/* v1.1.0: result count is inferred from the prompt by the deterministic
              RawIntent parser — no dropdown needed in the chat UI.
              Count editing remains available in SpecSummaryCard (advanced). */}

          {/* Context chips — show active memory items */}
          {memory.lastAnalysisTimestamp && (
            <div className="context-chips">
              {memory.businessType && (
                <span className="context-chip">
                  {memory.businessType}
                  <button className="context-chip-clear" onClick={() => onClearMemoryField('businessType')} title="Clear">&times;</button>
                </span>
              )}
              {memory.city && (
                <span className="context-chip">
                  {memory.city}
                  <button className="context-chip-clear" onClick={() => onClearMemoryField('city')} title="Clear">&times;</button>
                </span>
              )}
              {memory.constraints.length > 0 && (
                <span className="context-chip">
                  {memory.constraints.length} constraint{memory.constraints.length !== 1 ? 's' : ''}
                  <button className="context-chip-clear" onClick={() => onClearMemoryField('constraints')} title="Clear">&times;</button>
                </span>
              )}
              {csvPointCount > 0 && (
                <span className="context-chip">
                  {csvPointCount} CSV pt{csvPointCount !== 1 ? 's' : ''}
                  <button className="context-chip-clear" onClick={onClearCSV} title="Clear CSV">&times;</button>
                </span>
              )}
            </div>
          )}

          {/* CSV chip (shown only when no analysis yet) */}
          {csvPointCount > 0 && !memory.lastAnalysisTimestamp && (
            <div className="csv-chip">
              <span className="csv-chip-icon">&#128205;</span>
              <span>{csvPointCount} location{csvPointCount !== 1 ? 's' : ''} loaded</span>
              <button className="csv-chip-clear" onClick={onClearCSV} title="Clear CSV data">&times;</button>
            </div>
          )}

          {/* Remaining prompts badge (shown after first message for non-admins) */}
          {user && !user.isAdmin && messages.length > 0 && (
            <div className="assistant-prompts-remaining">
              <span>{promptsLeft} of {MAX_PROMPTS_PER_USER} queries left</span>
              {promptsLeft <= 1 && promptsLeft > 0 && <span className="assistant-prompts-warning"> — last one!</span>}
            </div>
          )}

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
            {/* CSV upload button */}
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onCSVUpload(file);
                e.target.value = '';
              }}
            />
            <button
              className="csv-upload-btn"
              onClick={() => csvInputRef.current?.click()}
              title="Upload CSV with lat/lon locations"
              disabled={isLoading}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={csvPointCount > 0 ? "e.g. Cafe in Bengaluru, not within 3km of these locations" : "e.g. Cafe in Bengaluru near metro, low competition"}
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
