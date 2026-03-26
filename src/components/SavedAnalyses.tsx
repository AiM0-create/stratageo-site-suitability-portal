import React, { useState, useEffect } from 'react';
import { fetchUserAnalyses, SavedAnalysis } from '../services/analysisStore';
import { useAuth } from '../contexts/AuthContext';

interface SavedAnalysesProps {
  open: boolean;
  onClose: () => void;
  onLoadAnalysis: (analysis: SavedAnalysis) => void;
  onShareAnalysis: (shareId: string) => void;
}

function relativeTime(date: Date | null): string {
  if (!date) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function scoreColor(score: number | null): string {
  if (score === null) return '#94a3b8'; // gray-400
  if (score >= 7.5) return '#16a34a'; // green-600
  if (score >= 5) return '#d97706'; // amber-600
  return '#dc2626'; // red-600
}

const SavedAnalyses: React.FC<SavedAnalysesProps> = ({ open, onClose, onLoadAnalysis, onShareAnalysis }) => {
  const { user } = useAuth();
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user?.uid) return;
    setLoading(true);
    setError(null);
    fetchUserAnalyses(user.uid)
      .then(setAnalyses)
      .catch(() => setError('Failed to load analyses.'))
      .finally(() => setLoading(false));
  }, [open, user?.uid]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="sg-saved-backdrop"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.3)',
          zIndex: 999,
          transition: 'opacity 0.2s ease',
        }}
      />

      {/* Panel */}
      <div
        className="sg-saved-panel"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 340,
          maxWidth: '100%',
          backgroundColor: '#f8fafc', // gray-50
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '4px 0 24px rgba(0,0,0,0.12)',
          animation: 'sg-slide-in-left 0.25s ease-out',
        }}
      >
        {/* Header */}
        <div
          className="sg-saved-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #e2e8f0', // gray-200
            backgroundColor: '#fff',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1e293b' }}>
            My Analyses
          </h2>
          <button
            onClick={onClose}
            className="sg-saved-close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              color: '#64748b', // gray-500
              fontSize: 20,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="Close panel"
          >
            &#x2715;
          </button>
        </div>

        {/* Content */}
        <div
          className="sg-saved-content"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
          }}
        >
          {loading && (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: '#94a3b8' }}>
              <div
                className="sg-saved-spinner"
                style={{
                  width: 28,
                  height: 28,
                  border: '3px solid #e2e8f0',
                  borderTopColor: '#2563eb',
                  borderRadius: '50%',
                  animation: 'sg-spin 0.7s linear infinite',
                  margin: '0 auto 12px',
                }}
              />
              Loading analyses...
            </div>
          )}

          {error && (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: '#dc2626' }}>
              {error}
            </div>
          )}

          {!loading && !error && analyses.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: '#94a3b8', fontSize: 14, lineHeight: 1.6 }}>
              No saved analyses yet. Run your first analysis to see it here.
            </div>
          )}

          {!loading && !error && analyses.map((a) => (
            <div
              key={a.id}
              className="sg-saved-card"
              onClick={() => onLoadAnalysis(a)}
              style={{
                backgroundColor: '#fff',
                borderRadius: 10,
                padding: '14px 16px',
                marginBottom: 10,
                cursor: 'pointer',
                border: '1px solid #e2e8f0',
                transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
                (e.currentTarget as HTMLDivElement).style.borderColor = '#cbd5e1';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                (e.currentTarget as HTMLDivElement).style.borderColor = '#e2e8f0';
              }}
            >
              {/* Title row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', lineHeight: 1.4 }}>
                  {a.businessType} &mdash; {a.city}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onShareAnalysis(a.shareId);
                  }}
                  className="sg-saved-share"
                  title="Share analysis"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 4,
                    borderRadius: 4,
                    color: '#94a3b8',
                    fontSize: 14,
                    flexShrink: 0,
                    lineHeight: 1,
                  }}
                  aria-label="Share analysis"
                >
                  {/* Share icon (simple SVG) */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                </button>
              </div>

              {/* Meta row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 12, color: '#64748b' }}>
                <span>{relativeTime(a.createdAt)}</span>
                <span style={{ color: '#cbd5e1' }}>|</span>
                <span>{a.locationCount} location{a.locationCount !== 1 ? 's' : ''}</span>
              </div>

              {/* Score badge */}
              {a.topScore !== null && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: scoreColor(a.topScore),
                    }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, color: scoreColor(a.topScore) }}>
                    {a.topScore.toFixed(1)}
                  </span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>top score</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Keyframe animations */}
      <style>{`
        @keyframes sg-slide-in-left {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes sg-spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 640px) {
          .sg-saved-panel {
            width: 100% !important;
          }
        }
      `}</style>
    </>
  );
};

export default SavedAnalyses;
