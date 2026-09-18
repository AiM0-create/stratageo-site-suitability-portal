import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LocationData, AnalysisResult, AnalysisStatus, AnalysisSpec, HeatmapType } from './types';
import type { BasemapId } from './components/MapView';
import { sendChatTurn, clarifyBrief, startAnalysis, pollAnalysis, cancelAnalysis, AnalysisCancelledError, AnalysisFailedError } from './services/chatService';
import { isAnalysisSpecWithPoints, isConfirmationPhrase, isFollowUpQuestion } from './services/analysisFlow';
import { normalizeAnalysisResult } from './services/resultNormalizer';
import type { SpecV2, AnalysisPhase, ClarifyResponse, ClarificationAnswer } from './types/chat';
import { exportAnalysisPdf } from './services/pdfReport';
import { saveAnalysis, fetchSharedAnalysis } from './services/analysisStore';
import { useSession } from './contexts/SessionContext';
import { useAuth } from './contexts/AuthContext';
import { logPrompt } from './services/usageTracker';
import { TopBar } from './components/TopBar';
import { MapView } from './components/MapView';
import { FloatingAssistant } from './components/FloatingAssistant';
import { ResultsDrawer } from './components/ResultsDrawer';
import { LoginScreen } from './components/LoginScreen';
import { AdminDashboard } from './components/AdminDashboard';
import { PromptLimitModal } from './components/PromptLimitModal';
import SavedAnalyses from './components/SavedAnalyses';
import { ErrorBoundary } from './components/ErrorBoundary';
import { usePhoneLayout } from './services/phoneLayout';
import { SHEET_PEEK_PX, type SheetState } from './services/sheetState';

export { isAnalysisSpecWithPoints } from './services/analysisFlow';
export type { AnalysisPhase } from './types/chat';

/**
 * v2.1.0 — one flow. brief → clarify → plan → run → poll → result.
 *
 * The previous App carried a second, client-side analysis pipeline (demo
 * mode), CSV candidate upload, post-run weight sliders with a client-side
 * re-ranking, a 770-line PDF export inline, a guided tour, a methodology
 * dialog and a diagnostics panel — 2,100 lines. The conversational flow is
 * the product; everything here serves it.
 */
