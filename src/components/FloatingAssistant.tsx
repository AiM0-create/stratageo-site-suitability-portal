import React, { useState, useRef, useEffect, useCallback } from 'react';
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
}) => {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(true);
  const [input, setInput] = useState('');
  const [showPromptGuide, setShowPromptGuide] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
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

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onRunAnalysis(text);
    setInput('');
  }, [input, onRunAnalysis]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Copy message text to clipboard with brief visual feedback
  const handleCopyMessage = useCallback((text: string, idx: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    }).catch(() => {});
  }, []);

  // Load a previous user message into the input for editing
  const handleEditMessage = useCallback((text: string) => {
    setInput(text);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // Share prompt as a pre-filled URL hash
  const handleSharePrompt = useCallback((text: string) => {
    const url = `${window.location.origin}${window.location.pathname}#prompt=${encodeURIComponent(text)}`;
    navigator.clipboard.writeText(url).catch(() => {});
  }, []);

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
                    <span>{msg.text}</span>
                  )}
                </div>
                {/* Per-message actions */}
                <div className="msg-actions">
                  <button
                    className="msg-action-btn"
                    title={copiedIdx === i ? 'Copied!' : 'Copy'}
                    onClick={() => handleCopyMessage(msg.text, i)}
                  >
                    {copiedIdx === i ? (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-xs"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>
                    )}
                  </button>
                  {msg.role === 'user' && (
                    <>
                      <button
                        className="msg-action-btn"
                        title="Edit and resend"
                        onClick={() => handleEditMessage(msg.text)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-xs"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
                      </button>
                      <button
                        className="msg-action-btn"
                        title="Share prompt"
                        onClick={() => handleSharePrompt(msg.text)}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-xs"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" /></svg>
                      </button>
                    </>
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

            {/* Inline run prompt — appears in the conversation flow when the plan
                is ready and the engine is waiting for a go signal. This removes the
                need for users to know to type "run" — they can just click. */}
            {config.isConversationalMode && chatReady && !isLoading && !isExecuting && chatStage === 'ready' && (
              <div className="inline-run-prompt">
                <span className="inline-run-text">Ready to run the spatial analysis.</span>
                <button
                  className="inline-run-btn"
                  onClick={onConfirmExecute}
                  title="Run the analysis now"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="icon-xs" style={{ marginRight: 4 }}>
                    <path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.84Z" />
                  </svg>
                  Run Analysis
                </button>
              </div>
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

          {/* v1.4.0: Business type picker removed. Use natural language in the text box.
              Result count is inferred by the deterministic parser from your prompt. */}

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
