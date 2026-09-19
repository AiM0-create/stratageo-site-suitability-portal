import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnalysisStatus } from '../types';
import type { SpecV2, AnalysisPhase, ClarifyResponse, ClarificationAnswer } from '../types/chat';
import { useAuth } from '../contexts/AuthContext';
import { MAX_PROMPTS_PER_USER } from '../config/firebase';
import { SpecSummaryCard } from './SpecSummaryCard';
import { ClarificationCard } from './ClarificationCard';
import type { SheetState } from '../services/sheetState';
import { PHONE_MEDIA_QUERY } from '../services/phoneLayout';

/**
 * v2.1.0 — the conversation panel, reduced to the four things it does:
 * show the exchange, ask the clarifying questions, show the plan, run it.
 * Gone: CSV upload, the sector picker, demo scenario chips, the memory chips,
 * the prompt-writing guide. One input, one button.
 */
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
  onNewChat: () => void;
  sessionTitle: string;
  chatSpec: SpecV2 | null;
  chatSpecStatus: 'empty' | 'draft' | 'complete';
  clarification: ClarifyResponse | null;
  onClarificationSubmit: (answers: ClarificationAnswer[]) => void;
  briefClarified: boolean;
  chatReady: boolean;
  chatStage: 'chat' | 'framework' | 'ready';
  isExecuting: boolean;
  onConfirmExecute: () => void;
  onSpecEdit: (updated: SpecV2) => void;
  onCancelAnalysis: () => void;
  canRetry: boolean;
  onRetryAnalysis: () => void;
  analysisPhase: AnalysisPhase;
  /** v2.3.0 — on a phone with results, the panel sits above the peeking
   *  results sheet and steps aside while the sheet is open. Null elsewhere. */
  phoneSheet?: SheetState | null;
  /** v2.4.0 — opens the "check a spot" flow (photo / location → verdict). */
  onCheckSpot?: () => void;
}

const EXAMPLES = [
  'Cafe in Indiranagar, Bengaluru — 3 zones',
  'Premium restaurant in Bandra, Mumbai, avoid areas with many restaurants',
  'Gym for IT professionals near the tech parks in Whitefield, Bengaluru',
];

