/**
 * DiagnosticsPanel — Expandable debug panel showing AI intent diagnostics.
 *
 * Shows: Live AI status, backend URL, intent source, last response time,
 * GPT model, structured intent, and fallback reason.
 *
 * Visible in both dev and production as a small toggle.
 */

import React, { useState, useEffect } from 'react';
import { config } from '../config';
import { getLastDiagnostics, checkBackendHealth } from '../services/llmIntentExtractor';
import type { IntentDiagnostics } from '../services/llmIntentExtractor';

export const DiagnosticsPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<IntentDiagnostics>(getLastDiagnostics());
  const [healthStatus, setHealthStatus] = useState<string>('...');
  const [healthChecking, setHealthChecking] = useState(false);

  // Refresh diagnostics when panel opens
  useEffect(() => {
    if (open) {
      setDiagnostics(getLastDiagnostics());
    }
  }, [open]);

  // Also refresh after any analysis (poll every 2s when open)
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => {
      setDiagnostics(getLastDiagnostics());
    }, 2000);
    return () => clearInterval(interval);
  }, [open]);

  const runHealthCheck = async () => {
    setHealthChecking(true);
    setHealthStatus('Checking...');
    const result = await checkBackendHealth();
    setHealthStatus(result.ok ? `✅ ${result.detail}` : `❌ ${result.detail}`);
    setHealthChecking(false);
  };

  const sourceLabel = (src: string) => {
    switch (src) {
      case 'gpt': return '🟢 GPT Intent Extraction';
      case 'local_fallback': return '🟡 Local Fallback Classifier';
      case 'demo_mode': return '⚪ Demo Scenario Mode';
      case 'not_attempted': return '⚫ Not Attempted';
      default: return src;
    }
  };

  const sourceColor = (src: string) => {
    switch (src) {
      case 'gpt': return '#059669';
      case 'local_fallback': return '#d97706';
      case 'demo_mode': return '#6b7280';
      default: return '#94a3b8';
    }
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: '12px',
      left: '12px',
      zIndex: 9999,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: '11px',
    }}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: diagnostics.source === 'gpt' ? '#059669' : diagnostics.source === 'local_fallback' ? '#d97706' : '#475569',
          color: '#fff',
          border: 'none',
          borderRadius: open ? '6px 6px 0 0' : '6px',
          padding: '4px 10px',
          cursor: 'pointer',
          fontSize: '10px',
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
        title="AI Diagnostics Panel"
      >
        <span style={{ fontSize: '8px' }}>●</span>
        {diagnostics.source === 'gpt' ? 'GPT' : diagnostics.source === 'local_fallback' ? 'FALLBACK' : config.isDemoMode ? 'DEMO' : 'AI'}
        <span style={{ opacity: 0.7 }}>{open ? '▼' : '▲'}</span>
      </button>

      {/* Panel */}
      {open && (
        <div style={{
          background: '#1e293b',
          color: '#e2e8f0',
          borderRadius: '0 6px 6px 6px',
          padding: '10px 12px',
          width: '360px',
          maxHeight: '400px',
          overflowY: 'auto',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, marginBottom: '8px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            AI Diagnostics
          </div>

          {/* Config */}
          <Row label="Mode" value={config.isDemoMode ? 'Demo' : 'Live'} color={config.isDemoMode ? '#d97706' : '#059669'} />
          <Row label="AI Backend" value={config.aiBackendUrl || '(not configured)'} />
          <Row label="Intent Source" value={sourceLabel(diagnostics.source)} color={sourceColor(diagnostics.source)} />

          {/* Last attempt */}
          {diagnostics.timestamp && (
            <>
              <Divider />
              <div style={{ fontWeight: 600, marginBottom: '4px', color: '#94a3b8', fontSize: '10px', textTransform: 'uppercase' }}>
                Last Intent Extraction
              </div>
              <Row label="Attempted" value={diagnostics.attempted ? 'Yes' : 'No'} />
              <Row label="Succeeded" value={diagnostics.succeeded ? 'Yes ✅' : 'No ❌'} color={diagnostics.succeeded ? '#059669' : '#ef4444'} />
              {diagnostics.httpStatus && <Row label="HTTP Status" value={String(diagnostics.httpStatus)} />}
              {diagnostics.responseTimeMs != null && <Row label="Response Time" value={`${diagnostics.responseTimeMs}ms`} />}
              {diagnostics.failureReason && (
                <div style={{ marginTop: '4px' }}>
                  <span style={{ color: '#94a3b8' }}>Reason: </span>
                  <span style={{ color: '#fbbf24', wordBreak: 'break-word' }}>{diagnostics.failureReason}</span>
                </div>
              )}
              <Row label="Timestamp" value={diagnostics.timestamp} />
            </>
          )}

          {/* Raw intent preview */}
          {diagnostics.rawIntent && (
            <>
              <Divider />
              <div style={{ fontWeight: 600, marginBottom: '4px', color: '#94a3b8', fontSize: '10px', textTransform: 'uppercase' }}>
                GPT Structured Intent
              </div>
              <Row label="Business Type" value={diagnostics.rawIntent.businessType} />
              <Row label="Sector" value={diagnostics.rawIntent.sector} />
              {diagnostics.rawIntent.brand && <Row label="Brand" value={diagnostics.rawIntent.brand} />}
              <Row label="Confidence" value={diagnostics.rawIntent.confidence} />
              <Row label="Anchor" value={diagnostics.rawIntent.anchorType} />
              {diagnostics.rawIntent.osmCriteria && (
                <Row label="Dynamic Criteria" value={`${diagnostics.rawIntent.osmCriteria.length} criteria generated`} />
              )}
              {diagnostics.rawIntent.siteProfile && (
                <Row label="Profile" value={diagnostics.rawIntent.siteProfile.profileSummary} />
              )}
            </>
          )}

          {/* Health check */}
          <Divider />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={runHealthCheck}
              disabled={healthChecking}
              style={{
                background: '#334155',
                color: '#e2e8f0',
                border: '1px solid #475569',
                borderRadius: '4px',
                padding: '3px 8px',
                cursor: healthChecking ? 'wait' : 'pointer',
                fontSize: '10px',
                fontFamily: 'inherit',
              }}
            >
              {healthChecking ? 'Checking...' : 'Check Backend Health'}
            </button>
            <span style={{ fontSize: '10px', color: healthStatus.includes('✅') ? '#059669' : healthStatus.includes('❌') ? '#ef4444' : '#94a3b8' }}>
              {healthStatus}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '2px' }}>
    <span style={{ color: '#94a3b8', flexShrink: 0 }}>{label}:</span>
    <span style={{ color: color || '#e2e8f0', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
  </div>
);

const Divider: React.FC = () => (
  <div style={{ borderTop: '1px solid #334155', margin: '8px 0' }} />
);