const App: React.FC = () => {
  const { user, loading: authLoading, logout, consumePrompt } = useAuth();
  const { state: sessionState, addMessage, updateMemory, newSession, switchSession, dispatch } = useSession();
  const { currentSession, sessionIndex } = sessionState;

  // ── result state ──
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<LocationData[]>([]);
  const [heatmapType, setHeatmapType] = useState<HeatmapType>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // v2.3.0 — phone: results are a bottom sheet that is never fully hidden
  // while a result exists. "Open" means half, "close" means peek.
  const isPhone = usePhoneLayout();
  const [sheetState, setSheetState] = useState<SheetState>('half');
  const showResults = useCallback(() => { setDrawerOpen(true); setSheetState('half'); }, []);

  // ── flow state ──
  const [isLoading, setIsLoading] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({ message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
  const [chatSpec, setChatSpec] = useState<SpecV2 | null>(null);
  const [chatSpecStatus, setChatSpecStatus] = useState<'empty' | 'draft' | 'complete'>('empty');
  const [chatReady, setChatReady] = useState(false);
  const [chatStage, setChatStage] = useState<'chat' | 'framework' | 'ready'>('chat');
  const [pendingClarification, setPendingClarification] = useState<(ClarifyResponse & { brief: string }) | null>(null);
  const [briefClarified, setBriefClarified] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');

  // ── shell state ──
  const [adminOpen, setAdminOpen] = useState(false);
  const [limitModalOpen, setLimitModalOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const [isSharedView, setIsSharedView] = useState(false);
  const [basemapId, setBasemapId] = useState<BasemapId>(() => {
    try { return (localStorage.getItem('sg-basemap') as BasemapId) || 'light'; } catch { return 'light'; }
  });
  const handleBasemapChange = useCallback((id: BasemapId) => {
    setBasemapId(id);
    try { localStorage.setItem('sg-basemap', id); } catch { /* ignore */ }
  }, []);

  // Tokens spent on planning turns, logged with the run they led to.
  const chatTokensRef = useRef(0);
  // Stale-poll guard: responses for a job that is no longer active are dropped.
  const activeJobIdRef = useRef<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  // Synchronous double-submit guard (React's disabled= applies a render late).
  const isStartingRef = useRef(false);
  const lastSpecRef = useRef<SpecV2 | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  // Restore the persisted plan when the session changes (refresh / switch)
  useEffect(() => {
    const persisted = (currentSession.chatSpec as SpecV2 | null) ?? null;
    setChatSpec(persisted);
    setChatSpecStatus(persisted ? 'draft' : 'empty');
    setChatReady(false);
    setChatStage(persisted ? 'framework' : 'chat');
    setAnalysisPhase(persisted ? 'planning' : 'idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession.id]);

  // Shared analysis links (#/share/<id>)
  useEffect(() => {
    if (!location.pathname.startsWith('/share/')) return;
    const shareId = location.pathname.replace('/share/', '');
    if (!shareId) return;
    setIsLoading(true);
    fetchSharedAnalysis(shareId).then(analysis => {
      if (!analysis) { setError('Shared analysis not found or has expired.'); return; }
      setResult(normalizeAnalysisResult(analysis.result));
      setSpec(analysis.spec);
      showResults();
      setIsSharedView(true);
    }).catch(() => setError('Failed to load shared analysis.'))
      .finally(() => setIsLoading(false));
  }, [location.pathname, showResults]);

  // Results survive a session switch: cache under the old id, restore for the new.
  const resultsCacheRef = useRef<Map<string, { result: AnalysisResult; spec: AnalysisSpec }>>(new Map());
  const prevSessionIdRef = useRef<string>(currentSession.id);
  useEffect(() => {
    if (prevSessionIdRef.current === currentSession.id) return;
    if (result && spec) resultsCacheRef.current.set(prevSessionIdRef.current, { result, spec });
    const cached = resultsCacheRef.current.get(currentSession.id);
    setResult(cached?.result ?? null);
    setSpec(cached?.spec ?? null);
    setDrawerOpen(!!cached);
    setSelectedLocations([]);
    setError(null);
    setHeatmapType(null);
    prevSessionIdRef.current = currentSession.id;
  }, [currentSession.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const messages = useMemo(
    () => currentSession.messages.map(m => ({ role: m.role, text: m.text })),
    [currentSession.messages],
  );
  const locations = result?.locations ?? [];
  const selected = useMemo(
    () => locations.filter(l => selectedLocations.some(s => s.name === l.name)),
    [locations, selectedLocations],
  );

  // ── stop whatever is in flight and unlock the input ──
  const resetExecution = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    activeJobIdRef.current = null;
    isStartingRef.current = false;
    setIsExecuting(false);
    setIsLoading(false);
    setAnalysisStatus({ message: '', progress: 0 });
    setCanRetry(false);
  }, []);
  useEffect(() => { resetExecution(); }, [user?.uid, resetExecution]);

  const clearResults = useCallback(() => {
    setResult(null);
    setSpec(null);
    setSelectedLocations([]);
    setHeatmapType(null);
    setDrawerOpen(false);
  }, []);

  // ── planning turn ──
  const handleChatTurn = useCallback(async (
    rawPrompt: string,
    opts: { clarifications?: ClarificationAnswer[]; echoUser?: boolean } = {},
  ) => {
    setError(null);
    if (opts.echoUser !== false) addMessage('user', rawPrompt, { intent: 'query' });
    setIsLoading(true);
    setAnalysisStatus({ message: 'Thinking…', progress: 30 });
    if (analysisPhase !== 'spec_ready') setAnalysisPhase('planning');
    const coldStart = setTimeout(() => {
      setAnalysisStatus({ message: 'Waking the analysis engine (cold start, ~15s)…', progress: 50 });
    }, 5000);
    try {
      const history = [
        ...currentSession.messages.map(m => ({ role: m.role, content: m.text })),
        { role: 'user' as const, content: rawPrompt },
      ];
      const resp = await sendChatTurn(history, chatSpec, {}, opts.clarifications ?? null);
      clearTimeout(coldStart);
      addMessage('assistant', resp.reply);
      if (resp.usage?.totalTokens) chatTokensRef.current += resp.usage.totalTokens;
      if (resp.spec) {
        setChatSpec(resp.spec as SpecV2);
        setChatSpecStatus(resp.specStatus);
        dispatch({ type: 'UPDATE_SPEC', spec: resp.spec });
      }
      setChatStage(resp.stage || 'chat');
      const nowReady = !!resp.spec && resp.specValid;
      setChatReady(nowReady);
      setAnalysisPhase(nowReady ? 'spec_ready' : 'planning');
      // v2.2.0 — a plan that fails validation must never sit there with no
      // Run button and no explanation (live: "at most 6 isochrone layers").
      if (resp.spec && !resp.specValid && resp.stage !== 'chat') {
        setError(`This plan can't run as it is: ${resp.specValidationError || 'the engine rejected it'}. Remove or change a factor, or say what to adjust.`);
      }
    } catch (err: any) {
      clearTimeout(coldStart);
      const parts = [err?.message || 'The assistant is unavailable. Please try again.'];
      if (err?.errorCode) parts.push(`[${err.errorCode}]`);
      if (err?.httpStatus) parts.push(`(HTTP ${err.httpStatus}${err.requestId ? `, ref ${err.requestId}` : ''})`);
      setError(parts.join(' '));
      addMessage('assistant', parts.join(' '));
      // a failed planning call never clobbers an already-valid plan
    } finally {
      setIsLoading(false);
    }
  }, [currentSession.messages, chatSpec, addMessage, dispatch, analysisPhase]);

  const handleSpecEdit = useCallback((updated: SpecV2) => {
    setChatSpec(updated);
    dispatch({ type: 'UPDATE_SPEC', spec: updated });
  }, [dispatch]);

  // ── clarification turn ──
  const handleClarifyThenChat = useCallback(async (rawPrompt: string) => {
    setError(null);
    setBriefClarified(false);
    addMessage('user', rawPrompt, { intent: 'query' });
    setIsLoading(true);
    setAnalysisStatus({ message: 'Reading your brief…', progress: 20 });
    setAnalysisPhase('planning');
    try {
      const c = await clarifyBrief(rawPrompt);
      if (c.usage?.totalTokens) chatTokensRef.current += c.usage.totalTokens;
      if (c.reply) addMessage('assistant', c.reply);
      if (!c.questions.length) {
        setIsLoading(false);
        return handleChatTurn(rawPrompt, { echoUser: false });
      }
      setPendingClarification({ ...c, brief: rawPrompt });
      setAnalysisStatus({ message: '', progress: 0 });
    } catch (err: any) {
      console.warn('[clarify] failed — proceeding without questions', err?.message);
      setIsLoading(false);
      return handleChatTurn(rawPrompt, { echoUser: false });
    } finally {
      setIsLoading(false);
    }
  }, [addMessage, handleChatTurn]);

  const handleClarificationSubmit = useCallback((answers: ClarificationAnswer[]) => {
    const pending = pendingClarification;
    if (!pending) return;
    setPendingClarification(null);
    setBriefClarified(true);
    return handleChatTurn(pending.brief, { clarifications: answers, echoUser: false });
  }, [pendingClarification, handleChatTurn]);

  // ── execution ──
  const handleConfirmExecute = useCallback(async (specOverride?: unknown) => {
    const specToUse = isAnalysisSpecWithPoints(specOverride) ? specOverride : chatSpec;
    if (!specToUse) { setError('No analysis plan is ready yet. Describe what you need first.'); return; }
    if (analysisPhase === 'executing' || isStartingRef.current) return;
    isStartingRef.current = true;
    setCanRetry(false);
    try {
      if (!(await consumePrompt())) { setLimitModalOpen(true); return; }
      const startedAt = Date.now();
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      setIsExecuting(true);
      setIsLoading(true);
      setError(null);
      setAnalysisPhase('executing');
      clearResults();
      setAnalysisStatus({ message: 'Starting analysis…', progress: 2 });
      lastSpecRef.current = specToUse;
      let jobId: string | null = null;
      try {
        jobId = await startAnalysis(specToUse as any);
        activeJobIdRef.current = jobId;
        const data = normalizeAnalysisResult(await pollAnalysis(jobId, setAnalysisStatus, controller.signal));
        if (activeJobIdRef.current !== jobId) return;           // superseded

        if (data.status === 'malformed') {
          const msg = `The analysis finished but returned an unreadable result (ref ${data.jobRef || jobId.slice(0, 8)}). Please retry.`;
          setError(msg); addMessage('assistant', msg);
          setCanRetry(true); setAnalysisPhase('failed');
          return;
        }

        setResult(data);
        setSpec(data.spec);
        showResults();
        setChatReady(false);
        setAnalysisPhase('completed');

        const top = data.locations.find(l => !l.excluded);
        if (data.status === 'no_viable_site') {
          const relax = data.relaxationSuggestions?.[0];
          addMessage('assistant', `No viable site: ${data.reason || data.summary}${relax ? ` Suggestion: ${relax}` : ''}`);
        } else {
          addMessage('assistant', top
            ? `Done. ${top.name}${top.areaHint ? ` (near ${top.areaHint})` : ''} ranks highest at ${top.mcda_score}/10 — the zones are on the map.`
            : data.summary);
        }

        if (user) {
          saveAnalysis(user.uid, user.email, lastPrompt || specToUse.objective, data, data.spec).catch(() => {});
          logPrompt({
            userId: user.uid, email: user.email,
            prompt: specToUse.objective, sector: specToUse.businessType,
            city: data.target_location || '',
            latencyMs: Date.now() - startedAt,
            resultCount: data.locations.length,
            topScore: top?.mcda_score ?? null,
            pdfExported: false, isFollowUp: false,
            tokensUsed: chatTokensRef.current,
            dataSource: 'hybrid' as any,
            analysisStatus: data.status,
            analysisRecommendation: data.analysisRecommendation,
            planningFingerprint: (data as any).planningFingerprint,
            specFingerprint: (data as any).specFingerprint,
            requestedTopN: data.outputCount?.topNResolved,
            candidates: data.locations.filter(l => !l.excluded).slice(0, 5)
              .map(l => ({ name: l.name, score: l.mcda_score ?? null, investigationLabel: l.investigationLabel })),
            skippedStages: data.analysisCompleteness?.skippedStages?.map(s => s.stage),
          });
          chatTokensRef.current = 0;
        }
        updateMemory({
          businessType: specToUse.businessType,
          city: data.target_location || null,
          sectorId: 'conversational_v2',
          constraints: (specToUse.exclusions || []).map((e: any) => e.name),
          lastResultCount: data.locations.length,
          lastSearchRadiusM: data.locations[0]?.searchRadiusM || null,
          lastAnalysisTimestamp: new Date().toISOString(),
        });
        if (currentSession.title === 'New Analysis') {
          dispatch({ type: 'SET_TITLE', title: `${specToUse.businessType} — ${data.target_location || 'study area'}` });
        }
      } catch (err: any) {
        if (err instanceof AnalysisCancelledError) return;
        const failed = err instanceof AnalysisFailedError ? err.failed : undefined;
        const msg = err?.message || 'Analysis failed. Please try again.';
        setError(msg); addMessage('assistant', msg);
        if (failed ? failed.retryable !== false : true) setCanRetry(true);
        setAnalysisPhase('failed');
      } finally {
        if (jobId === null || activeJobIdRef.current === jobId) { setIsExecuting(false); setIsLoading(false); }
      }
    } finally {
      isStartingRef.current = false;
    }
  }, [chatSpec, consumePrompt, user, lastPrompt, currentSession.title, addMessage, updateMemory, dispatch, analysisPhase, clearResults, showResults]);

  const handleRetryAnalysis = useCallback(() => {
    if (lastSpecRef.current) handleConfirmExecute(lastSpecRef.current);
  }, [handleConfirmExecute]);

  const handleCancelAnalysis = useCallback(() => {
    const jobId = activeJobIdRef.current;
    resetExecution();
    setAnalysisPhase(chatReady ? 'spec_ready' : (chatSpec ? 'planning' : 'idle'));
    addMessage('assistant', 'Analysis cancelled.');
    if (jobId) cancelAnalysis(jobId).catch(() => {});
  }, [addMessage, resetExecution, chatReady, chatSpec]);

  // ── the input: what does this message mean? ──
  const handleRunAnalysis = useCallback(async (rawPrompt: string) => {
    setLastPrompt(rawPrompt);
    if (pendingClarification) setPendingClarification(null);   // a new message abandons open questions
    if (analysisPhase === 'executing') return;                   // a running job swallows input

    const finished = analysisPhase === 'completed' || analysisPhase === 'failed';
    if ((analysisPhase === 'spec_ready' || analysisPhase === 'failed') && isConfirmationPhrase(rawPrompt)) {
      addMessage('user', rawPrompt);
      handleConfirmExecute();
      return;
    }
    if (finished && isFollowUpQuestion(rawPrompt)) return handleChatTurn(rawPrompt);   // keep the results

    const isFreshBrief = !chatSpec || finished;
    // v2.3.0 — a saved analysis loaded from "My analyses" left its pins on the
    // map under the new brief's clarification (live, 17 Sep). A fresh brief
    // starts from an empty map whatever put the last result there.
    if (isFreshBrief && result) clearResults();
    if (finished) {
      setChatSpec(null); setChatSpecStatus('empty'); setChatReady(false); setChatStage('chat');
      setCanRetry(false); setAnalysisStatus({ message: '', progress: 0 }); setError(null);
      clearResults();
      setAnalysisPhase('planning');
    }
    return isFreshBrief ? handleClarifyThenChat(rawPrompt) : handleChatTurn(rawPrompt);
  }, [pendingClarification, analysisPhase, chatSpec, result, addMessage, handleConfirmExecute, handleChatTurn, handleClarifyThenChat, clearResults]);

  // ── selection / sessions ──
  const handleSelectLocation = useCallback((loc: LocationData) => {
    if (!Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) return;
    setSelectedLocations(prev => {
      if (prev.some(l => l.name === loc.name)) return prev.filter(l => l.name !== loc.name);
      return prev.length < 3 ? [...prev, loc] : [prev[prev.length - 1], loc];
    });
    if (!drawerOpen) showResults();
  }, [drawerOpen, showResults]);

  const handleNewAnalysis = useCallback(() => {
    if (result && spec) resultsCacheRef.current.set(currentSession.id, { result, spec });
    const staleJobId = activeJobIdRef.current;
    resetExecution();
    if (staleJobId) cancelAnalysis(staleJobId).catch(() => {});
    clearResults();
    setError(null);
    setChatSpec(null); setChatSpecStatus('empty'); setChatReady(false); setChatStage('chat');
    setAnalysisPhase('idle');
    setPendingClarification(null);
    setBriefClarified(false);
    newSession();
  }, [newSession, result, spec, currentSession.id, resetExecution, clearResults]);

  const handleSwitchSession = useCallback((id: string) => {
    if (result && spec) resultsCacheRef.current.set(currentSession.id, { result, spec });
    switchSession(id);
  }, [switchSession, result, spec, currentSession.id]);

  const handleLogout = useCallback(() => {
    const staleJobId = activeJobIdRef.current;
    resetExecution();
    if (staleJobId) cancelAnalysis(staleJobId).catch(() => {});
    clearResults();
    setError(null);
    setAnalysisPhase('idle');
    logout();
  }, [logout, resetExecution, clearResults]);

  // ── take it away: PDF / share / saved ──
  const handleExportPDF = useCallback(async () => {
    if (!result || locations.length === 0) return;
    setIsLoading(true);
    try { await exportAnalysisPdf(result, locations, spec); }
    catch (e: any) { setError(e?.message || 'PDF export failed.'); }
    finally { setIsLoading(false); }
  }, [result, locations, spec]);

  const handleShareAnalysis = useCallback(async (shareId: string) => {
    const shareUrl = `${window.location.origin}${window.location.pathname}#/share/${shareId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareToast('Link copied — anyone with it can view this analysis.');
    } catch {
      setShareToast(shareUrl);
    }
    setTimeout(() => setShareToast(null), 4000);
  }, []);

  const handleLoadAnalysis = useCallback((analysis: any) => {
    setResult(normalizeAnalysisResult(analysis.result));
    setSpec(analysis.spec);
    showResults();
    setSavedOpen(false);
  }, [showResults]);

  // ── auth gate ──
  if (authLoading) {
    return (
      <div className="sg-login-screen">
        <div className="sg-login-card" style={{ textAlign: 'center', padding: '60px 40px' }}>
          <div className="sg-login-brand"><span className="sg-login-logo-strata">STRATA</span><span className="sg-login-logo-geo">GEO</span></div>
          <p style={{ color: '#64748b', marginTop: 16 }}>Loading...</p>
        </div>
      </div>
    );
  }
  if (!user) return <LoginScreen />;

  const onPanelCrash = (message: string) => () => {
    resetExecution();
    setAnalysisPhase('failed');
    setError(message);
  };

  // v2.3.0 — phone: the sheet covers the bottom of the map, so the camera
  // fits the zones into the part of the map that is actually visible.
  const phoneSheet: SheetState | null = isPhone && result ? sheetState : null;
  const mapBottomInset = phoneSheet === null ? 0
    : phoneSheet === 'peek' ? SHEET_PEEK_PX
    : Math.round(window.innerHeight * 0.5);

  return (
    <div className="portal">
      <ErrorBoundary section="map" compact onError={() => { if (isExecuting || isLoading) { resetExecution(); setAnalysisPhase('failed'); } }}>
        <MapView
          locations={locations}
          selectedLocations={selected}
          onSelectLocation={handleSelectLocation}
          onDeselectAll={() => setSelectedLocations([])}
          basemapId={basemapId}
          onBasemapChange={handleBasemapChange}
          heatmapType={heatmapType}
          hexGrid={result?.hexGrid}
          catchments={result?.catchments}
          recommendationWithheld={result?.recommendationWithheld}
          studyAreaBoundary={result?.studyAreaBoundary}
          bottomInset={mapBottomInset}
        />
      </ErrorBoundary>

      <TopBar
        hasResults={locations.length > 0}
        onExportPDF={handleExportPDF}
        sessions={sessionIndex.sessions}
        currentSessionId={currentSession.id}
        onSwitchSession={handleSwitchSession}
        user={user}
        onLogout={handleLogout}
        onAdminOpen={() => setAdminOpen(true)}
        onSavedOpen={() => setSavedOpen(true)}
        onShareAnalysis={result && spec ? () => {
          saveAnalysis(user.uid, user.email, lastPrompt, result, spec)
            .then(handleShareAnalysis)
            .catch(() => setShareToast('Failed to generate share link.'));
        } : undefined}
      />

      <ErrorBoundary section="chat assistant" onError={onPanelCrash('The chat panel hit an unexpected error and was reset. Any in-progress analysis was cancelled — please try again.')}>
        <FloatingAssistant
          messages={messages}
          isLoading={isLoading}
          analysisStatus={analysisStatus}
          error={error}
          onRunAnalysis={handleRunAnalysis}
          onDismissError={() => setError(null)}
          hasResults={locations.length > 0}
          onToggleResults={() => setDrawerOpen(v => !v)}
          drawerOpen={drawerOpen}
          onNewChat={handleNewAnalysis}
          sessionTitle={currentSession.title}
          chatSpec={chatSpec}
          chatSpecStatus={chatSpecStatus}
          clarification={pendingClarification}
          onClarificationSubmit={handleClarificationSubmit}
          briefClarified={briefClarified}
          chatReady={chatReady}
          chatStage={chatStage}
          isExecuting={isExecuting}
          onConfirmExecute={() => handleConfirmExecute()}
          onSpecEdit={handleSpecEdit}
          onCancelAnalysis={handleCancelAnalysis}
          canRetry={canRetry}
          onRetryAnalysis={handleRetryAnalysis}
          analysisPhase={analysisPhase}
          phoneSheet={phoneSheet}
        />
      </ErrorBoundary>

      {result && (
        <ErrorBoundary section="results panel" onError={() => { clearResults(); onPanelCrash('The results could not be displayed. Please run the analysis again.')(); }}>
          <ResultsDrawer
            open={isPhone || drawerOpen}
            onClose={() => (isPhone ? setSheetState('peek') : setDrawerOpen(false))}
            sheetState={isPhone ? sheetState : undefined}
            onSheetChange={isPhone ? setSheetState : undefined}
            result={result}
            spec={spec}
            locations={locations}
            selectedLocations={selected}
            onSelectLocation={handleSelectLocation}
            heatmapType={heatmapType}
            onHeatmapChange={setHeatmapType}
          />
        </ErrorBoundary>
      )}

      <AdminDashboard open={adminOpen} onClose={() => setAdminOpen(false)} />
      <PromptLimitModal open={limitModalOpen} onClose={() => setLimitModalOpen(false)} />
      <SavedAnalyses open={savedOpen} onClose={() => setSavedOpen(false)} onLoadAnalysis={handleLoadAnalysis} onShareAnalysis={handleShareAnalysis} />

      {shareToast && <div className="sg-share-toast">{shareToast}</div>}
      {isSharedView && (
        <div className="sg-share-banner">
          <span>Viewing shared analysis (read-only)</span>
          <a href={window.location.origin + window.location.pathname} onClick={(e) => { e.preventDefault(); setIsSharedView(false); navigate('/'); }}>Go to Portal</a>
        </div>
      )}
    </div>
  );
};

export default App;
