import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LocationData, AnalysisResult, AnalysisStatus, AnalysisSpec, HeatmapType, UserPoint } from './types';
import type { BasemapId } from './components/MapView';
import { config } from './config';
import { runDemoAnalysis, runServerAnalysis } from './services/analysisService';
import { sendChatTurn, startAnalysis, pollAnalysis, cancelAnalysis, AnalysisCancelledError, AnalysisFailedError } from './services/chatService';
import { isAnalysisSpecWithPoints, isConfirmationPhrase, isFollowUpQuestion } from './services/analysisFlow';
import { normalizeAnalysisResult } from './services/resultNormalizer';
import type { SpecV2, AnalysisPhase } from './types/chat';
import { getLastDiagnostics } from './services/llmIntentExtractor';
import { recalculateWithWeights, reweightHexGrid, weightsDiffer, computeGridRanks, selectTopCellsFromGrid, type ScreeningCell } from './services/mcdaEngine';
import { renderMapFigure } from './services/mapFigure';
import { parseCSV } from './services/csvParser';
import { resolveContext } from './services/contextResolver';
import { compareToBenchmark } from './services/benchmarks';
import { saveAnalysis, fetchSharedAnalysis } from './services/analysisStore';
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
import SavedAnalyses from './components/SavedAnalyses';
import { ErrorBoundary } from './components/ErrorBoundary';

declare const html2canvas: any;
declare const jspdf: any;

// v1.4.6 — the pure flow logic (spec-shape guard, confirmation phrases) and
// the AnalysisPhase type moved to importable modules so they can be
// unit-tested without pulling in this component tree. Re-exported here for
// backward compatibility with existing imports.
export { isAnalysisSpecWithPoints } from './services/analysisFlow';
export type { AnalysisPhase } from './types/chat';

