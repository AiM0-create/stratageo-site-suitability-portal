import React, { useState, useEffect, useCallback } from 'react';
import { fetchAdminStats, type AdminStats, type PromptEntry } from '../services/usageTracker';
import { MAX_PROMPTS_PER_USER } from '../config/firebase';

interface AdminDashboardProps {
  open: boolean;
  onClose: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ open, onClose }) => {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'users' | 'prompts'>('overview');
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      // clipboard blocked (e.g. insecure context) — no-op
    }
  }, []);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminStats();
      setStats(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadStats();
  }, [open, loadStats]);

  const filteredPrompts = selectedUser
    ? stats?.recentPrompts.filter(p => p.userId === selectedUser) || []
    : stats?.recentPrompts || [];

  // ── Non-determinism detection (v1.5.3) ──
  // Two runs with the SAME planningFingerprint are the SAME resolved prompt +
  // archetype schema + engine version — they should always produce the same
  // candidate count / top score / verdict. Group by fingerprint and flag any
  // group where those disagree; that's a genuine reproducibility bug, not a
  // "different prompt" false positive.
  const mismatchFingerprints = React.useMemo(() => {
    const groups: Record<string, PromptEntry[]> = {};
    for (const p of filteredPrompts) {
      if (!p.planningFingerprint) continue;
      (groups[p.planningFingerprint] ??= []).push(p);
    }
    const flagged = new Set<string>();
    for (const [fp, entries] of Object.entries(groups)) {
      if (entries.length < 2) continue;
      const distinct = new Set(entries.map(e =>
        `${e.resultCount}|${e.topScore?.toFixed(1)}|${e.analysisRecommendation}`));
      if (distinct.size > 1) flagged.add(fp);
    }
    return flagged;
  }, [filteredPrompts]);

  const exportComparisonReport = useCallback(() => {
    const groups: Record<string, PromptEntry[]> = {};
    for (const p of filteredPrompts) {
      const key = p.planningFingerprint || `(no fingerprint) ${p.prompt}`;
      (groups[key] ??= []).push(p);
    }
    const lines: string[] = [
      '# Prompt Comparison Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Total prompts: ${filteredPrompts.length} · Distinct fingerprints: ${Object.keys(groups).length} · Mismatches flagged: ${mismatchFingerprints.size}`,
      '',
      'Entries with the same `planningFingerprint` are the same resolved prompt + archetype + engine version — they should always produce the same result count / top score / verdict. `⚠ MISMATCH` means they did not.',
      '',
    ];
    for (const [key, entries] of Object.entries(groups)) {
      const isMismatch = mismatchFingerprints.has(key);
      entries.sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0));
      lines.push(`## ${isMismatch ? '⚠ MISMATCH — ' : ''}${entries[0].prompt}`);
      lines.push('');
      lines.push(`Fingerprint: \`${entries[0].planningFingerprint || 'n/a'}\` · Runs: ${entries.length}`);
      lines.push('');
      lines.push('| Time | User | Status | Verdict | Candidates | Top Score | Skipped Stages | Hard Constraints (V/P/U/UE/F) |');
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const e of entries) {
        const hc = e.hardConstraints;
        const hcStr = hc ? `${hc.verified}/${hc.proxyVerified}/${hc.notVerifiable}/${hc.unenforced}/${hc.failed}` : '—';
        lines.push(
          `| ${e.timestamp ? e.timestamp.toISOString() : '—'} | ${e.email} | ${e.analysisStatus || '—'} `
          + `| ${e.analysisRecommendation || '—'} | ${e.resultCount}${e.requestedTopN ? ` / ${e.requestedTopN}` : ''} `
          + `| ${e.topScore?.toFixed(1) ?? '—'} | ${(e.skippedStages || []).join(', ') || '—'} | ${hcStr} |`,
        );
        if (e.candidates?.length) {
          lines.push(`| | | | candidates: ${e.candidates.map(c => `${c.name} (${c.score?.toFixed(1) ?? '—'}${c.investigationLabel ? `, ${c.investigationLabel}` : ''})`).join('; ')} | | | | |`);
        }
      }
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompt-comparison-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredPrompts, mismatchFingerprints]);

  if (!open) return null;

  return (
    <div className="sg-admin-overlay" onClick={onClose}>
      <div className="sg-admin-panel" onClick={e => e.stopPropagation()}>
        <div className="sg-admin-header">
          <h2>Admin Dashboard</h2>
          <button className="sg-admin-close" onClick={onClose}>&times;</button>
        </div>

        <div className="sg-admin-tabs">
          <button className={`sg-admin-tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
          <button className={`sg-admin-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>Users</button>
          <button className={`sg-admin-tab ${tab === 'prompts' ? 'active' : ''}`} onClick={() => setTab('prompts')}>Prompts</button>
        </div>

        {loading && <div className="sg-admin-loading">Loading analytics...</div>}
        {error && <div className="sg-admin-error">{error}</div>}

        {stats && !loading && (
          <div className="sg-admin-content">
            {tab === 'overview' && (
              <div className="sg-admin-overview">
                <div className="sg-admin-cards">
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.totalUsers}</div>
                    <div className="sg-admin-card-label">Total Users</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.totalPrompts}</div>
                    <div className="sg-admin-card-label">Total Prompts</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.totalTokens.toLocaleString()}</div>
                    <div className="sg-admin-card-label">Tokens Used</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">~₹{stats.estCostINR.toFixed(0)}</div>
                    <div className="sg-admin-card-label">Est. API Cost (per-model rates)</div>
                  </div>
                  <div className="sg-admin-card sg-admin-card-highlight">
                    <div className="sg-admin-card-value">{stats.usersAtLimit}</div>
                    <div className="sg-admin-card-label">Users at Limit ({MAX_PROMPTS_PER_USER}/{MAX_PROMPTS_PER_USER})</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.avgLatencyMs ? `${(stats.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</div>
                    <div className="sg-admin-card-label">Avg Latency</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.avgTopScore != null ? stats.avgTopScore.toFixed(1) : '—'}</div>
                    <div className="sg-admin-card-label">Avg Top Score</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.promptsLast7d}</div>
                    <div className="sg-admin-card-label">Analyses (7 days)</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.followUpCount}</div>
                    <div className="sg-admin-card-label">Follow-up Queries</div>
                  </div>
                  <div className="sg-admin-card">
                    <div className="sg-admin-card-value">{stats.pdfExportCount}</div>
                    <div className="sg-admin-card-label">PDF Exports</div>
                  </div>
                </div>

                <div className="sg-admin-section">
                  <h3>Top Score Distribution</h3>
                  <div className="sg-admin-bars">
                    {stats.scoreDistribution.map(b => (
                      <div key={b.band} className="sg-admin-bar-row">
                        <span className="sg-admin-bar-label">{b.band}</span>
                        <div className="sg-admin-bar-track">
                          <div
                            className="sg-admin-bar-fill sg-admin-bar-fill-purple"
                            style={{ width: `${(b.count / Math.max(1, ...stats.scoreDistribution.map(x => x.count))) * 100}%` }}
                          />
                        </div>
                        <span className="sg-admin-bar-count">{b.count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="sg-admin-section">
                  <h3>Data Sources</h3>
                  <div className="sg-admin-bars">
                    {stats.dataSourceBreakdown.map(s => (
                      <div key={s.name} className="sg-admin-bar-row">
                        <span className="sg-admin-bar-label">{s.name === 'google-places' ? 'Places' : s.name === 'hybrid' ? 'Hybrid (v2 engine)' : s.name === 'demo' ? 'Demo' : 'OSM'}</span>
                        <div className="sg-admin-bar-track">
                          <div
                            className="sg-admin-bar-fill sg-admin-bar-fill-amber"
                            style={{ width: `${(s.count / Math.max(1, ...stats.dataSourceBreakdown.map(x => x.count))) * 100}%` }}
                          />
                        </div>
                        <span className="sg-admin-bar-count">{s.count}</span>
                      </div>
                    ))}
                    {stats.dataSourceBreakdown.length === 0 && <p className="sg-admin-empty">No data yet</p>}
                  </div>
                </div>

                <div className="sg-admin-section">
                  <h3>Top Sectors</h3>
                  <div className="sg-admin-bars">
                    {stats.topSectors.map(s => (
                      <div key={s.name} className="sg-admin-bar-row">
                        <span className="sg-admin-bar-label">{s.name}</span>
                        <div className="sg-admin-bar-track">
                          <div
                            className="sg-admin-bar-fill"
                            style={{ width: `${(s.count / Math.max(...stats.topSectors.map(x => x.count))) * 100}%` }}
                          />
                        </div>
                        <span className="sg-admin-bar-count">{s.count}</span>
                      </div>
                    ))}
                    {stats.topSectors.length === 0 && <p className="sg-admin-empty">No data yet</p>}
                  </div>
                </div>

                <div className="sg-admin-section">
                  <h3>Top Cities</h3>
                  <div className="sg-admin-bars">
                    {stats.topCities.map(c => (
                      <div key={c.name} className="sg-admin-bar-row">
                        <span className="sg-admin-bar-label">{c.name}</span>
                        <div className="sg-admin-bar-track">
                          <div
                            className="sg-admin-bar-fill sg-admin-bar-fill-green"
                            style={{ width: `${(c.count / Math.max(...stats.topCities.map(x => x.count))) * 100}%` }}
                          />
                        </div>
                        <span className="sg-admin-bar-count">{c.count}</span>
                      </div>
                    ))}
                    {stats.topCities.length === 0 && <p className="sg-admin-empty">No data yet</p>}
                  </div>
                </div>
              </div>
            )}

            {tab === 'users' && (
              <div className="sg-admin-users">
                <table className="sg-admin-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Prompts</th>
                      <th>Role</th>
                      <th>Last Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.users.map(u => (
                      <tr key={u.uid} className={!u.isAdmin && u.promptsUsed >= MAX_PROMPTS_PER_USER ? 'sg-admin-row-limit' : ''}>
                        <td>{u.email}</td>
                        <td>
                          <span className={`sg-admin-prompt-badge ${!u.isAdmin && u.promptsUsed >= MAX_PROMPTS_PER_USER ? 'at-limit' : ''}`}>
                            {u.isAdmin ? `${u.promptsUsed} / \u221E` : `${u.promptsUsed} / ${MAX_PROMPTS_PER_USER}`}
                          </span>
                        </td>
                        <td>{u.isAdmin ? <span className="sg-admin-badge-admin">Admin</span> : 'User'}</td>
                        <td>{u.lastLogin ? timeAgo(u.lastLogin) : 'Never'}</td>
                        <td>
                          <button
                            className="sg-admin-btn-sm"
                            onClick={() => { setSelectedUser(u.uid); setTab('prompts'); }}
                          >
                            View prompts
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'prompts' && (
              <div className="sg-admin-prompts">
                <div className="sg-admin-prompts-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  {selectedUser && (
                    <button className="sg-admin-btn-sm" onClick={() => setSelectedUser(null)}>
                      Show all prompts
                    </button>
                  )}
                  {filteredPrompts.length > 0 && (
                    <button
                      className="sg-admin-btn-sm"
                      onClick={() => copyText(
                        'all',
                        filteredPrompts.map(p => `[${p.email}] ${p.prompt}`).join('\n\n'),
                      )}
                      title="Copy every prompt shown (one per line, with email)"
                    >
                      {copiedId === 'all' ? '✓ Copied' : `Copy all (${filteredPrompts.length})`}
                    </button>
                  )}
                  {filteredPrompts.length > 0 && (
                    <button
                      className="sg-admin-btn-sm"
                      onClick={exportComparisonReport}
                      title="Download a structured .md report grouping runs by planningFingerprint, flagging any where the same prompt produced a different result"
                    >
                      Export comparison report (.md)
                    </button>
                  )}
                  {mismatchFingerprints.size > 0 && (
                    <span className="sg-admin-badge-mismatch" title="Same prompt/fingerprint produced different results across runs">
                      ⚠ {mismatchFingerprints.size} mismatch{mismatchFingerprints.size > 1 ? 'es' : ''} detected
                    </span>
                  )}
                </div>
                <table className="sg-admin-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Email</th>
                      <th>Prompt</th>
                      <th>Sector</th>
                      <th>City</th>
                      <th>Verdict</th>
                      <th>Score</th>
                      <th>Results</th>
                      <th>Tokens</th>
                      <th>Source</th>
                      <th>Latency</th>
                      <th>PDF</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPrompts.map(p => {
                      const hasOutput = !!(p.planningFingerprint || p.analysisRecommendation || p.candidates?.length);
                      const isMismatch = !!p.planningFingerprint && mismatchFingerprints.has(p.planningFingerprint);
                      return (
                      <React.Fragment key={p.id}>
                      <tr className={isMismatch ? 'sg-admin-row-mismatch' : ''}>
                        <td>
                          {hasOutput && (
                            <button
                              className="sg-admin-btn-sm"
                              onClick={() => setExpandedOutputs(e => ({ ...e, [p.id]: !e[p.id] }))}
                              title={expandedOutputs[p.id] ? 'Hide output' : 'Show output'}
                            >
                              {expandedOutputs[p.id] ? '▾' : '▸'} Output
                            </button>
                          )}
                        </td>
                        <td className="sg-admin-cell-email">{p.email}</td>
                        <td className="sg-admin-cell-prompt">
                          {p.isFollowUp && <span className="sg-admin-badge-followup">F/U</span>}
                          {isMismatch && <span className="sg-admin-badge-mismatch" title="Same fingerprint, different result across runs">⚠</span>}
                          <span
                            className="sg-admin-prompt-text"
                            onClick={() => setExpandedPrompts(e => ({ ...e, [p.id]: !e[p.id] }))}
                            title={expandedPrompts[p.id] ? 'Click to collapse' : 'Click to expand full prompt'}
                            style={{ cursor: p.prompt.length > 50 ? 'pointer' : 'default', whiteSpace: expandedPrompts[p.id] ? 'pre-wrap' : 'nowrap' }}
                          >
                            {expandedPrompts[p.id] || p.prompt.length <= 50 ? p.prompt : p.prompt.slice(0, 50) + '…'}
                          </span>
                          <button
                            className="sg-admin-copy-btn"
                            onClick={(e) => { e.stopPropagation(); copyText(p.id, p.prompt); }}
                            title="Copy full prompt"
                          >
                            {copiedId === p.id ? '✓' : 'Copy'}
                          </button>
                        </td>
                        <td>{p.sector}</td>
                        <td>{p.city}</td>
                        <td>{p.analysisRecommendation ? <span className="sg-admin-source-badge">{p.analysisRecommendation.replace(/_/g, ' ')}</span> : '-'}</td>
                        <td>{p.topScore?.toFixed(1) || '-'}</td>
                        <td>{p.resultCount || '-'}{p.requestedTopN ? ` / ${p.requestedTopN}` : ''}</td>
                        <td>{p.tokensUsed ? p.tokensUsed.toLocaleString() : '-'}</td>
                        <td><span className={`sg-admin-source-badge sg-admin-source-${p.dataSource || 'osm'}`}>{p.dataSource === 'google-places' ? 'Places' : p.dataSource === 'hybrid' ? 'Hybrid' : p.dataSource === 'demo' ? 'Demo' : 'OSM'}</span></td>
                        <td>{(p.latencyMs / 1000).toFixed(1)}s</td>
                        <td>{p.pdfExported ? '✓' : '-'}</td>
                        <td>{p.timestamp ? timeAgo(p.timestamp) : '-'}</td>
                      </tr>
                      {expandedOutputs[p.id] && hasOutput && (
                        <tr className="sg-admin-row-output">
                          <td colSpan={13}>
                            <div className="sg-admin-output-panel">
                              {p.planningFingerprint && (
                                <div><b>Fingerprint:</b> <code>{p.planningFingerprint}</code>{isMismatch && <span className="sg-admin-badge-mismatch"> ⚠ differs from other run(s) of this same fingerprint</span>}</div>
                              )}
                              {p.analysisStatus && <div><b>Status:</b> {p.analysisStatus}</div>}
                              {p.skippedStages && p.skippedStages.length > 0 && (
                                <div><b>Skipped stages:</b> {p.skippedStages.join(', ')}</div>
                              )}
                              {p.hardConstraints && (
                                <div>
                                  <b>Hard constraints:</b>{' '}
                                  <span style={{ color: '#059669' }}>{p.hardConstraints.verified} verified</span>
                                  {' · '}<span style={{ color: '#d97706' }}>{p.hardConstraints.proxyVerified} proxy</span>
                                  {' · '}<span style={{ color: '#92400e' }}>{p.hardConstraints.notVerifiable} not verifiable</span>
                                  {' · '}<span style={{ color: '#dc2626' }}>{p.hardConstraints.unenforced} unenforced</span>
                                  {' · '}<span style={{ color: '#dc2626' }}>{p.hardConstraints.failed} failed</span>
                                </div>
                              )}
                              {p.candidates && p.candidates.length > 0 && (
                                <div>
                                  <b>Candidates:</b>
                                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                                    {p.candidates.map((c, i) => (
                                      <li key={i}>{c.name} — {c.score?.toFixed(1) ?? '—'}/10{c.investigationLabel ? ` (${c.investigationLabel.replace(/_/g, ' ')})` : ''}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                      );
                    })}
                    {filteredPrompts.length === 0 && (
                      <tr><td colSpan={13} className="sg-admin-empty">No prompts yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="sg-admin-footer">
          <button className="sg-admin-btn-sm" onClick={loadStats} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
};

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
