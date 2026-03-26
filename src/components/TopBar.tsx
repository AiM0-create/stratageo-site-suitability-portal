import React, { useState, useRef, useEffect } from 'react';
import type { SessionIndexEntry } from '../types/session';

interface UserInfo {
  displayName: string;
  email: string;
  photoURL: string | null;
  isAdmin: boolean;
  promptsRemaining: number;
}

interface TopBarProps {
  mode: 'demo' | 'live';
  hasResults: boolean;
  onExportPDF: () => void;
  onMethodology: () => void;
  onNewAnalysis: () => void;
  sessions: SessionIndexEntry[];
  currentSessionId: string | null;
  onSwitchSession: (id: string) => void;
  user?: UserInfo | null;
  onLogout?: () => void;
  onAdminOpen?: () => void;
  onSavedOpen?: () => void;
  onShareAnalysis?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ mode, hasResults, onExportPDF, onMethodology, onNewAnalysis, sessions, currentSessionId, onSwitchSession, user, onLogout, onAdminOpen, onSavedOpen, onShareAnalysis }) => {
  const [historyOpen, setHistoryOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [historyOpen]);

  const recentSessions = sessions.filter(s => !s.archived).slice(0, 10);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <a href="https://stratageo.in/index.html" className="topbar-logo" aria-label="Stratageo">
          <span className="logo-strata">STRATA</span><span className="logo-geo">GEO</span>
        </a>
        <span className={`topbar-badge ${mode === 'demo' ? 'badge-demo' : 'badge-live'}`}>
          {mode === 'demo' ? 'Demo' : 'Live'}
        </span>
        <span className="topbar-version">v0.8.0</span>
      </div>
      <div className="topbar-right">
        {/* Session history */}
        {recentSessions.length > 1 && (
          <div className="session-dropdown-wrap" ref={dropdownRef}>
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="topbar-btn"
              title="Session history"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </button>
            {historyOpen && (
              <div className="session-dropdown">
                {recentSessions.map(s => (
                  <button
                    key={s.id}
                    className={`session-item ${s.id === currentSessionId ? 'session-item-active' : ''}`}
                    onClick={() => { onSwitchSession(s.id); setHistoryOpen(false); }}
                  >
                    <span className="session-item-title">{s.title}</span>
                    <span className="session-item-meta">{s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={onMethodology} className="topbar-btn" title="How this works">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
        </button>
        {onSavedOpen && (
          <button onClick={onSavedOpen} className="topbar-btn" title="My analyses">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
            </svg>
          </button>
        )}
        {hasResults && (
          <>
            {onShareAnalysis && (
              <button onClick={onShareAnalysis} className="topbar-btn" title="Share analysis">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935-2.186 2.25 2.25 0 0 0-3.935 2.186Zm0-12.814a2.25 2.25 0 1 0 3.935-2.186 2.25 2.25 0 0 0-3.935 2.186Z" />
                </svg>
              </button>
            )}
            <button onClick={onExportPDF} className="topbar-btn" title="Export PDF">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
            </button>
            <button onClick={onNewAnalysis} className="topbar-btn" title="New analysis">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="icon-sm">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          </>
        )}
        {user && (
          <div className="sg-user-badge">
            {user.photoURL && <img src={user.photoURL} alt="" className="sg-user-avatar" referrerPolicy="no-referrer" />}
            <div className="sg-user-info">
              <span className="sg-user-name">{user.displayName || user.email.split('@')[0]}</span>
              <span className={`sg-user-prompts ${!user.isAdmin && user.promptsRemaining <= 1 ? 'sg-user-prompts-warn' : ''}`}>
                {user.isAdmin ? 'Unlimited' : `${user.promptsRemaining} prompts left`}
              </span>
            </div>
            {user.isAdmin && onAdminOpen && (
              <button className="sg-admin-trigger" onClick={onAdminOpen}>Admin</button>
            )}
            {onLogout && (
              <button className="sg-user-logout" onClick={onLogout}>Sign out</button>
            )}
          </div>
        )}
        <a href="https://stratageo.in/contact.php" target="_blank" rel="noopener noreferrer" className="topbar-contact">
          Contact
        </a>
      </div>
    </div>
  );
};