const App: React.FC = () => {
  const { user, loading: authLoading, logout, consumePrompt } = useAuth();
  const { state: sessionState, addMessage, updateMemory, newSession, switchSession, clearMemoryField, dispatch } = useSession();
  const { currentSession, sessionIndex } = sessionState;

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [spec, setSpec] = useState<AnalysisSpec | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<LocationData[]>([]);
  const [customWeights, setCustomWeights] = useState<Record<string, number>>({});
  // v1.6.0 (Phase 2) — the analysis's default weights, remembered separately so
  // slider adjustments can be detected, disclosed, and reset.
  const [defaultWeights, setDefaultWeights] = useState<Record<string, number>>({});
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
  const [savedOpen, setSavedOpen] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const [isSharedView, setIsSharedView] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');

  // ─── Conversational mode (v1.0.1) ───
  const [chatSpec, setChatSpec] = useState<SpecV2 | null>(null);
  const [chatSpecStatus, setChatSpecStatus] = useState<'empty' | 'draft' | 'complete'>('empty');
  const [chatReady, setChatReady] = useState(false);
  const [chatStage, setChatStage] = useState<'chat' | 'framework' | 'ready'>('chat');
  const [isExecuting, setIsExecuting] = useState(false);
  // v1.4.2 — true after a non-cancelled analysis failure, enabling the Retry button
  const [canRetry, setCanRetry] = useState(false);
  // v1.4.4 — explicit planning/execution state machine (see AnalysisPhase above)
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle');
  useEffect(() => {
    console.debug('[phase]', analysisPhase);
  }, [analysisPhase]);
  // Accumulated gpt-4o tokens across chat turns; logged with the execution entry
  const chatTokensRef = useRef(0);
  // Phase 11 — active job guard: stale poll responses from old jobIds are discarded
  const activeJobIdRef = useRef<string | null>(null);
  // v1.4.1 — abort handle for the in-flight poll loop, so starting a new
  // analysis, cancelling, or logging out can stop a stale poller immediately
  // instead of letting it keep hitting the backend in the background.
  const pollAbortRef = useRef<AbortController | null>(null);
  // v1.4.2 — synchronous duplicate-submit guard. isLoading/isExecuting are
  // React state: they only take effect on the NEXT render, so a fast
  // double-click (or a queued chat "run" message arriving while a click is
  // still being processed) can call handleConfirmExecute twice before the
  // button's disabled={isLoading} ever applies. A plain ref is read/written
  // synchronously and closes that window completely.
  const isStartingRef = useRef(false);
  // v1.4.2 — holds the last specWithPoints submitted so Retry can reuse it
  const lastSpecWithPointsRef = useRef<any>(null);

  // Restore the persisted spec draft when the session changes (refresh / switch)
  useEffect(() => {
    const persisted = (currentSession.chatSpec as SpecV2 | null) ?? null;
    setChatSpec(persisted);
    setChatSpecStatus(persisted ? 'draft' : 'empty');
    setChatReady(false);
    setChatStage(persisted ? 'framework' : 'chat');
    setAnalysisPhase(persisted ? 'planning' : 'idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession.id]);

  // ─── Dark mode ───
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem('sg-dark') === '1'; } catch { return false; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    try { localStorage.setItem('sg-dark', darkMode ? '1' : '0'); } catch { /* ignore */ }
  }, [darkMode]);
  const handleToggleDark = useCallback(() => setDarkMode(d => !d), []);

  // ─── Basemap ───
  const [basemapId, setBasemapId] = useState<BasemapId>(() => {
    try { return (localStorage.getItem('sg-basemap') as BasemapId) || 'light'; } catch { return 'light'; }
  });
  const handleBasemapChange = useCallback((id: BasemapId) => {
    setBasemapId(id);
    try { localStorage.setItem('sg-basemap', id); } catch { /* ignore */ }
  }, []);

  const location = useLocation();
  const navigate = useNavigate();

  // ─── Handle shared analysis links ───
  useEffect(() => {
    const path = location.pathname;
    if (path.startsWith('/share/')) {
      const shareId = path.replace('/share/', '');
      if (shareId) {
        setIsLoading(true);
        fetchSharedAnalysis(shareId).then(analysis => {
          if (analysis) {
            setResult(normalizeAnalysisResult(analysis.result));
            setSpec(analysis.spec);
            setDrawerOpen(true);
            setIsSharedView(true);
            if (analysis.result.locations.length > 0) {
              const weights: Record<string, number> = {};
              analysis.result.locations[0].criteria_breakdown.forEach(c => { weights[c.name] = c.weight; });
              setCustomWeights(weights);
              setDefaultWeights(weights);
            }
          } else {
            setError('Shared analysis not found or has expired.');
          }
        }).catch(() => {
          setError('Failed to load shared analysis.');
        }).finally(() => setIsLoading(false));
      }
    }
  }, [location.pathname]);

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

  // v1.6.0 (Phase 2) — has the customer moved any slider away from defaults?
  const weightsAdjusted = useMemo(
    () => weightsDiffer(customWeights, defaultWeights),
    [customWeights, defaultWeights],
  );

  // v1.6.0 (Phase 2) — recolor the map surface live under custom weights so
  // the choropleth never contradicts the re-ranked candidate list. Pure
  // client-side arithmetic over per-cell factor scores; zero provider calls.
  const displayHexGrid = useMemo(() => {
    if (!result?.hexGrid) return result?.hexGrid;
    return weightsAdjusted ? reweightHexGrid(result.hexGrid, customWeights) : result.hexGrid;
  }, [result, customWeights, weightsAdjusted]);

  const handleWeightsReset = useCallback(() => {
    setCustomWeights(defaultWeights);
  }, [defaultWeights]);

  // v1.6.7 — every eligible cell ranked under the CURRENT weights, so the map
  // can label cells "Rank 17 of 214" and re-rank live when sliders move.
  const gridRanks = useMemo(() => computeGridRanks(displayHexGrid), [displayHexGrid]);

  // v1.6.7 — when weights are adjusted, re-SELECT the top-X zones from the
  // whole re-weighted grid (not just re-sort the original shortlist). These
  // are screening-basis picks: no isochrone/routing/Places verification has
  // run for them — the UI labels them accordingly.
  const screeningCandidates: ScreeningCell[] = useMemo(() => {
    if (!weightsAdjusted || !displayHexGrid) return [];
    const topX = (spec as any)?.output?.topN ?? Math.max(locations.length, 3);
    const rings = (spec as any)?.output?.minCandidateSeparationHexRings ?? 2;
    return selectTopCellsFromGrid(displayHexGrid, topX, rings);
  }, [weightsAdjusted, displayHexGrid, spec, locations.length]);

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

  // ─── Conversational turn (v1.0.1): chat with the methodology consultant ───
  const handleChatTurn = useCallback(async (rawPrompt: string) => {
    setError(null);
    addMessage('user', rawPrompt, { intent: 'query' });
    setIsLoading(true);
    setAnalysisStatus({ message: 'Thinking…', progress: 30 });
    // v1.4.4 — a planning turn that starts from an already-ready spec (e.g. a
    // refinement like "make the radius bigger") stays visually "spec_ready"
    // while in flight; only drop to "planning" if we weren't already ready,
    // so a slow/failed refinement call never hides a still-valid spec card.
    if (analysisPhase !== 'spec_ready') setAnalysisPhase('planning');
    // Cold start (Cloud Run scale-to-zero): explain the wait if it drags
    const coldStartTimer = setTimeout(() => {
      setAnalysisStatus({ message: 'Waking the analysis engine (cold start, ~15s)…', progress: 50 });
    }, 5000);
    try {
      const history = [
        ...currentSession.messages.map(m => ({ role: m.role, content: m.text })),
        { role: 'user' as const, content: rawPrompt },
      ];
      const resp = await sendChatTurn(history, chatSpec, {
        resultCount,
        csvPointCount: userPoints.length,
      });
      clearTimeout(coldStartTimer);
      addMessage('assistant', resp.reply);
      if (resp.usage?.totalTokens) chatTokensRef.current += resp.usage.totalTokens;
      if (resp.spec) {
        setChatSpec(resp.spec as SpecV2);
        setChatSpecStatus(resp.specStatus);
        dispatch({ type: 'UPDATE_SPEC', spec: resp.spec });
      }
      setChatStage(resp.stage || 'chat');
      const nowReady = !!resp.spec && resp.readyToExecute && resp.specValid;
      setChatReady(nowReady);
      setAnalysisPhase(nowReady ? 'spec_ready' : 'planning');
    } catch (err: any) {
      clearTimeout(coldStartTimer);
      // v1.4.5 — surface the debuggable parts (HTTP status, backend error
      // code, request ID) instead of just the human-readable message, so a
      // provider outage (rate limit/quota/auth/timeout) is distinguishable
      // in the UI from a generic server exception. See chatService.ts's
      // buildApiError() / chat.py's structured error `detail`.
      const parts = [err?.message || 'Chat failed. Please try again.'];
      if (err?.errorCode) parts.push(`[${err.errorCode}]`);
      if (err?.httpStatus) parts.push(`(HTTP ${err.httpStatus}${err.requestId ? `, ref ${err.requestId}` : ''})`);
      const msg = parts.join(' ');
      setError(msg);
      addMessage('assistant', msg);
      // v1.4.4 — do NOT touch analysisPhase here. A transient planning-call
      // failure must never clobber an already-valid spec_ready state — that
      // was exactly how "assistant unavailable" ended up masking a spec that
      // was already ready to execute (requirement 8 of the routing fix).
    } finally {
      setIsLoading(false);
    }
  }, [currentSession.messages, chatSpec, resultCount, userPoints.length, addMessage, dispatch, analysisPhase]);

  // User edited the plan directly (e.g. a layer weight in the spec card)
  const handleSpecEdit = useCallback((updated: SpecV2) => {
    setChatSpec(updated);
    dispatch({ type: 'UPDATE_SPEC', spec: updated });
  }, [dispatch]);

  // v1.4.1 — single source of truth for "stop whatever analysis is in
  // flight and unlock the UI". Used by Cancel, by starting a new analysis
  // (to abort a stale poller before starting a fresh one), and by logout.
  // Synchronous and immediate: it does NOT wait for the backend or for the
  // pollAnalysis promise to settle — the chat input must unlock the instant
  // the user asks it to, independent of network/server state.
  const resetAnalysisExecutionState = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    activeJobIdRef.current = null;
    // v1.4.2 — also release the duplicate-submit guard. Without this, a
    // Cancel/logout/New-Chat that fires while handleConfirmExecute is still
    // mid-flight (e.g. between startAnalysis() and the poll loop settling)
    // would leave isStartingRef stuck true until that original call's own
    // finally runs — a brief but real window where "Start analysis" looks
    // unlocked but a click still does nothing.
    isStartingRef.current = false;
    setIsExecuting(false);
    setIsLoading(false);
    setAnalysisStatus({ message: '', progress: 0 });
    setCanRetry(false);
  }, []);

  // v1.4.2 — defensive boot/login reset. isLoading/isExecuting/activeJobIdRef
  // are plain React state/refs that are never persisted to localStorage or
  // sessionStorage, so a true page reload already clears them naturally —
  // but this makes that guarantee EXPLICIT rather than incidental, and
  // protects against any future code path that starts persisting job state
  // without realizing it needs the same stale-recovery treatment. Runs once
  // on mount and again every time `user` transitions (covers login and the
  // logout→login round trip without relying on a full page reload).
  useEffect(() => {
    resetAnalysisExecutionState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // ─── Cancel a running analysis (user-initiated recovery) ───
  const handleCancelAnalysis = useCallback(() => {
    const jobId = activeJobIdRef.current;
    // Unlock the UI immediately — do not wait for the cancel request or for
    // the backend job to actually stop. This is what makes Cancel feel
    // instant instead of "stuck while it cancels".
    resetAnalysisExecutionState();
    // v1.4.4 — a cancelled run still has a valid, unexecuted spec: return to
    // spec_ready (Start analysis available again) rather than a dead end.
    setAnalysisPhase(chatReady ? 'spec_ready' : (chatSpec ? 'planning' : 'idle'));
    addMessage('assistant', 'Analysis cancelled.');
    if (jobId) {
      // Best-effort notify the backend so it stops at its next checkpoint
      // and frees the worker thread sooner. Never blocks the UI on this.
      cancelAnalysis(jobId).catch(() => { /* fire-and-forget */ });
    }
  }, [addMessage, resetAnalysisExecutionState, chatReady, chatSpec]);

  // v1.4.1 — logout previously called the raw auth `logout()` directly,
  // which never touched isLoading/isExecuting/activeJobIdRef/result state.
  // A job stuck mid-poll kept the chat input locked across sign-out and
  // sign-back-in, since none of that state is auth-related and React state
  // survives an in-SPA auth transition (no remount). Clear analysis state
  // first, then sign out.
  const handleLogout = useCallback(() => {
    const staleJobId = activeJobIdRef.current;
    resetAnalysisExecutionState();
    if (staleJobId) {
      cancelAnalysis(staleJobId).catch(() => { /* fire-and-forget */ });
    }
    setResult(null);
    setSelectedLocations([]);
    setHeatmapType(null);
    setError(null);
    setDrawerOpen(false);
    setAnalysisPhase('idle');
    logout();
  }, [logout, resetAnalysisExecutionState]);

  // ─── Execute the agreed spec (consumes one prompt credit) ───
  // specOverride: pass the stored spec directly for Retry without re-entering the chat flow.
  const handleConfirmExecute = useCallback(async (specOverride?: unknown) => {
    const specToUse = isAnalysisSpecWithPoints(specOverride) ? specOverride : chatSpec;
    if (!specToUse) {
      setError('No analysis plan is ready yet. Please describe what you need first.');
      return;
    }
    setCanRetry(false);
    // v1.4.2 — synchronous duplicate-submit guard, checked and set BEFORE any
    // await. React's disabled={isLoading} only applies on the next render, so
    // a fast double-click or a duplicate "run" message arriving while the
    // first click is still inside `await consumePrompt()` could otherwise
    // start two overlapping jobs. This ref closes that window completely;
    // it is released in the outer finally below no matter how the function exits.
    // v1.4.4 — also check analysisPhase directly (requirement 6): the ref
    // guard is the synchronous safety net, the phase check is the declared
    // state-machine rule that a job already executing can't be re-entered.
    if (analysisPhase === 'executing' || isStartingRef.current) return;
    isStartingRef.current = true;
    try {
    const canProceed = await consumePrompt();
    if (!canProceed) {
      setLimitModalOpen(true);
      return;
    }
    const analysisStartTime = Date.now();
    // v1.4.1 — abort any previous poller before starting a new one. Under
    // normal UI flow the input is disabled while isLoading=true so this is
    // defense-in-depth, but it matters when Cancel unlocked the input while
    // an old poll is still unwinding and the user immediately submits again.
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setIsExecuting(true);
    setIsLoading(true);
    setError(null);
    setAnalysisPhase('executing');
    console.debug('[executing spec]', specToUse);
    // Phase 11 — clear previous analysis state before starting a new job
    setResult(null);
    setSelectedLocations([]);
    setHeatmapType(null);
    setDrawerOpen(false);
    setAnalysisStatus({ message: 'Starting analysis…', progress: 2 });
    let jobId: string | null = null;
    try {
      // Phase 18: inject uploaded candidate points into the spec at execution time.
      // userPoints live in frontend state; they must be sent as spec.userCandidatePoints
      // so the engine can enforce "uploaded candidates only" mode deterministically.
      const rawIntent = (specToUse as any).rawIntent;
      const isUploadedOnly =
        rawIntent?.uploadedCandidatesOnly === true ||
        (rawIntent?.hasUploadedCandidates && userPoints.length > 0 &&
          (specToUse as any).uploadedCandidatesOnly === true);
      const specWithPoints = userPoints.length > 0 ? {
        ...specToUse,
        userCandidatePoints: userPoints.map((p, i) => ({
          lat: p.lat, lng: p.lng,
          name: p.name || `Point-${i + 1}`,
          id: `row-${i + 1}`,
          attributes: p.category ? { category: p.category } : {},
        })),
        uploadedCandidatesOnly: isUploadedOnly,
      } : specToUse;
      lastSpecWithPointsRef.current = specWithPoints;
      // v1.4.3 — visible proof the payload is a plain spec object, not a
      // MouseEvent/HTMLButtonElement that slipped past isAnalysisSpecWithPoints.
      console.debug('[analysis] spec payload', specWithPoints);
      console.debug('[creating backend analysis job]');
      jobId = await startAnalysis(specWithPoints as any);
      // Phase 11: register the active job so stale poll responses can be discarded
      activeJobIdRef.current = jobId;
      // v1.4.6 — normalize/sanitize BEFORE any field is read: a malformed or
      // partial backend result must degrade (dropped/incomplete candidates,
      // warnings banner) rather than crash the results panel.
      const analysisResultData = normalizeAnalysisResult(
        await pollAnalysis(jobId, setAnalysisStatus, controller.signal),
      );
      // Discard result if a newer job was started (or this one was cancelled/
      // reset) while this was polling.
      if (activeJobIdRef.current !== jobId) {
        return;
      }

      // v1.4.7 — three-state rendering: a payload with no recognizable state
      // or content is surfaced as "Malformed backend result" WITH the job
      // reference (never a blank panel or a silent success).
      if (analysisResultData.status === 'malformed') {
        const ref = analysisResultData.jobRef || jobId?.slice(0, 8) || 'unknown';
        const msg = `Malformed backend result (ref: ${ref}). The analysis finished but returned an unreadable payload — please retry or report this reference.`;
        setError(msg);
        addMessage('assistant', msg);
        if (lastSpecWithPointsRef.current) setCanRetry(true);
        setAnalysisPhase('failed');
        return;
      }

      setResult(analysisResultData);
      setSpec(analysisResultData.spec);
      if (analysisResultData.locations.length > 0) {
        const weights: Record<string, number> = {};
        analysisResultData.locations[0].criteria_breakdown.forEach(c => { weights[c.name] = c.weight; });
        setCustomWeights(weights);
        setDefaultWeights(weights);
      }
      setDrawerOpen(true);
      setChatReady(false);
      setAnalysisPhase('completed');

      const top = analysisResultData.locations.filter(l => !l.excluded)[0];
      // v1.4.7 — NO_VIABLE_SITE gets its own honest message (reason + first
      // relaxation suggestion) instead of the generic success summary.
      if (analysisResultData.status === 'no_viable_site') {
        const relax = analysisResultData.relaxationSuggestions?.[0];
        addMessage('assistant',
          `No viable site: ${analysisResultData.reason || analysisResultData.summary}` +
          (relax ? ` Suggestion: ${relax}` : ''));
      } else {
        addMessage('assistant', top
          ? `Analysis complete — screened ${analysisResultData.spec.parsingNotes.find(n => n.includes('hexes'))?.match(/\d+ hexes/)?.[0] || 'the study area'}. ${top.name} ranks highest at ${top.mcda_score}/10.`
          : analysisResultData.summary);
      }

      if (user) {
        saveAnalysis(user.uid, user.email, lastPrompt || specToUse.objective, analysisResultData, analysisResultData.spec).catch(() => {});
        // v1.5.3 — output snapshot for admin comparison (same prompt, did we
        // get the same result?). All fields optional/absent-safe; this is the
        // v2 conversational engine path so the fingerprints/hardConstraint
        // fields are populated whenever the backend supplied them.
        const hcv = (analysisResultData as any).hardConstraintVerification;
        logPrompt({
          userId: user.uid,
          email: user.email,
          prompt: specToUse.objective,
          sector: specToUse.businessType,
          city: analysisResultData.target_location || '',
          latencyMs: Date.now() - analysisStartTime,
          resultCount: analysisResultData.locations.length,
          topScore: top?.mcda_score ?? null,
          pdfExported: false,
          isFollowUp: false,
          tokensUsed: chatTokensRef.current,
          dataSource: 'hybrid' as any,
          analysisStatus: analysisResultData.status,
          analysisRecommendation: analysisResultData.analysisRecommendation,
          planningFingerprint: (analysisResultData as any).planningFingerprint,
          specFingerprint: (analysisResultData as any).specFingerprint,
          requestedTopN: (analysisResultData as any).outputCount?.topNResolved,
          candidates: analysisResultData.locations
            .filter(l => !l.excluded)
            .slice(0, 5)
            .map(l => ({ name: l.name, score: l.mcda_score ?? null, investigationLabel: (l as any).investigationLabel })),
          hardConstraints: hcv ? {
            verified: hcv.verifiedCount ?? 0,
            proxyVerified: hcv.proxyVerifiedCount ?? 0,
            notVerifiable: hcv.unknownCount ?? 0,
            unenforced: hcv.unenforcedCount ?? 0,
            failed: hcv.failedCount ?? 0,
          } : undefined,
          skippedStages: analysisResultData.analysisCompleteness?.skippedStages?.map(s => s.stage),
        });
        chatTokensRef.current = 0;
      }

      updateMemory({
        businessType: specToUse.businessType,
        city: analysisResultData.target_location || null,
        sectorId: 'conversational_v2',
        constraints: (specToUse.exclusions || []).map((e: any) => e.name),
        lastResultCount: analysisResultData.locations.length,
        lastSearchRadiusM: analysisResultData.locations[0]?.searchRadiusM || null,
        lastAnalysisTimestamp: new Date().toISOString(),
      });
      if (currentSession.title === 'New Analysis') {
        dispatch({ type: 'SET_TITLE', title: `${specToUse.businessType} — ${analysisResultData.target_location || 'study area'}` });
      }
    } catch (err: any) {
      // A cancellation already got its own "Analysis cancelled." message and
      // state reset from handleCancelAnalysis (or resetAnalysisExecutionState
      // via logout/new-analysis) — don't pile a second, scarier-looking
      // error message on top of a user-initiated action.
      if (err instanceof AnalysisCancelledError) {
        return;
      }
      // v1.4.4 — this is a backend job error (startAnalysis/pollAnalysis
      // failure), never the chat/planning "assistant unavailable" message —
      // those two error paths are fully separate (see handleChatTurn's catch).
      // v1.4.7 — a structured FAILED payload carries stage/errorCode/jobRef in
      // its userMessage and an explicit retryable flag; honour it.
      const failedPayload = err instanceof AnalysisFailedError ? err.failed : undefined;
      const msg = err?.message || 'Analysis failed. Please try again.';
      setError(msg);
      addMessage('assistant', msg);
      // v1.4.2 — enable Retry button so the user can re-run without re-typing.
      // v1.4.7 — unless the backend says the failure is not retryable (a code
      // defect retried verbatim will fail identically).
      const retryable = failedPayload ? failedPayload.retryable !== false : true;
      if (lastSpecWithPointsRef.current && retryable) setCanRetry(true);
      setAnalysisPhase('failed');
    } finally {
      // Only unlock state that still belongs to THIS invocation. If a newer
      // analysis (or Cancel, or logout) has since taken over activeJobIdRef,
      // leave its isLoading/isExecuting alone — don't stomp on it.
      if (jobId === null || activeJobIdRef.current === jobId) {
        setIsExecuting(false);
        setIsLoading(false);
      }
    }
    } finally {
      // Outer guard release — always runs, regardless of which inner path
      // returned/threw, so the NEXT click is never permanently blocked.
      isStartingRef.current = false;
    }
  }, [chatSpec, consumePrompt, user, lastPrompt, currentSession.title, addMessage, updateMemory, dispatch, analysisPhase]);

  // v1.4.2 — retry the last failed analysis with the same spec, no re-typing needed.
  const handleRetryAnalysis = useCallback(() => {
    if (!lastSpecWithPointsRef.current) return;
    handleConfirmExecute(lastSpecWithPointsRef.current);
  }, [handleConfirmExecute]);

  const handleRunAnalysis = useCallback(async (rawPrompt: string) => {
    // ─── Conversational mode: route to multi-turn chat, no immediate execution ───
    if (config.isConversationalMode) {
      setLastPrompt(rawPrompt);

      // v1.4.4 — requirement 6: a job already running must swallow further
      // input rather than kick off a second planning turn or execution.
      if (analysisPhase === 'executing') {
        console.debug('[phase] ignoring input while executing:', rawPrompt);
        return;
      }

      // v1.4.4 — requirement 3: once a valid spec exists, "yes"/"run"/etc.
      // must execute it directly. This is intercepted BEFORE it ever reaches
      // handleChatTurn/sendChatTurn — sending confirmation words to the LLM
      // as a fresh turn was the root cause of both symptoms in the bug
      // report: the assistant sometimes regenerated another framework, and
      // sometimes the chat call itself failed and showed "assistant
      // unavailable" for what was purely an execute request. Also allowed
      // from 'failed' — a failed execution still has a valid spec, so "yes"
      // here reasonably means "try again", the same action as Retry.
      const canInterceptFromPhase = analysisPhase === 'spec_ready' || analysisPhase === 'failed';
      if (canInterceptFromPhase && isConfirmationPhrase(rawPrompt)) {
        console.debug('[confirmation intercepted]', rawPrompt);
        addMessage('user', rawPrompt);
        handleConfirmExecute();
        return;
      }

      // v1.4.4 — requirement 7: a fresh (non-confirmation) prompt arriving
      // after a finished cycle (completed or failed) starts a clean planning
      // round instead of leaving the previous framework/cards/Retry button
      // hanging around to confuse the next confirmation.
      // v1.4.6 — extended to ALSO clear old results/errors/progress: a new
      // business prompt after completion/failure must not leave the previous
      // run's drawer, map layers, or error banner on screen. (Results are
      // still cached per-session by the session-switch cache; and a follow-up
      // that IS a confirmation phrase never reaches this branch.)
      // v1.4.7 — but a follow-up QUESTION about the existing results ("why is
      // zone 2 lower?") must NOT clear them: the user is still working with
      // the drawer/map. Only a prompt that reads as a new analysis brief
      // resets the state.
      if (
        (analysisPhase === 'completed' || analysisPhase === 'failed') &&
        isFollowUpQuestion(rawPrompt)
      ) {
        console.debug('[follow-up question — keeping existing results]', rawPrompt);
        return handleChatTurn(rawPrompt);
      }
      if (analysisPhase === 'completed' || analysisPhase === 'failed') {
        setChatSpec(null);
        setChatSpecStatus('empty');
        setChatReady(false);
        setChatStage('chat');
        setCanRetry(false);
        setAnalysisStatus({ message: '', progress: 0 });
        setResult(null);
        setSpec(null);
        setSelectedLocations([]);
        setHeatmapType(null);
        setDrawerOpen(false);
        setError(null);
        setAnalysisPhase('planning');
      }

      return handleChatTurn(rawPrompt);
    }

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

    // Resolve context for follow-ups / reset detection
    const resolved = resolveContext(rawPrompt, currentSession.memory, currentSession.messages);

    // Explicit reset: wipe working memory so subsequent prompts start fresh
    if (resolved.resetDetected) {
      updateMemory({
        businessType: null,
        city: null,
        coordinates: null,
        sectorId: null,
        constraints: [],
        lastResultCount: 0,
        lastSearchRadiusM: null,
        lastAnalysisTimestamp: null,
        customContext: {},
      });
      addMessage('assistant', 'Starting fresh — prior analysis context has been cleared.');
    }

    setLastPrompt(rawPrompt);
    addMessage('user', rawPrompt, { intent: resolved.isFollowUp ? 'followup' : 'query' });

    if (resolved.isFollowUp) {
      addMessage('assistant', `Continuing from previous analysis. ${resolved.contextSummary}`);
    }

    try {
      const promptToSend = resolved.effectivePrompt;

      // Build session context for follow-ups in live mode.
      // The backend passes this to GPT as a system message so it can interpret
      // "one of those locations" / "recalculate with stronger penalty" etc.
      let sessionContext: string | undefined;
      if (resolved.isFollowUp && !config.isDemoMode) {
        const mem = currentSession.memory;
        const parts: string[] = [];
        if (mem.businessType) parts.push(`Business type: ${mem.businessType}`);
        if (mem.city) parts.push(`City/location: ${mem.city}`);
        if (mem.constraints.length > 0) parts.push(`Excluded areas / constraints: ${mem.constraints.join(', ')}`);
        if (mem.lastSearchRadiusM) parts.push(`Search radius: ${(mem.lastSearchRadiusM / 1000).toFixed(1)}km`);
        // Include top-ranked locations from current results so GPT knows which places were suggested
        if (result && result.locations.length > 0) {
          const topLocs = result.locations
            .filter(l => !l.excluded)
            .slice(0, 5)
            .map(l => `${l.name} (${l.mcda_score}/10)`)
            .join(', ');
          if (topLocs) parts.push(`Previously ranked locations: ${topLocs}`);
          const excluded = result.locations.filter(l => l.excluded).map(l => l.name).join(', ');
          if (excluded) parts.push(`Locations excluded by constraints: ${excluded}`);
        }
        if (parts.length > 0) sessionContext = parts.join('. ') + '.';
      }

      const analysisResult = config.isDemoMode
        ? await runDemoAnalysis(rawPrompt, setAnalysisStatus)
        : await runServerAnalysis(promptToSend, resultCount, setAnalysisStatus, sessionContext);
      // v1.4.6 — same crash-safety boundary as the conversational path
      (analysisResult as any).result = normalizeAnalysisResult(analysisResult.result);

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
        setDefaultWeights(weights);
      }

      setDrawerOpen(true);

      const top = analysisResult.result.locations.filter(l => !l.excluded)[0];
      const excludedCount = analysisResult.result.locations.filter(l => l.excluded).length;

      // Add benchmark comparison
      let benchmarkNote = '';
      if (top && parsedSpec.sectorId) {
        const bench = compareToBenchmark(top.mcda_score, parsedSpec.sectorId, parsedSpec.geography.city);
        if (bench) benchmarkNote = ` (${bench.ratingLabel})`;
      }

      addMessage('assistant', top
        ? `Screened ${analysisResult.result.locations.length} areas in ${analysisResult.result.target_location}. ${top.name} ranks highest at ${top.mcda_score}/10${benchmarkNote}.${excludedCount > 0 ? ` ${excludedCount} excluded by constraints.` : ''}`
        : analysisResult.result.summary,
      );

      // Save analysis to Firestore
      if (user) {
        saveAnalysis(user.uid, user.email, rawPrompt, analysisResult.result, analysisResult.spec).catch(() => {});
      }

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
        const diag = getLastDiagnostics();
        const tokensUsed = diag?.tokenUsage?.totalTokens || 0;
        // Determine data source from grounding_sources
        const sources = analysisResult.result.grounding_sources.map(s => s.title.toLowerCase());
        const hasPlaces = sources.some(s => s.includes('google places'));
        const hasOSM = sources.some(s => s.includes('openstreetmap') || s.includes('overpass'));
        const dataSource = hasPlaces && hasOSM ? 'hybrid' : hasPlaces ? 'google-places' : config.isDemoMode ? 'demo' : 'osm';
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
          tokensUsed,
          dataSource: dataSource as any,
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
  }, [resultCount, userPoints, currentSession.memory, currentSession.messages, currentSession.title, addMessage, updateMemory, dispatch, consumePrompt, user, handleChatTurn, analysisPhase, handleConfirmExecute]);

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
    // v1.4.1 — this is also the user-facing recovery path for a stuck/running
    // analysis: previously this left isLoading/isExecuting/activeJobIdRef
    // untouched, so starting a "New Chat" while a job was stuck at 60-64%
    // cleared the conversation but kept the chat input disabled. Notify the
    // backend (best-effort) and unlock immediately either way.
    const staleJobId = activeJobIdRef.current;
    resetAnalysisExecutionState();
    if (staleJobId) {
      cancelAnalysis(staleJobId).catch(() => { /* fire-and-forget */ });
    }
    setResult(null);
    setSpec(null);
    setSelectedLocations([]);
    setCustomWeights({});
    setError(null);
    setHeatmapType(null);
    setDrawerOpen(false);
    setUserPoints([]);
    setChatSpec(null);
    setChatSpecStatus('empty');
    setChatReady(false);
    setChatStage('chat');
    setAnalysisPhase('idle');
    newSession();
  }, [newSession, result, spec, customWeights, userPoints, currentSession.id, resetAnalysisExecutionState]);

  const handleExportPDF = useCallback(async () => {
    if (!result || locations.length === 0) return;
    setIsLoading(true);
    try {
      const { jsPDF } = jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pw  = pdf.internal.pageSize.getWidth();  // 210
      const ph  = pdf.internal.pageSize.getHeight(); // 297
      const ml  = 14; const mr = 14;
      const cw  = pw - ml - mr;                      // 182 mm usable
      let y = 0;

      // ─── ASCII-safe direction labels (no Unicode arrows) ─────────────────────
      const dirTag = (dir: string) => dir === 'negative' ? '[-]' : '[+]';

      // v1.6.8 — jsPDF's built-in Helvetica is Latin-1 only. Any string that
      // reaches pdf.text() with characters outside it (em-dashes, arrows,
      // superscripts — all common in backend note text) rendered as garbage
      // with exploded letter-spacing (observed live on the evidence appendix
      // page). Every string is now routed through this sanitizer via a
      // pdf.text wrapper below.
      const asciiSafe = (t: string): string => String(t)
        .replace(/[—–]/g, '-')      // em/en dash
        .replace(/[‘’ʼ]/g, "'") // curly apostrophes
        .replace(/[“”]/g, '"')      // curly quotes
        .replace(/→/g, '->')              // right arrow
        .replace(/←/g, '<-')
        .replace(/▲/g, '[+]').replace(/▼/g, '[-]')
        .replace(/²/g, '2').replace(/³/g, '3')
        .replace(/[×✕]/g, 'x')
        .replace(/≈/g, '~').replace(/≥/g, '>=').replace(/≤/g, '<=')
        .replace(/[•·]/g, '-')       // bullets
        .replace(/…/g, '...')
        .replace(/[✓✔]/g, 'OK')
        .replace(/[^\x00-\xFF]/g, '');         // anything else non-Latin-1: drop
      const _origPdfText = pdf.text.bind(pdf);
      (pdf as any).text = (txt: any, ...rest: any[]) => _origPdfText(
        typeof txt === 'string' ? asciiSafe(txt)
          : Array.isArray(txt) ? txt.map(v => typeof v === 'string' ? asciiSafe(v) : v)
          : txt,
        ...rest,
      );
      // Plain-English labels for internal enum values that were leaking into
      // the report verbatim (micro_market_zone, recommended_sites, ...).
      const humanize = (s?: string | null) =>
        (s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

      // ─── Colours ──────────────────────────────────────────────────────────────
      const C = {
        navy:   [29,  78, 216] as [number,number,number],
        teal:   [5,  150, 105] as [number,number,number],
        green:  [22, 163,  74] as [number,number,number],
        amber:  [217,119,   6] as [number,number,number],
        red:    [220,  38,  38] as [number,number,number],
        s9:     [15,  23,  42] as [number,number,number],
        s7:     [51,  65,  85] as [number,number,number],
        s5:     [100,116, 139] as [number,number,number],
        s2:     [226,232, 240] as [number,number,number],
        s1:     [248,250, 252] as [number,number,number],
        white:  [255,255, 255] as [number,number,number],
        orange: [249,115,  22] as [number,number,number],
        blue:   [59, 130, 246] as [number,number,number],
      };
      const F = (c:[number,number,number]) => pdf.setFillColor(c[0],c[1],c[2]);
      const T = (c:[number,number,number]) => pdf.setTextColor(c[0],c[1],c[2]);
      const D = (c:[number,number,number]) => pdf.setDrawColor(c[0],c[1],c[2]);

      const scoreCol = (s: number, excl=false): [number,number,number] =>
        excl ? C.s5 : s >= 7.5 ? C.green : s >= 5 ? C.amber : C.red;

      // ─── Helpers ──────────────────────────────────────────────────────────────
      const gap  = (n=4) => { y += n; };
      const need = (n: number) => { if (y + n > ph - 14) { pdf.addPage(); pageHeader(); } };
      const hline = (lw=0.25, col=C.s2) => {
        D(col); pdf.setLineWidth(lw); pdf.line(ml, y, pw-mr, y);
      };
      const sectionHead = (txt: string) => {
        pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.s5);
        pdf.text(txt.toUpperCase(), ml, y); y += 4.5;
      };
      // Card background — fills from current y, height h, optional accent bar
      const cardBg = (h: number, col=C.s1, accentCol?: [number,number,number]) => {
        F(col); pdf.rect(ml, y, cw, h, 'F');
        if (accentCol) { F(accentCol); pdf.rect(ml, y, 2, h, 'F'); }
      };

      // ─── Page header ─────────────────────────────────────────────────────────
      const pageHeader = () => {
        F(C.navy); pdf.rect(0, 0, pw, 11, 'F');
        pdf.setFontSize(13); pdf.setFont('helvetica','bold');
        T(C.white); pdf.text('STRATA', ml, 7.5);
        T(C.teal);  pdf.text('GEO', ml + pdf.getTextWidth('STRATA') + 1, 7.5);
        pdf.setFontSize(7); pdf.setFont('helvetica','normal');
        T([180,200,230] as [number,number,number]);
        const rtag = 'Site Suitability Report   stratageo.in';
        pdf.text(rtag, pw - mr - pdf.getTextWidth(rtag), 7.5);
        y = 17;
      };

      // ─── Page footers (called once at the very end) ───────────────────────────
      const allFooters = () => {
        const n = pdf.internal.getNumberOfPages();
        for (let i = 1; i <= n; i++) {
          pdf.setPage(i);
          D(C.s2); pdf.setLineWidth(0.3);
          pdf.line(ml, ph-10, pw-mr, ph-10);
          pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
          pdf.text('Screening-level assessment  Field validation recommended  Stratageo', ml, ph-6);
          const pg = `${i} / ${n}`;
          pdf.text(pg, pw - mr - pdf.getTextWidth(pg), ph-6);
        }
      };

      // ─── Horizontal score bar ─────────────────────────────────────────────────
      const bar = (score: number, bx: number, bw: number, by: number, bh: number, col: [number,number,number]) => {
        F(C.s2); pdf.rect(bx, by, bw, bh, 'F');
        F(col);  pdf.rect(bx, by, Math.max(0.8, (score/10)*bw), bh, 'F');
      };

      // ══════════════════════════════════════════════════════════════════════════
      // PAGE 1 — SUMMARY
      // ══════════════════════════════════════════════════════════════════════════
      pageHeader();

      // ── Title block ────────────────────────────────────────────────────────────
      const ranked = [...locations].sort((a,b) =>
        a.excluded !== b.excluded ? (a.excluded ? 1 : -1) : b.mcda_score - a.mcda_score);
      const topLoc = ranked[0];

      cardBg(22, C.s1, C.navy);
      pdf.setFontSize(16); pdf.setFont('helvetica','bold'); T(C.s9);
      // truncate long names to prevent overflow
      const bizTitle = result.business_type.length > 38
        ? result.business_type.slice(0,36)+'...' : result.business_type;
      pdf.text(bizTitle, ml + 5, y + 9);
      pdf.setFontSize(10); pdf.setFont('helvetica','normal'); T(C.navy);
      pdf.text(result.target_location, ml + 5, y + 16);
      // Score badge top-right
      if (topLoc) {
        const sc = topLoc.mcda_score;
        const col = scoreCol(sc, topLoc.excluded);
        F(col); pdf.roundedRect(pw-mr-22, y+4, 20, 12, 2, 2, 'F');
        pdf.setFontSize(17); pdf.setFont('helvetica','bold'); T(C.white);
        const sLbl = sc.toFixed(1);
        pdf.text(sLbl, pw-mr-12 - pdf.getTextWidth(sLbl)/2, y+13);
        pdf.setFontSize(6.5); pdf.setFont('helvetica','normal');
        pdf.text('/ 10', pw-mr-12 - pdf.getTextWidth('/ 10')/2, y+17.5);
      }
      y += 26;

      // ── Meta ──
      pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s5);
      const metaDate = new Date().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
      const metaRadius = locations[0] ? `${(locations[0].searchRadiusM/1000).toFixed(1)}km radius` : '';
      const metaConf   = spec ? `Confidence: ${spec.confidence}` : '';
      const metaConstr = spec && spec.constraints.length > 0 ? `${spec.constraints.length} constraint(s)` : '';
      pdf.text([metaDate, metaRadius, metaConf, metaConstr].filter(Boolean).join('   |   '), ml, y);
      y += 5;
      // v1.1.0 — version + model/cost metadata disclosure line
      const appVer = `App v${__APP_VERSION__}  Engine v${__APP_VERSION__}`;
      const recMode = (result as any).recommendationMode ? `Mode: ${humanize((result as any).recommendationMode)}` : '';
      const siteClm = `Claim level: ${humanize((result as any).siteClaimLevel || 'micro_market_zone')}`;
      pdf.setFontSize(6.5); T(C.s5);
      pdf.text([appVer, recMode, siteClm, 'Preliminary screening — not legal/parcel/field due diligence'].filter(Boolean).join('   |   '), ml, y);
      y += 5;

      // ── Constraint tags (ASCII safe) ──
      if (spec && spec.constraints.length > 0) {
        let cx = ml;
        spec.constraints.forEach(c => {
          const away = c.direction === 'away';
          const lbl = `${away ? 'EXCL:' : 'INCL:'} ${c.label}`;
          const tw = pdf.getTextWidth(lbl) + 6;
          if (cx + tw > pw - mr - 5) { y += 6; cx = ml; }
          F(away ? [254,226,226] as [number,number,number] : [220,252,231] as [number,number,number]);
          pdf.roundedRect(cx, y, tw, 5, 1, 1, 'F');
          pdf.setFontSize(6.5); pdf.setFont('helvetica','bold');
          T(away ? C.red : C.green);
          pdf.text(lbl, cx + 3, y + 3.5);
          cx += tw + 3;
        });
        y += 8;
      }

      gap(2); hline(); gap(4);

      // ── Executive summary ──
      sectionHead('Executive Summary');
      // Use cw-10 to account for card indent and right margin — prevents cutoff
      const sumLines = pdf.splitTextToSize(asciiSafe(result.summary), cw - 10);
      const maxSumLines = Math.min(sumLines.length, 8);
      const sumH = maxSumLines * 4.5 + 6;
      cardBg(sumH, C.s1, C.navy);
      pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
      pdf.text(sumLines.slice(0, maxSumLines), ml + 5, y + 5);
      y += sumH + 5;

      // ── Key analysis notes (v1.6.8) — the audit log's most decision-relevant
      // lines (study-area extent, radius overrides, candidate shortfalls,
      // scoring-basis disclosures) belong on page 1, not buried in an appendix.
      const allNotes: string[] = ((spec as any)?.parsingNotes ?? []).filter((n: any) => typeof n === 'string');
      if (allNotes.length > 0) {
        const keyNotes = allNotes.slice(0, 4).map(n => {
          const lines = pdf.splitTextToSize(`- ${asciiSafe(n)}`, cw - 10);
          return lines.slice(0, 2); // max 2 lines per note
        });
        const noteLineCount = keyNotes.reduce((s, l) => s + l.length, 0);
        const notesH = noteLineCount * 4 + 8;
        need(notesH + 8);
        sectionHead(`Key Analysis Notes${allNotes.length > 4 ? ` (first 4 of ${allNotes.length} - full trail in the portal)` : ''}`);
        cardBg(notesH, C.s1, C.s5);
        pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
        let ny = y + 5;
        keyNotes.forEach(lines => { pdf.text(lines, ml + 5, ny); ny += lines.length * 4; });
        y += notesH + 5;
      }

      // ── Ranked locations table ──
      sectionHead('Ranked Locations Overview');
      // Header row
      F(C.navy); pdf.rect(ml, y, cw, 7, 'F');
      pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
      pdf.text('LOCATION', ml + 8, y + 4.8);
      pdf.text('SCORE', ml + 68, y + 4.8);
      pdf.text('SUITABILITY INDEX', ml + 85, y + 4.8);
      pdf.text('STATUS', pw - mr - 14, y + 4.8);
      y += 7;

      ranked.forEach((loc, idx) => {
        need(11);
        const rh = 10;
        F(idx % 2 === 0 ? C.white : C.s1);
        pdf.rect(ml, y, cw, rh, 'F');

        // Rank accent bar
        const rc = scoreCol(loc.mcda_score, loc.excluded);
        F(rc); pdf.rect(ml, y, 5, rh, 'F');
        pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
        const rankStr = `${idx+1}`;
        pdf.text(rankStr, ml + 2.5 - pdf.getTextWidth(rankStr)/2, y + 6.5);

        // Name + coords
        pdf.setFontSize(8.5); pdf.setFont('helvetica', loc.excluded ? 'italic' : 'bold');
        T(loc.excluded ? C.s5 : C.s9);
        pdf.text(loc.name + (loc.excluded ? ' [excl]' : ''), ml + 7, y + 4.5);
        pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`, ml + 7, y + 8.2);

        // Score
        pdf.setFontSize(10); pdf.setFont('helvetica','bold'); T(rc);
        pdf.text(loc.mcda_score.toFixed(1), ml + 68, y + 5.5);
        pdf.setFontSize(7); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text('/10', ml + 68 + pdf.getTextWidth(loc.mcda_score.toFixed(1)) + 0.5, y + 5.5);

        // Suitability bar  (starts at 85mm, ends 20mm before right margin)
        const bx = ml + 85; const bw = cw - 85 - 20;
        bar(loc.mcda_score, bx, bw, y + 3.5, 3, rc);

        // Status badge
        const status = loc.excluded ? 'EXCLUDED'
          : loc.mcda_score >= 7.5 ? 'STRONG'
          : loc.mcda_score >= 5   ? 'VIABLE' : 'WEAK';
        F(rc); pdf.roundedRect(pw-mr-17, y+2.5, 15, 5, 1, 1, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.white);
        pdf.text(status, pw-mr-9.5 - pdf.getTextWidth(status)/2, y+5.8);

        D(C.s2); pdf.setLineWidth(0.2); pdf.line(ml, y+rh, pw-mr, y+rh);
        y += rh;
      });
      gap(5);

      // ── Criteria overview table (before the map: keeps page 1 dense and the
      // near-full-page map figure on its own page — kills the dead-space pages
      // observed in the live Pune report) ──
      if (ranked[0]?.criteria_breakdown.length > 0) {
        need(6 + ranked[0].criteria_breakdown.length * 6.5 + 10);
        hline(); gap(4);
        sectionHead('Scoring Criteria Applied');

        F(C.s1); pdf.rect(ml, y, cw, 6.5, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.s5);
        pdf.text('CRITERION', ml + 22, y + 4.5);
        pdf.text('DIRECTION', ml + 100, y + 4.5);
        pdf.text('WEIGHT', ml + 148, y + 4.5);
        y += 6.5;

        ranked[0].criteria_breakdown.forEach((cr, idx) => {
          const rh = 6.5;
          F(idx % 2 === 0 ? C.white : C.s1); pdf.rect(ml, y, cw, rh, 'F');
          // Direction pill
          const dcol = cr.direction === 'negative' ? C.orange : C.teal;
          F(dcol); pdf.roundedRect(ml + 2, y + 1, 14, 4.5, 1, 1, 'F');
          pdf.setFontSize(7); pdf.setFont('helvetica','bold'); T(C.white);
          pdf.text(dirTag(cr.direction), ml + 9 - pdf.getTextWidth(dirTag(cr.direction))/2, y + 4.2);
          // Name
          pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
          pdf.text(cr.name.substring(0, 42), ml + 18, y + 4.5);
          // Type text
          pdf.setFontSize(6.5); T(dcol);
          pdf.text(cr.direction === 'negative' ? 'Less is better' : 'More is better', ml + 100, y + 4.5);
          // Weight
          T(C.s5);
          pdf.text(`${Math.round(cr.weight * 100)}%`, ml + 148, y + 4.5);
          y += rh;
        });
        gap(5);
      }

      // ── v1.6.8: Study area map — the core visual deliverable ──
      // Self-rendered figure over real Carto basemap tiles (same CORS-enabled
      // source as the on-screen map, attributed in the figure itself), with
      // north arrow, in-frame scale bar, and labeled legend. Falls back to the
      // clean tile-less rendering if the basemap can't be fetched at export
      // time — the report itself can never break on a tile.
      try {
        const fig = await renderMapFigure({
          hexGrid: (result as any).hexGrid ?? [],
          locations: ranked,
          studyAreaBoundary: (result as any).studyAreaBoundary,
          withheld: (result as any).recommendationWithheld === true,
          weightsAdjusted,
        });
        if (fig) {
          const imgW = cw;
          const imgH = imgW / fig.aspect;
          need(imgH + 16);
          hline(); gap(4);
          sectionHead('Study Area Map — Suitability Surface & Ranked Zones');
          pdf.addImage(fig.dataUrl, 'PNG', ml, y, imgW, imgH);
          y += imgH + 3;
          pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
          pdf.text('Zones are H3 micro-market cells (screening level), not parcels. Exact coordinates for each ranked zone are listed in the detail pages.', ml, y);
          y += 5;
          gap(3);
        }
      } catch { /* the map figure must never break the report */ }

      // ══════════════════════════════════════════════════════════════════════════
      // LOCATION DETAIL PAGES — one per ranked location, flowing (no forced page)
      // ══════════════════════════════════════════════════════════════════════════
      for (let li = 0; li < ranked.length; li++) {
        const loc = ranked[li];
        // Always start each location on a fresh page for cleanliness
        pdf.addPage(); pageHeader();

        const ac = scoreCol(loc.mcda_score, loc.excluded);

        // ── Location title card ─────────────────────────────────────────────────
        cardBg(22, C.s1, ac);
        // Rank square
        F(ac); pdf.rect(ml + 3, y + 3, 9, 9, 'F');
        pdf.setFontSize(10); pdf.setFont('helvetica','bold'); T(C.white);
        pdf.text(`${li+1}`, ml + 7.5 - pdf.getTextWidth(`${li+1}`)/2, y + 9.8);
        // Name
        pdf.setFontSize(15); pdf.setFont('helvetica','bold');
        T(loc.excluded ? C.s5 : C.s9);
        const locName = (loc.name + (loc.excluded ? '  [EXCLUDED]' : '')).substring(0, 35);
        pdf.text(locName, ml + 15, y + 9);
        // Coords
        pdf.setFontSize(7); pdf.setFont('helvetica','normal'); T(C.s5);
        pdf.text(`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}   |   Search radius: ${(loc.searchRadiusM/1000).toFixed(1)} km`, ml + 15, y + 15.5);
        // v1.6.7 — one-tap navigation for the field-validation visit
        pdf.setTextColor(29, 78, 216);
        pdf.textWithLink('Open in Google Maps', ml + 15 + 62, y + 15.5, { url: `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` });
        // Score pill
        F(ac); pdf.roundedRect(pw-mr-24, y+4, 22, 14, 2, 2, 'F');
        pdf.setFontSize(18); pdf.setFont('helvetica','bold'); T(C.white);
        const sStr = loc.mcda_score.toFixed(1);
        pdf.text(sStr, pw-mr-13 - pdf.getTextWidth(sStr)/2, y+14);
        pdf.setFontSize(7); T([255,255,255] as [number,number,number]);
        pdf.text('/ 10', pw-mr-13 - pdf.getTextWidth('/ 10')/2, y+18.5);
        y += 26;

        // ── Exclusion notice ──
        const failedExcl = loc.exclusions.filter(e => !e.passed);
        if (failedExcl.length > 0) {
          const exH = failedExcl.length * 8 + 4;
          F([254,226,226] as [number,number,number]); pdf.rect(ml, y, cw, exH, 'F');
          F(C.red); pdf.rect(ml, y, 2, exH, 'F');
          failedExcl.forEach((ex, ei) => {
            pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.red);
            const exLines = pdf.splitTextToSize(`Exclusion: ${ex.rule}`, cw - 8);
            pdf.text(exLines.slice(0,2), ml + 5, y + 5.5 + ei * 8);
          });
          y += exH + 4;
        }

        // ── GIS Analyst Assessment ──
        // v1.6.8 — SKIPPED when there is no assessment text: the live Pune
        // report printed an empty orange-bar section, which reads as a bug
        // in a client deliverable. Absent narrative = absent section.
        if ((loc.reasoning || '').trim()) {
          sectionHead('GIS Analyst Assessment');
          // split to cw-10 to avoid right-edge cutoff
          const rLines = pdf.splitTextToSize(asciiSafe(loc.reasoning), cw - 10);
          const rCount = Math.min(rLines.length, 10);
          const rH = rCount * 4.5 + 6;
          cardBg(rH, C.s1, ac);
          pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
          pdf.text(rLines.slice(0, rCount), ml + 5, y + 5);
          y += rH + 5;
        }

        // ── Criteria breakdown ──
        sectionHead('Scoring Criteria Breakdown');

        // Column X positions (all relative to left edge, absolute mm)
        // cw = 182mm. Columns:
        //  direction tag  : ml+2        (5mm wide)
        //  criterion name : ml+9        (55mm wide, ends at ml+64)
        //  justification  : ml+9 (row2)
        //  score bar      : ml+66       (38mm wide, ends at ml+104)
        //  score text     : ml+106      (14mm wide, ends at ml+120)
        //  raw evidence   : ml+122      (38mm wide, ends at ml+160)
        //  weight         : ml+162      (to right edge ml+182)
        const cDirX  = ml + 2;
        const cNameX = ml + 9;
        const cBarX  = ml + 66;
        const cBarW  = 38;
        const cScoreX= ml + 106;
        const cRawX  = ml + 122;
        const cWtX   = ml + 162;

        // Table header
        F(C.s9); pdf.rect(ml, y, cw, 7, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica','bold'); T(C.white);
        pdf.text('DIR', cDirX, y + 4.8);
        pdf.text('CRITERION & EVIDENCE', cNameX, y + 4.8);
        pdf.text('SCORE INDEX', cBarX, y + 4.8);
        pdf.text('SCORE', cScoreX, y + 4.8);
        pdf.text('RAW OBSERVED', cRawX, y + 4.8);
        pdf.text('WEIGHT', cWtX, y + 4.8);
        y += 7;

        loc.criteria_breakdown.forEach((cr, idx) => {
          need(11);
          const rh = 11;
          F(idx % 2 === 0 ? C.white : C.s1); pdf.rect(ml, y, cw, rh, 'F');

          // Direction pill — ASCII only, no Unicode
          const dcol = cr.direction === 'negative' ? C.orange : C.teal;
          F(dcol); pdf.roundedRect(cDirX, y + 1.5, 5, 4, 0.5, 0.5, 'F');
          pdf.setFontSize(5.5); pdf.setFont('helvetica','bold'); T(C.white);
          const dtag = cr.direction === 'negative' ? '-' : '+';
          pdf.text(dtag, cDirX + 2.5 - pdf.getTextWidth(dtag)/2, y + 4.8);

          // Criterion name (line 1)
          pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(C.s9);
          pdf.text(cr.name.substring(0, 36), cNameX, y + 4.5);
          // Justification (line 2) — split to available width
          pdf.setFontSize(6); pdf.setFont('helvetica','italic'); T(C.s5);
          const jLines = pdf.splitTextToSize(cr.justification || '', cBarX - cNameX - 2);
          pdf.text(jLines.slice(0,1), cNameX, y + 8.5);

          // Score bar (null score = insufficient data → no bar, "N/A")
          if (cr.score == null) {
            pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(C.red);
            pdf.text('N/A', cScoreX, y + 5.5);
            pdf.setFontSize(6); pdf.setFont('helvetica','normal'); T(C.s5);
            pdf.text('no data', cScoreX, y + 9);
          } else {
            const s = cr.score;
            const crCol = cr.direction === 'negative'
              ? (s <= 3 ? C.red : s <= 6 ? C.orange : C.green)
              : (s >= 7 ? C.green : s >= 4 ? C.blue : C.red);
            bar(s, cBarX, cBarW, y + 4, 3, crCol);

            // Score number — in its own column, no overlap with bar or evidence
            pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(crCol);
            pdf.text(`${s.toFixed(1)}`, cScoreX, y + 5.5);
            pdf.setFontSize(6.5); T(C.s5);
            pdf.text('/10', cScoreX, y + 9);
          }

          // Raw evidence — starts well after score column
          pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(C.s9);
          pdf.text(`${cr.rawValue ?? 0}`, cRawX, y + 5.5);
          pdf.setFontSize(6.5); pdf.setFont('helvetica','normal'); T(C.s5);
          pdf.text('features observed', cRawX, y + 9);

          // Weight badge
          F(C.s2); pdf.roundedRect(cWtX, y + 2, 14, 5.5, 1, 1, 'F');
          pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.s7);
          const wl = `${Math.round(cr.weight * 100)}%`;
          pdf.text(wl, cWtX + 7 - pdf.getTextWidth(wl)/2, y + 6);

          D(C.s2); pdf.setLineWidth(0.2); pdf.line(ml, y+rh, pw-mr, y+rh);
          y += rh;
        });
        gap(4);

        // ── Signal counts summary bar ──
        const sigs = Object.entries(loc.osmSignals || {}).slice(0,5);
        if (sigs.length > 0) {
          need(18);
          sectionHead('Spatial Evidence — Raw OSM Signal Counts');
          const scW = Math.min(cw / sigs.length, 44);
          sigs.forEach(([key, val], si) => {
            const sx = ml + si * scW;
            F(C.s1); pdf.rect(sx, y, scW - 1, 14, 'F');
            F(C.navy); pdf.rect(sx, y, 2, 14, 'F');
            pdf.setFontSize(14); pdf.setFont('helvetica','bold'); T(C.navy);
            pdf.text(String(val), sx + 5, y + 9);
            pdf.setFontSize(6); pdf.setFont('helvetica','normal'); T(C.s5);
            // Wrap label if too long
            const kl = pdf.splitTextToSize(key.replace(/_/g,' '), scW - 4);
            pdf.text(kl.slice(0,2), sx + 5, y + 12);
          });
          y += 16;
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // BENCHMARK + METHODOLOGY PAGE
      // ══════════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageHeader();

      // ── Benchmark ──
      const topNE = ranked.find(l => !l.excluded);
      if (topNE && spec?.sectorId) {
        const bench = compareToBenchmark(topNE.mcda_score, spec.sectorId, spec.geography?.city);
        if (bench) {
          sectionHead('Industry Benchmark Comparison');
          cardBg(34, C.s1, C.navy);

          const bBx = ml + 5; const bBw = 90; const bY1 = y + 7; const bY2 = y + 21;
          // This analysis
          pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); T(C.s9);
          pdf.text('This Analysis', bBx, bY1 - 1);
          bar(topNE.mcda_score, bBx, bBw, bY1, 4.5, scoreCol(topNE.mcda_score));
          pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(scoreCol(topNE.mcda_score));
          pdf.text(`${topNE.mcda_score.toFixed(1)}/10`, bBx + bBw + 2, bY1 + 3.5);
          // Sector avg
          pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s5);
          pdf.text('Sector Average', bBx, bY2 - 1);
          bar(bench.sectorAvg, bBx, bBw, bY2, 4.5, C.s5);
          pdf.setFontSize(8); T(C.s5);
          pdf.text(`${bench.sectorAvg.toFixed(1)}/10`, bBx + bBw + 2, bY2 + 3.5);
          // Rating + insight
          const rx = ml + 110;
          pdf.setFontSize(16); pdf.setFont('helvetica','bold'); T(scoreCol(topNE.mcda_score));
          pdf.text(bench.ratingLabel, rx, y + 14);
          pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s5);
          const iLines = pdf.splitTextToSize(bench.insight, cw - 110 - 5);
          pdf.text(iLines.slice(0,3), rx, y + 21);
          y += 38;
        }
      }

      gap(2); hline(); gap(5);

      // ── Methodology ──
      sectionHead('Methodology & Data Sources');
      const meths = [
        // v1.6.8 — rewritten to describe the ACTUAL v2 engine (the previous
        // text described the retired single-shot pipeline and named a stale
        // model, "GPT-4o-mini", in a client deliverable).
        { title: '1. Intent & Deterministic Planning',
          body: 'The brief is interpreted conversationally by a server-configured language model, then a deterministic planner locks the analysis structure: a reviewed business playbook (archetype) fixes the scoring factors, weights, and catchments, so an identical brief always produces an identical plan. The model writes explanations only - it cannot alter factors or weights.' },
        { title: '2. Spatial Data Collection',
          body: 'The study area is geocoded (Google primary, OpenStreetMap Nominatim fallback; coordinates supplied in the brief are used verbatim) and tiled with an H3 hexagonal grid. OpenStreetMap Overpass and Google Places count relevant features (transit, commercial, competitors, etc.) per factor catchment; water and no-build land (railway/ghat/heritage) are masked out as hard exclusions.' },
        { title: '3. Two-Pass MCDA Scoring',
          body: 'Every grid cell is scored with fast screening proxies and a weighted composite ranks the field; the top zones are then re-verified with real travel-time isochrones, routing, and verified place counts, and FINAL ranking uses those refined scores. Positive factors reward higher counts; negative factors penalize them; factors with no data are excluded from the mean, never scored as zero.' },
        { title: '4. Exclusions & Confidence',
          body: 'Named-area and engine-level exclusions are applied as hard filters. Confidence combines data sufficiency, provider health, and a deterministic reliability critique; the overall verdict always takes the most conservative of the signals and is disclosed alongside every recommendation.' },
        { title: 'Important Limitations',
          body: 'This is a screening-level assessment only. OSM coverage varies by region. Scores reflect relative suitability from available spatial data — not investment recommendations. Site-level due diligence and field validation are required before any real estate decision.',
          warn: true },
        { title: '5. Version & Analysis Metadata',
          body: `App v${__APP_VERSION__}  |  Engine v${__APP_VERSION__}  |  Spec v2.3  |  Analysis type: ${(result as any).uploadedCandidatesOnly ? 'Uploaded-candidates-only (candidate universe restricted to uploaded points)' : 'candidate zone screening (not parcel-level siting)'}  |  Recommendation mode: ${humanize((result as any).recommendationMode || 'recommended_sites')}  |  Site claim level: ${humanize((result as any).siteClaimLevel || 'micro_market_zone')}`,
          warn: false },
        // ── v1.6.0 (Phase 3) — headline confidence + weight audit ─────────────
        ...((result as any).unifiedConfidence ? [{
          title: `Overall Confidence: ${(result as any).unifiedConfidence.level}`,
          body: (result as any).unifiedConfidence.reason,
          warn: (result as any).unifiedConfidence.level !== 'High',
        }] : []),
        ...(() => {
          const wa = (result as any).weightAudit;
          const adjusted = weightsAdjusted || wa?.adjustedByUser === true;
          const executed = Object.fromEntries(
            (locations[0]?.criteria_breakdown ?? []).map(c => [c.name, c.weight]),
          );
          const defaults: Record<string, number> =
            wa?.defaultWeights || defaultWeights || {};
          const rows = Object.keys({ ...defaults, ...executed }).map(n => {
            const d = defaults[n] !== undefined ? `${Math.round(defaults[n] * 100)}%` : 'n/a';
            const e = executed[n] !== undefined ? `${Math.round((executed[n] as number) * 100)}%` : 'n/a';
            return `${n}: default ${d} -> applied ${e}`;
          });
          return [{
            title: adjusted ? 'Factor Weight Audit — ADJUSTED BY USER' : 'Factor Weight Audit — defaults applied',
            body: (adjusted
              ? 'The ranking in this report uses factor weights adjusted by the user; the playbook defaults are shown alongside for full transparency. '
              : 'The ranking in this report uses the analysis playbook default weights, unmodified. ')
              + rows.join('  |  '),
            warn: adjusted,
          }];
        })(),
        // v1.6.8 — only include planning metadata that actually resolved.
        // The live Pune report printed "Planning mode: not set | Archetype:
        // unknown | ... | Planning ID: n/a" — raw fallback placeholders in a
        // client deliverable. Absent fields are now omitted; if none resolve,
        // the whole card is dropped (the guarantee sentence alone is not
        // worth a card of unknowns).
        ...(() => {
          const dpParts = [
            (result as any).planningMode ? `Planning mode: ${humanize((result as any).planningMode)}` : '',
            (result as any).archetypeKey ? `Playbook: ${humanize((result as any).archetypeKey)}` : '',
            (result as any).weightsSource ? `Weights source: ${humanize((result as any).weightsSource)}` : '',
            (result as any).llmRole ? `LLM role: ${humanize((result as any).llmRole)}` : '',
            (result as any).planningFingerprint ? `Planning ID: ${(result as any).planningFingerprint}` : '',
          ].filter(Boolean);
          if (dpParts.length === 0) return [];
          return [{
            title: '6. Deterministic Planning',
            body: dpParts.join('  |  ')
              + '  |  Factor keys and weights are locked by the reviewed playbook registry and cannot be changed by the language model between runs.',
            warn: false,
          }];
        })(),
        // ── Evidence Appendix (v1.3.0) ──────────────────────────────────────────
        ...(() => {
          const et = (result as any).evidenceTrail;
          if (!et) return [];
          const providerSummary = (et.providerQueries || [])
            .map((q: any) => `${q.provider} (${q.queryPurpose}): ${q.featureCount} features`)
            .join(' | ') || 'No provider queries recorded';
          const factorSummary = (et.factors || [])
            .map((f: any) => `${f.displayName} w:${Math.round(f.weight * (f.weight > 1 ? 1 : 100))}% ${f.direction === 'positive' ? '▲' : '▼'} ${f.catchment}`)
            .join(' | ') || 'No factor evidence';
          const exclusionSummary = (et.exclusions || [])
            .filter((e: any) => e.targetType === 'h3_cell')
            .map((e: any) => e.reason)
            .join(' | ') || 'No cell exclusions recorded';
          const candExcl = (et.exclusions || []).filter((e: any) => e.targetType === 'candidate').length;
          return [{
            title: '7. Evidence Appendix (v1.3.0) — AUDIT REPRODUCIBLE',
            body: [
              `Evidence version: ${et.evidenceVersion}  |  Snapshot: ${et.dataSnapshot?.snapshotId || 'n/a'}  |  Provider mode: ${et.dataSnapshot?.providerMode || 'live'}  |  Study area geometry hash: ${et.studyArea?.geometryHash || 'n/a'}  |  H3 resolution: ${et.studyArea?.h3Resolution || 8}`,
              `H3 cells before masks: ${et.studyArea?.h3CellCountBeforeMasks || '?'}  |  Candidate exclusions: ${candExcl}  |  Valid recommendations: ${et.recommendationSummary?.validRecommendationCount ?? '?'}  |  Excluded candidates: ${et.recommendationSummary?.excludedCandidateCount ?? '?'}`,
              `PROVIDER QUERIES: ${providerSummary}`,
              `FACTOR SCHEMA: ${factorSummary}`,
              `CELL EXCLUSIONS: ${exclusionSummary}`,
              `SCORING FORMULA: ${et.scoring?.formulaDescription || 'n/a'}`,
              `LIMITATIONS: ${(et.limitations || []).slice(0, 2).join(' | ')}`,
              'This evidence trail is AUDIT REPRODUCIBLE — scoring methodology is fully documented. Full data replay requires cached provider snapshots (not yet implemented).',
            ].join('\n'),
            warn: false,
          }];
        })(),
        ...((result as any).uploadedCandidatesOnly ? [{
          title: '7. Uploaded Candidate Points',
          body: `Candidate universe: RESTRICTED to uploaded points only. Total uploaded: ${(result as any).uploadedCandidateCount || 0}. Ranked: ${(result as any).rankedUploadedCandidateCount || 0}. Excluded (invalid): ${(result as any).excludedUploadedCandidateCount || 0}. No H3 hex-grid search was performed — only user-supplied point locations were scored.`,
          warn: false,
        }] : []),
      ];
      meths.forEach((m, mi) => {
        const mLines = pdf.splitTextToSize(asciiSafe(m.body), cw - 10);
        const mH = mLines.length * 4 + 10;
        need(mH + 2);
        const bgCol: [number,number,number] = m.warn ? [255,251,235] : C.s1;
        const accCol: [number,number,number] = m.warn ? C.amber : C.navy;
        cardBg(mH, bgCol, accCol);
        pdf.setFontSize(8); pdf.setFont('helvetica','bold'); T(accCol);
        pdf.text(m.title, ml + 5, y + 6);
        pdf.setFontSize(7.5); pdf.setFont('helvetica','normal'); T(C.s7);
        pdf.text(mLines, ml + 5, y + 11);
        y += mH + 3;
      });

      allFooters();

      pdf.save(`Stratageo-SiteSuitability-${result.business_type.replace(/\s+/g,'-')}-${result.target_location.replace(/\s+/g,'-')}-${new Date().toISOString().slice(0,10)}.pdf`);
    } catch (e: any) { setError(`PDF export failed: ${e?.message || 'unknown error'}`); }
    finally { setIsLoading(false); }
  }, [result, locations, spec]);

  // ─── Share analysis ───
  const handleShareAnalysis = useCallback(async (shareId: string) => {
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = `${baseUrl}#/share/${shareId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareToast('Link copied! Anyone with this link can view the analysis.');
      setTimeout(() => setShareToast(null), 3000);
    } catch {
      setShareToast(shareUrl);
      setTimeout(() => setShareToast(null), 5000);
    }
  }, []);

  // ─── Load saved analysis ───
  const handleLoadAnalysis = useCallback((analysis: any) => {
    setResult(analysis.result);
    setSpec(analysis.spec);
    setDrawerOpen(true);
    setSavedOpen(false);
    if (analysis.result.locations?.length > 0) {
      const weights: Record<string, number> = {};
      analysis.result.locations[0].criteria_breakdown.forEach((c: any) => { weights[c.name] = c.weight; });
      setCustomWeights(weights);
    }
  }, []);

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
      <ErrorBoundary
        section="map"
        compact
        onError={() => {
          // A map render crash must never strand the chat input mid-analysis
          // behind a dead panel — release any execution lock so the user can
          // still cancel/retry from the chat side even if the map itself
          // stays broken until reload.
          if (isExecuting || isLoading) {
            resetAnalysisExecutionState();
            setAnalysisPhase('failed');
          }
        }}
      >
        <MapView
          locations={locations}
          selectedLocations={selectedRecalculated}
          onSelectLocation={handleSelectLocation}
          basemapId={basemapId}
          onBasemapChange={handleBasemapChange}
          onDeselectAll={handleDeselectAll}
          heatmapType={heatmapType}
          userPoints={userPoints}
          showBuffers={showBuffers}
          bufferRadiusM={spec?.userPointConstraints?.[0]?.radiusM}
          hexGrid={displayHexGrid}
          cellRanks={gridRanks}
          screeningCandidates={screeningCandidates}
          catchments={result?.catchments}
          recommendationWithheld={result?.recommendationWithheld}
          studyAreaBoundary={result?.studyAreaBoundary}
        />
      </ErrorBoundary>

      <TopBar
        mode={config.isDemoMode ? 'demo' : 'live'}
        hasResults={locations.length > 0}
        onExportPDF={handleExportPDF}
        onMethodology={() => setMethodologyOpen(true)}
        onNewAnalysis={handleNewAnalysis}
        sessions={sessionIndex.sessions}
        currentSessionId={currentSession.id}
        onSwitchSession={handleSwitchSession}
        user={user}
        onLogout={handleLogout}
        onAdminOpen={() => setAdminOpen(true)}
        onSavedOpen={() => setSavedOpen(true)}
        darkMode={darkMode}
        onToggleDark={handleToggleDark}
        onShareAnalysis={result ? () => {
          if (user && result && spec) {
            saveAnalysis(user.uid, user.email, lastPrompt, result, spec).then(shareId => {
              handleShareAnalysis(shareId);
            }).catch(() => setShareToast('Failed to generate share link.'));
          }
        } : undefined}
      />

      <ErrorBoundary
        section="chat assistant"
        onError={() => {
          // The chat panel IS the cancel/retry surface. If it crashes mid-
          // analysis, the user has no other way to recover — proactively
          // unlock execution state so a reload (or the boundary's own
          // "Try again") doesn't leave a phantom job the user can't see
          // or stop.
          resetAnalysisExecutionState();
          setAnalysisPhase('failed');
          setError('The chat panel hit an unexpected error and was reset. Any in-progress analysis was cancelled — please try your prompt again.');
        }}
      >
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
          chatSpec={chatSpec}
          chatSpecStatus={chatSpecStatus}
          chatReady={chatReady}
          chatStage={chatStage}
          isExecuting={isExecuting}
          onConfirmExecute={handleConfirmExecute}
          onSpecEdit={handleSpecEdit}
          onCancelAnalysis={handleCancelAnalysis}
          canRetry={canRetry}
          onRetryAnalysis={handleRetryAnalysis}
          analysisPhase={analysisPhase}
        />
      </ErrorBoundary>

      {result && (
        <ErrorBoundary
          section="results panel"
          onError={() => {
            // A malformed/partial result is the most likely render crash
            // source (missing score fields, geometry, validation data).
            // "Try again" on the SAME result would just re-throw immediately
            // — clear the bad result and close the drawer so retry actually
            // lands somewhere usable, and unlock execution state in case the
            // crash happened right as a job completed (isExecuting/isLoading
            // would otherwise still read true with nothing left to clear it).
            setResult(null);
            setDrawerOpen(false);
            resetAnalysisExecutionState();
            setAnalysisPhase('failed');
            setError('The results couldn’t be displayed due to an unexpected error. Please try the analysis again.');
          }}
        >
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
            defaultWeights={defaultWeights}
            weightsAdjusted={weightsAdjusted}
            screeningCandidates={screeningCandidates}
            routeConstraintPresent={Boolean((spec as any)?.routeConstraint)}
            onWeightsReset={handleWeightsReset}
            heatmapType={heatmapType}
            onHeatmapChange={setHeatmapType}
            showBuffers={showBuffers}
            onToggleBuffers={() => setShowBuffers(prev => !prev)}
            csvPointCount={userPoints.length}
            onWidenCorridor={() => {
              setDrawerOpen(false);
              handleChatTurn(
                'Widen the riverfront band to 500 m and re-run, but keep the area strictly ' +
                'between the same landmarks. Relax the riverfront corridor only, not the geography.'
              );
            }}
          />
        </ErrorBoundary>
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

      <SavedAnalyses
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        onLoadAnalysis={handleLoadAnalysis}
        onShareAnalysis={handleShareAnalysis}
      />

      {shareToast && <div className="sg-share-toast">{shareToast}</div>}

      {isSharedView && (
        <div className="sg-share-banner">
          <span>Viewing shared analysis (read-only)</span>
          <a href={window.location.origin + window.location.pathname} onClick={(e) => { e.preventDefault(); setIsSharedView(false); navigate('/'); }}>
            Go to Portal
          </a>
        </div>
      )}
    </div>
  );
};

export default App;