export const FloatingAssistant: React.FC<FloatingAssistantProps> = ({
  messages, isLoading, analysisStatus, error, onRunAnalysis, onDismissError,
  hasResults, onToggleResults, drawerOpen, onNewChat, sessionTitle,
  chatSpec, chatSpecStatus, clarification, onClarificationSubmit, briefClarified,
  chatReady, chatStage, isExecuting, onConfirmExecute, onSpecEdit,
  onCancelAnalysis, canRetry, onRetryAnalysis, analysisPhase, phoneSheet = null, onCheckSpot,
}) => {
  const { user } = useAuth();
  // v2.4.3 — on a phone a restored conversation opens as its bar, not as a
  // full-screen panel over the map (the panel is full-height while conversing).
  const [expanded, setExpanded] = useState(() => {
    try { return !(window.matchMedia(PHONE_MEDIA_QUERY).matches && messages.length > 0); } catch { return true; }
  });
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the input with content (up to ~6 lines), shrink back when cleared
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input]);

  // v2.3.0 — when the results sheet is minimised the map should win: the
  // panel drops to its bar instead of springing back over the map with the
  // old plan. The customer expands it again when they want to talk.
  useEffect(() => { if (phoneSheet === 'peek') setExpanded(false); }, [phoneSheet]);

  const promptCap = user?.maxPrompts ?? MAX_PROMPTS_PER_USER;
  const promptsLeft = user ? (user.isAdmin ? Infinity : Math.max(0, promptCap - user.promptsUsed)) : 0;

  useEffect(() => {
    if (expanded && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading, expanded, clarification, chatSpec]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    onRunAnalysis(text);
    setInput('');
  };

  const showPlan = chatSpec && !isLoading && chatStage !== 'chat' && !clarification;
  const showRun = analysisPhase === 'spec_ready' && chatSpec && !isLoading && !isExecuting
    && chatSpec.feasibility?.status !== 'not_feasible';

  // v2.3.0 — phone: the sheet owns the bottom edge. Peeking sheet → the panel
  // sits on top of its header; open sheet → the panel steps aside entirely.
  const sheetClass = phoneSheet === 'peek' ? ' assistant-above-sheet'
    : phoneSheet ? ' assistant-behind-sheet' : '';

  return (
    <div className={`assistant ${expanded ? 'assistant-expanded' : 'assistant-collapsed'}${drawerOpen ? ' assistant-drawer-shift' : ''}${sheetClass}${messages.length > 0 ? ' assistant-conversing' : ''}`}>
      <div className="assistant-header" onClick={() => setExpanded(!expanded)}>
        <div className="assistant-header-left">
          <div className="assistant-indicator" />
          {/* v2.5.0 — shown only when the bar is a round chat button above the
              results sheet on a phone (CSS decides) */}
          <span className="assistant-fab-icon" aria-hidden="true">💬</span>
          <span className="assistant-title">{messages.length ? sessionTitle : 'Site Suitability Assistant'}</span>
        </div>
        <div className="assistant-header-right">
          {messages.length > 0 && (
            <button className="new-chat-btn" onClick={(e) => { e.stopPropagation(); onNewChat(); }} title="New analysis">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          )}
          {hasResults && (
            <button className="assistant-results-toggle" onClick={(e) => { e.stopPropagation(); onToggleResults(); }} title={drawerOpen ? 'Hide results' : 'Show results'}>
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
          <div className="assistant-body" ref={scrollRef}>
            {messages.length === 0 && !isLoading && (
              <div className="assistant-welcome">
                <p className="assistant-welcome-text" style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b', marginBottom: 4 }}>
                  Where should this business go?
                </p>
                <p className="assistant-welcome-desc" style={{ fontSize: '12px', marginBottom: 8, color: '#64748b', lineHeight: 1.5 }}>
                  Say what you are opening and where. We ask what we need, agree the factors with you, then score the area from map data.
                </p>
                {user && !user.isAdmin && (
                  <div className="assistant-prompt-reminder">
                    <span>You have <strong>{promptsLeft} of {promptCap} analyses</strong> left.</span>
                  </div>
                )}
                <div className="assistant-chips">
                  {EXAMPLES.map(p => (
                    <button key={p} className="assistant-chip" onClick={() => onRunAnalysis(p)} disabled={isLoading}>{p}</button>
                  ))}
                </div>
                {onCheckSpot && (
                  <button type="button" className="assistant-spot-entry" onClick={onCheckSpot} disabled={isLoading}>
                    <span className="assistant-spot-icon">📷</span>
                    <span className="assistant-spot-text"><strong>Standing at a spot?</strong> Take a photo and check it.</span>
                  </button>
                )}
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`assistant-msg assistant-msg-${msg.role}`}>
                {msg.role === 'assistant' && <div className="assistant-avatar" />}
                <div className={`assistant-bubble assistant-bubble-${msg.role}`}>
                  {msg.role === 'assistant'
                    ? <div className="assistant-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown></div>
                    : msg.text}
                </div>
              </div>
            ))}

            {clarification && !isLoading && (
              <ClarificationCard clarification={clarification} onSubmit={onClarificationSubmit} disabled={isExecuting} />
            )}

            {showPlan && (
              <SpecSummaryCard
                spec={chatSpec}
                specStatus={chatSpecStatus}
                // v2.3.0 — one Run button. The sticky action bar below owns it
                // (it can never scroll out of view); the card used to render a
                // second one, and on a phone the two sat 40 px apart.
                readyToExecute={chatReady && !showRun}
                isExecuting={isExecuting}
                onConfirmExecute={onConfirmExecute}
                onSpecEdit={onSpecEdit}
                onSendMessage={onRunAnalysis}
                hideClarifyingQuestions={briefClarified}
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
                    {isExecuting && (
                      <button type="button" className="assistant-cancel-btn" onClick={onCancelAnalysis} title="Stop this analysis">
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
            {canRetry && !isLoading && (
              <div className="assistant-retry-row">
                <button type="button" className="assistant-retry-btn" onClick={onRetryAnalysis}>Retry analysis</button>
              </div>
            )}
          </div>

          {/* The Run button lives outside the scrolling body so it can never
              disappear behind internal scroll. Same path as the card's button. */}
          {showRun && (
            <div className="assistant-action-bar">
              <button type="button" className="assistant-start-btn" onClick={onConfirmExecute}>Run analysis</button>
            </div>
          )}

          {user && !user.isAdmin && messages.length > 0 && (
            <div className="assistant-prompts-remaining">
              <span>{promptsLeft} of {promptCap} analyses left</span>
              {promptsLeft <= 1 && promptsLeft > 0 && <span className="assistant-prompts-warning"> — last one!</span>}
            </div>
          )}

          <div className="assistant-input">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder="e.g. Cafe in Indiranagar, Bengaluru — 3 zones"
              className="assistant-text-input"
              disabled={isLoading}
            />
            <button onClick={submit} disabled={isLoading || !input.trim()} className="assistant-send" aria-label="Send">
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
