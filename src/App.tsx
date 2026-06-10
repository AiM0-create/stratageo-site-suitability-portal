import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LocationData, AnalysisResult, AnalysisStatus, AnalysisSpec, HeatmapType, UserPoint } from './types';
import type { BasemapId } from './components/MapView';
import { config } from './config';
import { runDemoAnalysis, runServerAnalysis } from './services/analysisService';
import { sendChatTurn, startAnalysis, pollAnalysis } from './services/chatService';
import type { SpecV2 } from './types/chat';
import { getLastDiagnostics } from './services/llmIntentExtractor';
import { recalculateWithWeights } from './services/mcdaEngine';
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
  const [savedOpen, setSavedOpen] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const [isSharedView, setIsSharedView] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');

  // ─── Conversational mode (v1.0.1) ───
  const [chatSpec, setChatSpec] = useState<SpecV2 | null>(null);
  const [chatSpecStatus, setChatSpecStatus] = useState<'empty' | 'draft' | 'complete'>('empty');
  const [chatReady, setChatReady] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  // Accumulated gpt-4o tokens across chat turns; logged with the execution entry
  const chatTokensRef = useRef(0);

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
            setResult(analysis.result);
            setSpec(analysis.spec);
            setDrawerOpen(true);
            setIsSharedView(true);
            if (analysis.result.locations.length > 0) {
              const weights: Record<string, number> = {};
              analysis.result.locations[0].criteria_breakdown.forEach(c => { weights[c.name] = c.weight; });
              setCustomWeights(weights);
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
    try {
      const history = [
        ...currentSession.messages.map(m => ({ role: m.role, content: m.text })),
        { role: 'user' as const, content: rawPrompt },
      ];
      const resp = await sendChatTurn(history, chatSpec, {
        resultCount,
        csvPointCount: userPoints.length,
      });
      addMessage('assistant', resp.reply);
      if (resp.usage?.totalTokens) chatTokensRef.current += resp.usage.totalTokens;
      if (resp.spec) {
        setChatSpec(resp.spec as SpecV2);
        setChatSpecStatus(resp.specStatus);
      }
      setChatReady(resp.readyToExecute && resp.specValid);
    } catch (err: any) {
      const msg = err?.message || 'Chat failed. Please try again.';
      setError(msg);
      addMessage('assistant', msg);
    } finally {
      setIsLoading(false);
    }
  }, [currentSession.messages, chatSpec, resultCount, userPoints.length, addMessage]);

  // ─── Execute the agreed spec (consumes one prompt credit) ───
  const handleConfirmExecute = useCallback(async () => {
    if (!chatSpec) return;
    const canProceed = await consumePrompt();
    if (!canProceed) {
      setLimitModalOpen(true);
      return;
    }
    const analysisStartTime = Date.now();
    setIsExecuting(true);
    setIsLoading(true);
    setError(null);
    setSelectedLocations([]);
    setHeatmapType(null);
    setAnalysisStatus({ message: 'Starting analysis…', progress: 2 });
    try {
      const jobId = await startAnalysis(chatSpec);
      const analysisResultData = await pollAnalysis(jobId, setAnalysisStatus);

      setResult(analysisResultData);
      setSpec(analysisResultData.spec);
      if (analysisResultData.locations.length > 0) {
        const weights: Record<string, number> = {};
        analysisResultData.locations[0].criteria_breakdown.forEach(c => { weights[c.name] = c.weight; });
        setCustomWeights(weights);
      }
      setDrawerOpen(true);
      setChatReady(false);

      const top = analysisResultData.locations.filter(l => !l.excluded)[0];
      addMessage('assistant', top
        ? `Analysis complete — screened ${analysisResultData.spec.parsingNotes.find(n => n.includes('hexes'))?.match(/\d+ hexes/)?.[0] || 'the study area'}. ${top.name} ranks highest at ${top.mcda_score}/10.`
        : analysisResultData.summary);

      if (user) {
        saveAnalysis(user.uid, user.email, lastPrompt || chatSpec.objective, analysisResultData, analysisResultData.spec).catch(() => {});
        logPrompt({
          userId: user.uid,
          email: user.email,
          prompt: chatSpec.objective,
          sector: chatSpec.businessType,
          city: analysisResultData.target_location || '',
          latencyMs: Date.now() - analysisStartTime,
          resultCount: analysisResultData.locations.length,
          topScore: top?.mcda_score ?? null,
          pdfExported: false,
          isFollowUp: false,
          tokensUsed: chatTokensRef.current,
          dataSource: 'hybrid' as any,
        });
        chatTokensRef.current = 0;
      }

      updateMemory({
        businessType: chatSpec.businessType,
        city: analysisResultData.target_location || null,
        sectorId: 'conversational_v2',
        constraints: (chatSpec.exclusions || []).map(e => e.name),
        lastResultCount: analysisResultData.locations.length,
        lastSearchRadiusM: analysisResultData.locations[0]?.searchRadiusM || null,
        lastAnalysisTimestamp: new Date().toISOString(),
      });
      if (currentSession.title === 'New Analysis') {
        dispatch({ type: 'SET_TITLE', title: `${chatSpec.businessType} — ${analysisResultData.target_location || 'study area'}` });
      }
    } catch (err: any) {
      const msg = err?.message || 'Analysis failed. Please try again.';
      setError(msg);
      addMessage('assistant', msg);
    } finally {
      setIsExecuting(false);
      setIsLoading(false);
    }
  }, [chatSpec, consumePrompt, user, lastPrompt, currentSession.title, addMessage, updateMemory, dispatch]);

  const handleRunAnalysis = useCallback(async (rawPrompt: string) => {
    // ─── Conversational mode: route to multi-turn chat, no immediate execution ───
    if (config.isConversationalMode) {
      setLastPrompt(rawPrompt);
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
  }, [resultCount, userPoints, currentSession.memory, currentSession.messages, currentSession.title, addMessage, updateMemory, dispatch, consumePrompt, user, handleChatTurn]);

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
    setChatSpec(null);
    setChatSpecStatus('empty');
    setChatReady(false);
    newSession();
  }, [newSession, result, spec, customWeights, userPoints, currentSession.id]);

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
      const sumLines = pdf.splitTextToSize(result.summary, cw - 10);
      const maxSumLines = Math.min(sumLines.length, 8);
      const sumH = maxSumLines * 4.5 + 6;
      cardBg(sumH, C.s1, C.navy);
      pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
      pdf.text(sumLines.slice(0, maxSumLines), ml + 5, y + 5);
      y += sumH + 5;

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

      // ── Criteria overview table ──
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
        sectionHead('GIS Analyst Assessment');
        // split to cw-10 to avoid right-edge cutoff
        const rLines = pdf.splitTextToSize(loc.reasoning, cw - 10);
        const rCount = Math.min(rLines.length, 10);
        const rH = rCount * 4.5 + 6;
        cardBg(rH, C.s1, ac);
        pdf.setFontSize(8); pdf.setFont('helvetica','normal'); T(C.s7);
        pdf.text(rLines.slice(0, rCount), ml + 5, y + 5);
        y += rH + 5;

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

          // Score bar
          const crCol = cr.direction === 'negative'
            ? (cr.score <= 3 ? C.red : cr.score <= 6 ? C.orange : C.green)
            : (cr.score >= 7 ? C.green : cr.score >= 4 ? C.blue : C.red);
          bar(cr.score, cBarX, cBarW, y + 4, 3, crCol);

          // Score number — in its own column, no overlap with bar or evidence
          pdf.setFontSize(9); pdf.setFont('helvetica','bold'); T(crCol);
          pdf.text(`${cr.score.toFixed(1)}`, cScoreX, y + 5.5);
          pdf.setFontSize(6.5); T(C.s5);
          pdf.text('/10', cScoreX, y + 9);

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
        { title: '1. Intent Extraction',
          body: 'The user query is parsed by GPT-4o-mini using a sector-specific GIS handbook to extract business type, location, constraints, and scoring criteria. MCDA criteria are generated dynamically per business profile.' },
        { title: '2. Spatial Data Collection',
          body: 'Candidate neighborhoods are geocoded via Google Geocoding API (Nominatim fallback). OpenStreetMap Overpass API and Google Places API count relevant features (transit, commercial, competitors, etc.) within the search radius.' },
        { title: '3. MCDA Scoring',
          body: 'Raw feature counts are mapped to 0-10 scores using continuous linear interpolation against sector-calibrated thresholds. Positive criteria reward higher counts; negative criteria penalize them. A weighted composite score is computed per location.' },
        { title: '4. Exclusions & Confidence',
          body: 'Named-area exclusions are geocoded and applied as hard filters. Confidence is scored 0-100 based on geocoding quality, OSM/Google data sufficiency, and candidate pool. Bands: high (80+), moderate (55-79), low (<55).' },
        { title: 'Important Limitations',
          body: 'This is a screening-level assessment only. OSM coverage varies by region. Scores reflect relative suitability from available spatial data — not investment recommendations. Site-level due diligence and field validation are required before any real estate decision.',
          warn: true },
      ];
      meths.forEach((m, mi) => {
        const mLines = pdf.splitTextToSize(m.body, cw - 10);
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
        user={user}
        onLogout={logout}
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
        isExecuting={isExecuting}
        onConfirmExecute={handleConfirmExecute}
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
