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

  if (!open) return null;

  const filteredPrompts = selectedUser
    ? stats?.recentPrompts.filter(p => p.userId === selectedUser) || []
    : stats?.recentPrompts || [];

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
                {selectedUser && (
                  <button className="sg-admin-btn-sm" onClick={() => setSelectedUser(null)} style={{ marginBottom: 8 }}>
                    Show all prompts
                  </button>
                )}
                <table className="sg-admin-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Prompt</th>
                      <th>Sector</th>
                      <th>City</th>
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
                    {filteredPrompts.map(p => (
                      <tr key={p.id}>
                        <td className="sg-admin-cell-email">{p.email}</td>
                        <td className="sg-admin-cell-prompt" title={p.prompt}>
                          {p.isFollowUp && <span className="sg-admin-badge-followup">F/U</span>}
                          {p.prompt.length > 50 ? p.prompt.slice(0, 50) + '...' : p.prompt}
                        </td>
                        <td>{p.sector}</td>
                        <td>{p.city}</td>
                        <td>{p.topScore?.toFixed(1) || '-'}</td>
                        <td>{p.resultCount || '-'}</td>
                        <td>{p.tokensUsed ? p.tokensUsed.toLocaleString() : '-'}</td>
                        <td><span className={`sg-admin-source-badge sg-admin-source-${p.dataSource || 'osm'}`}>{p.dataSource === 'google-places' ? 'Places' : p.dataSource === 'hybrid' ? 'Hybrid' : p.dataSource === 'demo' ? 'Demo' : 'OSM'}</span></td>
                        <td>{(p.latencyMs / 1000).toFixed(1)}s</td>
                        <td>{p.pdfExported ? '✓' : '-'}</td>
                        <td>{p.timestamp ? timeAgo(p.timestamp) : '-'}</td>
                      </tr>
                    ))}
                    {filteredPrompts.length === 0 && (
                      <tr><td colSpan={11} className="sg-admin-empty">No prompts yet</td></tr>
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
