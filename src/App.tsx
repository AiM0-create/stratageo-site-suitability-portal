import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { LocationData, AnalysisResult, AnalysisStatus, AnalysisSpec, HeatmapType, UserPoint } from './types';
import { config } from './config';
import { runDemoAnalysis, runLiveAnalysis } from './services/analysisService';
import { recalculateWithWeights } from './services/mcdaEngine';
import { parseCSV } from './services/csvParser';
import { resolveContext } from './services/contextResolver';
import { useSession } from './contexts/SessionContext';
import { useAuth } from './contexts/AuthContext';
import { logPrompt } from './services/usageTracker';
import { TopBar } from './components/TopBar';
import { MapView } from './components/MapView';
import { FloatingAssistant } from './components/FloatingAssistant';
import { ResultsDrawer } from './components/ResultsDrawer';
import { MethodologyDialog } from './components/MethodologyDialog';
import { GuidedTour } from './components/GuidedTour';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { LoginScreen } from './components/LoginScreen';
import { AdminDashboard } from './components/AdminDashboard';
import { PromptLimitModal } from './components/PromptLimitModal';

declare const html2canvas: any;
declare const jspdf: any;

const App: React.FC = () => {
  const { user, loading: authLoading, logout, consumePrompt } = useAuth();
  const { state: sessionState, addMessage, updateMemory, newSession, switchSession, clearMemoryField, dispatch } = useSession();
  const { currentSession, sessionIndex } = sessionState;

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<LocationData[]>([]);
  const [customWeights, setCustomWeights] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({ message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [heatmapType, setHeatmapType] = useState<HeatmapType>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [tourActive, setTourActive] = useState(false);
  const [resultCount, setResultCount] = useState(3);
  const [userPoints, setUserPoints] = useState<UserPoint[]>([]);
  const [showBuffers, setShowBuffers] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);
  const [limitModalOpen, setLimitModalOpen] = useState(false);

  // ─── Results cache: preserve results across session switches ───
  interface CachedResults {
    result: AnalysisResult;
    spec: AnalysisSpec;
    weights: Record<string, number>;
    userPoints: UserPoint[];
  }
  const resultsCacheRef = useRef<Map<string, CachedResults>>(new Map());
  const prevSessionIdRef = useRef<string>(currentSession.id);

  // When session changes, cache old results and restore new ones
  useEffect(() => {
    if (prevSessionIdRef.current === currentSession.id) return;

    // Cache current results under the old session ID
    if (result && spec) {
      resultsCacheRef.current.set(prevSessionIdRef.current, {
        result,
        spec,
        weights: customWeights,
        userPoints,
      });
    }

    // Restore cached results for the new session (if any)
    const cached = resultsCacheRef.current.get(currentSession.id);
    if (cached) {
      setResult(cached.result);
      setSpec(cached.spec);
      setCustomWeights(cached.weights);
      setUserPoints(cached.userPoints);
      setDrawerOpen(true);
    } else {
      setResult(null);
      setSpec(null);
      setCustomWeights({});
      setUserPoints([]);
      setDrawerOpen(false);
    }

    setSelectedLocations([]);
    setError(null);
    setHeatmapType(null);
    prevSessionIdRef.current = currentSession.id;
  }, [currentSession.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive messages from session for display
  const messages = useMemo(() =>
    currentSession.messages.map(m => ({ role: m.role, text: m.text })),
    [currentSession.messages],
  );

  const locations = useMemo(() => {
    if (!result) return [];
    return recalculateWithWeights(result.locations, customWeights);
  }, [result, customWeights]);

  const selectedRecalculated = useMemo(() => {
    return locations.filter(loc => selectedLocations.some(sl => sl.name === loc.name));
  }, [locations, selectedLocations]);

  const handleCSVUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const csvResult = parseCSV(text);

      if (csvResult.errors.length > 0) {
        setError(csvResult.errors.join(' '));
        addMessage('assistant', `CSV Error: ${csvResult.errors.join(' ')}`, { intent: 'csv_upload' });
        return;
      }

      setUserPoints(csvResult.points);
      updateMemory({ csvFileName: file.name, csvPointCount: csvResult.points.length });
      const msg = `Loaded ${csvResult.points.length} location(s) from CSV.${csvResult.warnings.length > 0 ? ' ' + csvResult.warnings.join(' ') : ''} These points will be used as spatial constraints in your next analysis.`;
      addMessage('assistant', msg, { intent: 'csv_upload' });
    };
    reader.onerror = () => {
      setError('Failed to read CSV file.');
    };
    reader.readAsText(file);
  }, [addMessage, updateMemory]);

  const handleClearCSV = useCallback(() => {
    setUserPoints([]);
    updateMemory({ csvFileName: null, csvPointCount: 0 });
    addMessage('assistant', 'CSV locations cleared.');
  }, [addMessage, updateMemory]);

  const handleRunAnalysis = useCallback(async (rawPrompt: string) => {
    // ─── Prompt limit check ───
    const canProceed = await consumePrompt();
    if (!canProceed) {
      setLimitModalOpen(true);
      return;
    }

    const analysisStartTime = Date.now();
    setIsLoading(true);
    setError(null);
    // Keep old results visible during loading — they'll be replaced when new results arrive
    setSelectedLocations([]);
    setHeatmapType(null);
    setAnalysisStatus({ message: 'Starting analysis...', progress: 5 });

    // Resolve context for follow-ups
    const resolved = resolveContext(rawPrompt, currentSession.memory, currentSession.messages);

    addMessage('user', rawPrompt, { intent: resolved.isFollowUp ? 'followup' : 'query' });

    if (resolved.isFollowUp) {
      addMessage('assistant', `Continuing from previous analysis. ${resolved.contextSummary}`);
    }

    try {
      const promptToSend = resolved.effectivePrompt;
      const analysisResult = config.isDemoMode
        ? await runDemoAnalysis(rawPrompt, setAnalysisStatus)
        : await runLiveAnalysis(promptToSend, resultCount, setAnalysisStatus, userPoints.length > 0 ? userPoints : undefined);

      const parsedSpec = analysisResult.spec;
      const csvNote = userPoints.length > 0 ? ` with ${userPoints.length} CSV point(s)` : '';
      const locationDesc = parsedSpec.geography.anchor && !parsedSpec.geography.city
        ? `near ${parsedSpec.geography.anchor.lat.toFixed(4)}, ${parsedSpec.geography.anchor.lng.toFixed(4)}`
        : `in ${parsedSpec.geography.city || '(no location detected)'}`;
      const source = parsedSpec.classificationMeta?.source === 'llm' ? 'AI-profiled' : 'local classifier';
      const conf = parsedSpec.classificationMeta?.confidence || parsedSpec.confidence;
      const criteriaCount = analysisResult.result.locations[0]?.criteria_breakdown.length || 0;
      const specMsg = `Understood: ${parsedSpec.businessType} ${locationDesc} (${source}, ${conf} confidence, ${criteriaCount} criteria)` +
        (parsedSpec.constraints.length > 0 ? ` with ${parsedSpec.constraints.length} constraint(s)` : '') +
        csvNote;

      addMessage('assistant', specMsg);

      setResult(analysisResult.result);
      setSpec(analysisResult.spec);

      if (analysisResult.result.locations.length > 0) {
        const weights: Record<string, number> = {};
        analysisResult.result.locations[0].criteria_breakdown.forEach(c => {
          weights[c.name] = c.weight;
        });
        setCustomWeights(weights);
      }

      setDrawerOpen(true);

      const top = analysisResult.result.locations.filter(l => !l.excluded)[0];
      const excludedCount = analysisResult.result.locations.filter(l => l.excluded).length;
      addMessage('assistant', top
        ? `Screened ${analysisResult.result.locations.length} areas in ${analysisResult.result.target_location}. ${top.name} ranks highest at ${top.mcda_score}/10.${excludedCount > 0 ? ` ${excludedCount} excluded by constraints.` : ''}`
        : analysisResult.result.summary,
      );

      // Update working memory from results
      updateMemory({
        businessType: parsedSpec.businessType,
        city: parsedSpec.geography.city || null,
        coordinates: parsedSpec.geography.anchor || null,
        sectorId: parsedSpec.sectorId,
        constraints: parsedSpec.constraints.map(c => c.label),
        lastResultCount: analysisResult.result.locations.length,
        lastSearchRadiusM: analysisResult.result.locations[0]?.searchRadiusM || null,
        lastAnalysisTimestamp: new Date().toISOString(),
      });

      // Auto-title the session on first analysis
      if (currentSession.title === 'New Analysis') {
        const title = `${parsedSpec.businessType} in ${parsedSpec.geography.city || 'coordinates'}`;
        dispatch({ type: 'SET_TITLE', title });
      }

      // ─── Log usage to Firestore ───
      if (user) {
        const topLoc = analysisResult.result.locations.filter(l => !l.excluded)[0];
        logPrompt({
          userId: user.uid,
          email: user.email,
          prompt: rawPrompt,
          sector: parsedSpec.sectorId || parsedSpec.businessType,
          city: parsedSpec.geography.city || '',
          latencyMs: Date.now() - analysisStartTime,
          resultCount: analysisResult.result.locations.length,
          topScore: topLoc?.mcda_score ?? null,
          pdfExported: false,
          isFollowUp: resolved.isFollowUp,
        });
      }
    } catch (err: any) {
      const msg = err?.message || 'Analysis failed. Please try again.';
      setError(msg);
      setResult(null);
      setSpec(null);
      setCustomWeights({});
      setDrawerOpen(false);
      addMessage('assistant', msg);
    } finally {
      setIsLoading(false);
    }
  }, [resultCount, userPoints, currentSession.memory, currentSession.messages, currentSession.title, addMessage, updateMemory, dispatch, consumePrompt, user]);

  const handleSelectLocation = useCallback((location: LocationData) => {
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    setSelectedLocations(prev => {
      const isSelected = prev.some(l => l.name === location.name);
      if (isSelected) return prev.filter(l => l.name !== location.name);
      if (prev.length < 3) return [...prev, location];
      return [prev[prev.length - 1], location];
    });

    if (!drawerOpen) setDrawerOpen(true);
  }, [drawerOpen]);

  const handleDeselectAll = useCallback(() => setSelectedLocations([]), []);

  const handleWeightChange = useCallback((name: string, weight: number) => {
    setCustomWeights(prev => ({ ...prev, [name]: weight }));
  }, []);

  const handleResultCountChange = useCallback((count: number) => {
    if (count > 5) {
      addMessage('assistant', 'For this live demo, results are limited to 5 ranked locations to keep the analysis responsive and reliable. For larger batch screening or custom studies, please contact Stratageo.');
      setResultCount(5);
    } else {
      setResultCount(Math.max(1, count));
    }
  }, [addMessage]);

  const handleSwitchSession = useCallback((id: string) => {
    // Cache current results before switching
    if (result && spec) {
      resultsCacheRef.current.set(currentSession.id, {
        result,
        spec,
        weights: customWeights,
        userPoints,
      });
    }
    switchSession(id);
  }, [switchSession, result, spec, customWeights, userPoints, currentSession.id]);

  const handleNewAnalysis = useCallback(() => {
    // Cache current results before switching
    if (result && spec) {
      resultsCacheRef.current.set(currentSession.id, {
        result,
        spec,
        weights: customWeights,
        userPoints,
      });
    }
    setResult(null);
    setSpec(null);
    setSelectedLocations([]);
    setCustomWeights({});
    setError(null);
    setHeatmapType(null);
    setDrawerOpen(false);
    setUserPoints([]);
    newSession();
  }, [newSession, result, spec, customWeights, userPoints, currentSession.id]);

  const handleExportPDF = useCallback(async () => {
    if (!result || locations.length === 0) return;
    setIsLoading(true);
    try {
      const { jsPDF } = jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const m = 15; // margin
      const cw = pw - m * 2; // content width
      let y = m;

      // ─── Helper: page header ───
      const hdr = () => {
        y = m;
        pdf.setFontSize(16); pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(29, 78, 216); pdf.text('STRATA', m, y);
        pdf.setTextColor(5, 150, 105); pdf.text('GEO', m + pdf.getTextWidth('STRATA') + 1, y);
        pdf.setFontSize(8); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(100, 116, 139);
        const tag = 'Site Suitability Report';
        pdf.text(tag, pw - m - pdf.getTextWidth(tag), y);
        y += 6; pdf.setDrawColor(226, 232, 240); pdf.line(m, y, pw - m, y); y += 6;
      };

      // ─── Helper: check page break ───
      const ensureSpace = (need: number) => {
        if (y + need > ph - 12) { pdf.addPage(); hdr(); }
      };

      // ═══════════════════════════════════════
      // PAGE 1 — Cover: title, summary, map
      // ═══════════════════════════════════════
      hdr();

      // Title
      pdf.setFontSize(14); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(30, 41, 59);
      pdf.text(`${result.business_type} — ${result.target_location}`, m, y); y += 5;

      // Timestamp + config line
      pdf.setFontSize(7.5); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(100, 116, 139);
      const configParts = [new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })];
      if (locations[0]) configParts.push(`Radius: ${(locations[0].searchRadiusM / 1000).toFixed(1)}km`);
      if (spec) configParts.push(`Confidence: ${spec.confidence}`);
      pdf.text(configParts.join('   ·   '), m, y); y += 6;

      // Summary (capped to 3 lines)
      pdf.setFontSize(9); pdf.setTextColor(55, 65, 81);
      const summaryLines = pdf.splitTextToSize(result.summary, cw).slice(0, 3);
      pdf.text(summaryLines, m, y); y += summaryLines.length * 4 + 4;

      // Constraints (if any, one-liner)
      if (spec && spec.constraints.length > 0) {
        pdf.setFontSize(7.5); pdf.setTextColor(100, 116, 139);
        const cStr = spec.constraints.map(c => `${c.direction === 'away' ? '✕' : '✓'} ${c.label}`).join('   ');
        pdf.text(pdf.splitTextToSize(cStr, cw).slice(0, 1), m, y); y += 5;
      }

      // Map screenshot (compact — max 70mm height)
      const mapEl = document.getElementById('map-container');
      if (mapEl) {
        try {
          const canvas = await html2canvas(mapEl, { useCORS: true, logging: false, scale: 2 });
          const img = canvas.toDataURL('image/jpeg', 0.85);
          const ip = pdf.getImageProperties(img);
          const imgW = cw;
          const imgH = Math.min((ip.height * imgW) / ip.width, 70);
          ensureSpace(imgH + 4);
          pdf.addImage(img, 'JPEG', m, y, imgW, imgH);
          y += imgH + 4;
        } catch { /* skip map */ }
      }

      // Score overview table (compact summary of all locations)
      ensureSpace(8 + locations.length * 5);
      pdf.setFontSize(9); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(30, 41, 59);
      pdf.text('Location Scores', m, y); y += 5;
      const ranked = [...locations].sort((a, b) => {
        if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
        return b.mcda_score - a.mcda_score;
      });
      for (const loc of ranked) {
        // Score bar
        const barH = 4;
        pdf.setFillColor(241, 245, 249); pdf.rect(m, y, cw, barH, 'F');
        const fillW = (loc.mcda_score / 10) * cw;
        if (loc.excluded) { pdf.setFillColor(200, 200, 200); }
        else if (loc.mcda_score >= 7.5) { pdf.setFillColor(22, 163, 74); }
        else if (loc.mcda_score >= 5) { pdf.setFillColor(234, 179, 8); }
        else { pdf.setFillColor(220, 38, 38); }
        pdf.rect(m, y, fillW, barH, 'F');
        // Label on bar
        pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(255, 255, 255);
        pdf.text(`${loc.name}${loc.excluded ? ' [EXCLUDED]' : ''}`, m + 1, y + 3);
        pdf.setTextColor(30, 41, 59);
        const sLbl = `${loc.mcda_score.toFixed(1)}`;
        pdf.text(sLbl, pw - m - pdf.getTextWidth(sLbl) - 1, y + 3);
        y += barH + 1.5;
      }
      y += 3;

      // ═══════════════════════════════════════
      // DETAIL PAGES — One section per location
      // ═══════════════════════════════════════
      for (let li = 0; li < ranked.length; li++) {
        const loc = ranked[li];
        // Start each location on fresh space (but don't force new page if room)
        ensureSpace(40);

        // Location header
        pdf.setDrawColor(29, 78, 216); pdf.setLineWidth(0.5);
        pdf.line(m, y, pw - m, y); y += 4;
        pdf.setFontSize(11); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(29, 78, 216);
        pdf.text(`#${li + 1}  ${loc.name}`, m, y);
        const scoreTxt = `${loc.mcda_score.toFixed(1)}/10`;
        if (loc.excluded) pdf.setTextColor(156, 163, 175);
        else if (loc.mcda_score >= 7.5) pdf.setTextColor(22, 163, 74);
        else if (loc.mcda_score >= 5) pdf.setTextColor(180, 120, 0);
        else pdf.setTextColor(220, 38, 38);
        pdf.text(scoreTxt, pw - m - pdf.getTextWidth(scoreTxt), y);
        y += 4;
        pdf.setFontSize(7); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(100, 116, 139);
        pdf.text(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}   ·   Radius: ${(loc.searchRadiusM / 1000).toFixed(1)}km`, m, y);
        y += 5;

        // Reasoning (max 2 lines)
        pdf.setFontSize(8); pdf.setTextColor(55, 65, 81);
        const rLines = pdf.splitTextToSize(loc.reasoning, cw).slice(0, 2);
        pdf.text(rLines, m, y); y += rLines.length * 3.5 + 3;

        // Criteria — compact table with inline bars
        const colName = m;
        const colBar = m + 52;
        const colScore = pw - m - 28;
        const colWeight = pw - m - 12;
        const barWidth = colScore - colBar - 2;

        // Table header
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(100, 116, 139);
        pdf.text('CRITERION', colName, y);
        pdf.text('SCORE', colBar, y);
        pdf.text('VALUE', colScore, y);
        pdf.text('WT', colWeight, y);
        y += 3;
        pdf.setDrawColor(226, 232, 240); pdf.line(m, y, pw - m, y); y += 2;

        for (const cr of loc.criteria_breakdown) {
          ensureSpace(5);
          const rowH = 3.5;
          // Name with direction arrow
          pdf.setFontSize(7); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(30, 41, 59);
          const arrow = cr.direction === 'negative' ? '▼ ' : '▲ ';
          const nameStr = `${arrow}${cr.name}`.substring(0, 28);
          pdf.text(nameStr, colName, y + 2);

          // Inline score bar
          pdf.setFillColor(241, 245, 249); pdf.rect(colBar, y, barWidth, rowH, 'F');
          const crFillW = Math.max(0.5, (cr.score / 10) * barWidth);
          if (cr.direction === 'negative') { pdf.setFillColor(249, 115, 22); }
          else if (cr.score >= 7) { pdf.setFillColor(22, 163, 74); }
          else if (cr.score >= 4) { pdf.setFillColor(59, 130, 246); }
          else { pdf.setFillColor(220, 38, 38); }
          pdf.rect(colBar, y, crFillW, rowH, 'F');
          // Score number on bar
          pdf.setFontSize(6); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(255, 255, 255);
          if (crFillW > 8) pdf.text(cr.score.toFixed(1), colBar + 1, y + 2.5);

          // Raw value + weight columns
          pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(100, 116, 139);
          pdf.text(String(cr.rawValue), colScore, y + 2);
          pdf.text(`${Math.round(cr.weight * 100)}%`, colWeight, y + 2);

          y += rowH + 1;
        }

        // Exclusion flags (compact, if any)
        const failedExcl = loc.exclusions.filter(e => !e.passed);
        if (failedExcl.length > 0) {
          y += 1;
          pdf.setFontSize(6.5); pdf.setTextColor(220, 38, 38);
          for (const ex of failedExcl) {
            ensureSpace(4);
            pdf.text(`✕ ${ex.rule}`, m, y); y += 3;
          }
        }
        y += 4;
      }

      // ═══════════════════════════════════════
      // METHODOLOGY FOOTER
      // ═══════════════════════════════════════
      ensureSpace(20);
      pdf.setDrawColor(226, 232, 240); pdf.line(m, y, pw - m, y); y += 4;
      pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(100, 116, 139);
      pdf.text('Methodology', m, y); y += 3;
      pdf.setFont('helvetica', 'normal');
      const methLines = pdf.splitTextToSize('Scored using Multi-Criteria Decision Analysis (MCDA) with continuous linear interpolation. Spatial data from OpenStreetMap (Overpass API). Criteria weights dynamically generated per business profile. Screening-level assessment — field validation recommended.', cw);
      pdf.text(methLines, m, y);

      // Page footers
      const pc = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= pc; i++) {
        pdf.setPage(i); pdf.setFontSize(6.5); pdf.setTextColor(156, 163, 175);
        pdf.text(`${i} / ${pc}`, pw - m - 8, ph - 7);
        pdf.text('stratageo.in  ·  Screening-level assessment', m, ph - 7);
      }
      pdf.save(`Stratageo-${result.business_type.replace(/\s+/g, '-')}-${result.target_location.replace(/\s+/g, '-')}.pdf`);
    } catch { setError('PDF export failed.'); }
    finally { setIsLoading(false); }
  }, [result, locations, spec]);

  // ─── Auth gate ───
  if (authLoading) {
    return (
      <div className="sg-login-screen">
        <div className="sg-login-card" style={{ textAlign: 'center', padding: '60px 40px' }}>
          <div className="sg-login-brand">
            <span className="sg-login-logo-strata">STRATA</span>
            <span className="sg-login-logo-geo">GEO</span>
          </div>
          <p style={{ color: '#64748b', marginTop: 16 }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="portal">
      <MapView
        locations={locations}
        selectedLocations={selectedRecalculated}
        onSelectLocation={handleSelectLocation}
        onDeselectAll={handleDeselectAll}
        heatmapType={heatmapType}
        userPoints={userPoints}
        showBuffers={showBuffers}
        bufferRadiusM={spec?.userPointConstraints?.[0]?.radiusM}
      />

      <TopBar
        mode={config.isDemoMode ? 'demo' : 'live'}
        hasResults={locations.length > 0}
        onExportPDF={handleExportPDF}
        onMethodology={() => setMethodologyOpen(true)}
        onNewAnalysis={handleNewAnalysis}
        sessions={sessionIndex.sessions}
        currentSessionId={currentSession.id}
        onSwitchSession={handleSwitchSession}
      />

      {/* User badge + admin controls */}
      <div className="sg-user-badge" style={{ position: 'fixed', top: 10, right: 16, zIndex: 1001 }}>
        {user.photoURL && <img src={user.photoURL} alt="" className="sg-user-avatar" />}
        <div className="sg-user-info">
          <span className="sg-user-name">{user.displayName || user.email}</span>
          <span className={`sg-user-prompts ${!user.isAdmin && user.promptsRemaining <= 1 ? 'sg-user-prompts-warn' : ''}`}>
            {user.isAdmin ? 'Unlimited' : `${user.promptsRemaining} prompts left`}
          </span>
        </div>
        {user.isAdmin && (
          <button className="sg-admin-trigger" onClick={() => setAdminOpen(true)}>
            Admin
          </button>
        )}
        <button className="sg-user-logout" onClick={logout}>Sign out</button>
      </div>

      <FloatingAssistant
        messages={messages}
        isLoading={isLoading}
        analysisStatus={analysisStatus}
        error={error}
        onRunAnalysis={handleRunAnalysis}
        onDismissError={() => setError(null)}
        hasResults={locations.length > 0}
        onToggleResults={() => setDrawerOpen(prev => !prev)}
        drawerOpen={drawerOpen}
        resultCount={resultCount}
        onResultCountChange={handleResultCountChange}
        onCSVUpload={handleCSVUpload}
        onClearCSV={handleClearCSV}
        csvPointCount={userPoints.length}
        memory={currentSession.memory}
        onNewChat={handleNewAnalysis}
        onClearMemoryField={clearMemoryField}
        sessionTitle={currentSession.title}
      />

      {result && (
        <ResultsDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          result={result}
          spec={spec}
          locations={locations}
          selectedLocations={selectedRecalculated}
          onSelectLocation={handleSelectLocation}
          customWeights={customWeights}
          onWeightChange={handleWeightChange}
          heatmapType={heatmapType}
          onHeatmapChange={setHeatmapType}
          showBuffers={showBuffers}
          onToggleBuffers={() => setShowBuffers(prev => !prev)}
          csvPointCount={userPoints.length}
        />
      )}

      <MethodologyDialog
        open={methodologyOpen}
        onClose={() => setMethodologyOpen(false)}
        onStartTour={() => setTourActive(true)}
      />

      <GuidedTour
        active={tourActive}
        onEnd={() => setTourActive(false)}
        hasResults={!!result}
      />

      <DiagnosticsPanel />

      <AdminDashboard open={adminOpen} onClose={() => setAdminOpen(false)} />
      <PromptLimitModal open={limitModalOpen} onClose={() => setLimitModalOpen(false)} />
    </div>
  );
};

export default App;
