import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LocationData, AnalysisResult, AnalysisStatus, AnalysisSpec, HeatmapType, UserPoint } from './types';
import { config } from './config';
import { runDemoAnalysis, runServerAnalysis } from './services/analysisService';
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
      const pw = pdf.internal.pageSize.getWidth();   // 210mm
      const ph = pdf.internal.pageSize.getHeight();  // 297mm
      const ml = 14; const mr = 14; const cw = pw - ml - mr;
      let y = 0;

      // ─── Brand colours ───────────────────────────────────────────────────────
      const C = {
        navy:   [29,  78,  216] as [number,number,number],
        teal:   [5,  150,  105] as [number,number,number],
        green:  [22, 163,   74] as [number,number,number],
        amber:  [217,119,    6] as [number,number,number],
        red:    [220,  38,   38] as [number,number,number],
        slate9: [15,  23,   42] as [number,number,number],
        slate7: [51,  65,   85] as [number,number,number],
        slate5: [100,116,  139] as [number,number,number],
        slate2: [226,232,  240] as [number,number,number],
        slate1: [248,250,  252] as [number,number,number],
        white:  [255,255,  255] as [number,number,number],
        orange: [249,115,   22] as [number,number,number],
        blue:   [59, 130,  246] as [number,number,number],
      };

      const setFill  = (c: [number,number,number]) => pdf.setFillColor(c[0],c[1],c[2]);
      const setStroke= (c: [number,number,number]) => pdf.setDrawColor(c[0],c[1],c[2]);
      const setTxt   = (c: [number,number,number]) => pdf.setTextColor(c[0],c[1],c[2]);

      // ─── Score → colour ───────────────────────────────────────────────────────
      const scoreColor = (s: number, excl = false): [number,number,number] =>
        excl ? C.slate5 : s >= 7.5 ? C.green : s >= 5 ? C.amber : C.red;

      // ─── Helpers ──────────────────────────────────────────────────────────────
      const ensureSpace = (need: number) => {
        if (y + need > ph - 16) { pdf.addPage(); drawPageHeader(); }
      };

      const sectionLabel = (text: string) => {
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'bold');
        setTxt(C.slate5);
        pdf.text(text.toUpperCase(), ml, y); y += 4;
      };

      // ─── PAGE HEADER (appears on every page) ─────────────────────────────────
      const drawPageHeader = () => {
        // Navy top band
        setFill(C.navy); pdf.rect(0, 0, pw, 10, 'F');
        pdf.setFontSize(13); pdf.setFont('helvetica', 'bold');
        setTxt(C.white); pdf.text('STRATA', ml, 7);
        setTxt(C.teal);  pdf.text('GEO', ml + pdf.getTextWidth('STRATA') + 1, 7);
        pdf.setFontSize(7); pdf.setFont('helvetica', 'normal');
        setTxt([180,200,230] as [number,number,number]);
        const tag = 'Site Suitability Report  ·  stratageo.in';
        pdf.text(tag, pw - mr - pdf.getTextWidth(tag), 7);
        y = 16;
      };

      // ─── PAGE FOOTER ──────────────────────────────────────────────────────────
      const drawAllFooters = () => {
        const pc = pdf.internal.getNumberOfPages();
        for (let i = 1; i <= pc; i++) {
          pdf.setPage(i);
          setStroke(C.slate2); pdf.setLineWidth(0.3);
          pdf.line(ml, ph - 10, pw - mr, ph - 10);
          pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal');
          setTxt(C.slate5);
          pdf.text('Screening-level assessment · Field validation recommended · © Stratageo', ml, ph - 6);
          const pg = `${i} of ${pc}`;
          pdf.text(pg, pw - mr - pdf.getTextWidth(pg), ph - 6);
        }
      };

      // ─── Horizontal divider ───────────────────────────────────────────────────
      const divider = (gap = 4) => {
        setStroke(C.slate2); pdf.setLineWidth(0.25);
        pdf.line(ml, y, pw - mr, y); y += gap;
      };

      // ─── Filled section card ──────────────────────────────────────────────────
      const card = (h: number) => {
        setFill(C.slate1); pdf.rect(ml, y, cw, h, 'F');
      };

      // ─── Score pill (small coloured rectangle + number) ───────────────────────
      const scorePill = (score: number, excl: boolean, px: number, py: number) => {
        const col = scoreColor(score, excl);
        setFill(col);
        pdf.roundedRect(px, py - 3.5, 14, 5, 1, 1, 'F');
        pdf.setFontSize(8); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        const lbl = excl ? 'EXC' : `${score.toFixed(1)}`;
        pdf.text(lbl, px + 7 - pdf.getTextWidth(lbl) / 2, py);
      };

      // ─── Horizontal score bar ─────────────────────────────────────────────────
      const scoreBar = (score: number, maxW: number, barY: number, barH: number, excl = false) => {
        setFill(C.slate2); pdf.rect(0, barY, maxW, barH, 'F'); // track
        const fillW = Math.max(1, (score / 10) * maxW);
        setFill(scoreColor(score, excl));
        pdf.rect(0, barY, fillW, barH, 'F'); // fill
      };

      // ─── Criterion row ────────────────────────────────────────────────────────
      const criterionRow = (name: string, score: number, rawVal: number, weight: number, dir: string, rowY: number) => {
        const nameW = 62; const barX = ml + nameW + 2; const barW = cw - nameW - 22; const scoreX = ml + cw - 18; const wtX = ml + cw;
        // row background (alt)
        const col = dir === 'negative'
          ? (score <= 3 ? C.red : score <= 6 ? C.orange : C.green)
          : (score >= 7 ? C.green : score >= 4 ? C.blue : C.red);
        // Name
        pdf.setFontSize(7); pdf.setFont('helvetica', 'normal'); setTxt(C.slate7);
        const arrow = dir === 'negative' ? '▼' : '▲';
        pdf.text(`${arrow} ${name}`.substring(0, 32), ml, rowY + 2.5);
        // Bar
        setFill(C.slate2); pdf.rect(barX, rowY, barW, 3.5, 'F');
        setFill(col); pdf.rect(barX, rowY, Math.max(0.5, (score / 10) * barW), 3.5, 'F');
        // Score
        pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); setTxt(C.slate9);
        pdf.text(`${score.toFixed(1)}`, scoreX, rowY + 2.8);
        // Weight
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
        pdf.text(`${Math.round(weight * 100)}%`, wtX - pdf.getTextWidth(`${Math.round(weight * 100)}%`), rowY + 2.8);
      };

      // ══════════════════════════════════════════════════════════════════════════
      // PAGE 1 — COVER
      // ══════════════════════════════════════════════════════════════════════════
      drawPageHeader();

      // ── Title block ──
      setFill(C.slate1); pdf.rect(ml, y, cw, 18, 'F');
      setFill(C.navy); pdf.rect(ml, y, 2, 18, 'F'); // left accent
      pdf.setFontSize(14); pdf.setFont('helvetica', 'bold'); setTxt(C.slate9);
      pdf.text(result.business_type, ml + 5, y + 7);
      pdf.setFontSize(9); pdf.setFont('helvetica', 'normal'); setTxt(C.navy);
      pdf.text(result.target_location, ml + 5, y + 13);

      // Top location score badge (top-right of title block)
      const top = [...locations].sort((a, b) => a.excluded === b.excluded ? b.mcda_score - a.mcda_score : (a.excluded ? 1 : -1))[0];
      if (top) {
        const bx = pw - mr - 28; const by = y + 2;
        scorePill(top.mcda_score, top.excluded, bx, by + 5);
        pdf.setFontSize(6); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
        pdf.text('top score', bx, by + 10);
      }
      y += 22;

      // ── Meta line ──
      const dateStr = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const radiusStr = locations[0] ? `${(locations[0].searchRadiusM / 1000).toFixed(1)}km radius` : '';
      const confStr = spec ? `Confidence: ${spec.confidence}` : '';
      const constraintStr = spec && spec.constraints.length > 0 ? `${spec.constraints.length} constraint(s)` : '';
      const metaParts = [dateStr, radiusStr, confStr, constraintStr].filter(Boolean);
      pdf.setFontSize(7.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
      pdf.text(metaParts.join('   ·   '), ml, y); y += 5;

      // ── Constraints tags ──
      if (spec && spec.constraints.length > 0) {
        let cx = ml;
        spec.constraints.forEach(c => {
          const lbl = `${c.direction === 'away' ? '✕ ' : '✓ '}${c.label}`;
          const tw = pdf.getTextWidth(lbl) + 4;
          setFill(c.direction === 'away' ? [254,226,226] as [number,number,number] : [220,252,231] as [number,number,number]);
          pdf.roundedRect(cx, y, tw, 4.5, 1, 1, 'F');
          pdf.setFontSize(6.5); pdf.setFont('helvetica', 'bold');
          setTxt(c.direction === 'away' ? C.red : C.green);
          pdf.text(lbl, cx + 2, y + 3.2);
          cx += tw + 2;
          if (cx > pw - mr - 20) { y += 6; cx = ml; }
        });
        y += 7;
      }

      divider(3);

      // ── Executive summary ──
      sectionLabel('Executive Summary');
      const summaryLines = pdf.splitTextToSize(result.summary, cw);
      const summaryH = Math.min(summaryLines.length, 6) * 4 + 4;
      card(summaryH);
      pdf.setFontSize(8.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate7);
      pdf.text(summaryLines.slice(0, 6), ml + 3, y + 4);
      y += summaryH + 4;

      // ── Ranked locations overview — visual score matrix ──
      const ranked = [...locations].sort((a, b) => a.excluded === b.excluded ? b.mcda_score - a.mcda_score : (a.excluded ? 1 : -1));
      sectionLabel('Ranked Locations Overview');

      // Table header
      setFill(C.navy); pdf.rect(ml, y, cw, 6, 'F');
      pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
      pdf.text('LOCATION', ml + 2, y + 4.2);
      pdf.text('SCORE', ml + 55, y + 4.2);
      pdf.text('SUITABILITY INDEX', ml + 80, y + 4.2);
      pdf.text('STATUS', pw - mr - 15, y + 4.2);
      y += 6;

      ranked.forEach((loc, idx) => {
        ensureSpace(10);
        const rowH = 9;
        const bg: [number,number,number] = idx % 2 === 0 ? C.white : C.slate1;
        setFill(bg); pdf.rect(ml, y, cw, rowH, 'F');

        // Rank + Name
        setFill(scoreColor(loc.mcda_score, loc.excluded));
        pdf.rect(ml, y, 5, rowH, 'F');
        pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        pdf.text(`${idx + 1}`, ml + 1.5, y + 5.5);
        pdf.setFont('helvetica', loc.excluded ? 'italic' : 'bold'); setTxt(loc.excluded ? C.slate5 : C.slate9);
        pdf.setFontSize(8);
        pdf.text(loc.name, ml + 7, y + 4);
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
        pdf.text(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`, ml + 7, y + 7.5);

        // Score number
        pdf.setFontSize(9); pdf.setFont('helvetica', 'bold');
        setTxt(scoreColor(loc.mcda_score, loc.excluded));
        pdf.text(`${loc.mcda_score.toFixed(1)}`, ml + 55, y + 5.5);
        pdf.setFontSize(6.5); setTxt(C.slate5);
        pdf.text('/10', ml + 55 + pdf.getTextWidth(`${loc.mcda_score.toFixed(1)}`) + 0.5, y + 5.5);

        // Score bar (suitability index)
        const barX = ml + 80; const barW = cw - 80 - 20; const barY = y + 3; const barH = 3;
        setFill(C.slate2); pdf.rect(barX, barY, barW, barH, 'F');
        setFill(scoreColor(loc.mcda_score, loc.excluded));
        pdf.rect(barX, barY, Math.max(1, (loc.mcda_score / 10) * barW), barH, 'F');

        // Status badge
        const status = loc.excluded ? 'EXCLUDED' : loc.mcda_score >= 7.5 ? 'STRONG' : loc.mcda_score >= 5 ? 'VIABLE' : 'WEAK';
        const statusCol = loc.excluded ? C.slate5 : loc.mcda_score >= 7.5 ? C.green : loc.mcda_score >= 5 ? C.amber : C.red;
        setFill(statusCol); pdf.roundedRect(pw - mr - 18, y + 2, 16, 5, 1, 1, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        pdf.text(status, pw - mr - 10 - pdf.getTextWidth(status) / 2, y + 5.3);

        // Bottom border
        setStroke(C.slate2); pdf.setLineWidth(0.2);
        pdf.line(ml, y + rowH, pw - mr, y + rowH);
        y += rowH;
      });
      y += 4;

      // ── Criteria comparison (what was measured) ──
      if (ranked[0] && ranked[0].criteria_breakdown.length > 0) {
        divider(4);
        sectionLabel('Scoring Criteria Applied');
        setFill(C.slate1); pdf.rect(ml, y, cw, 6, 'F');
        pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); setTxt(C.slate5);
        pdf.text('CRITERION', ml + 2, y + 4.2);
        pdf.text('TYPE', ml + 68, y + 4.2);
        pdf.text('WEIGHT', ml + 85, y + 4.2);
        y += 6;
        ranked[0].criteria_breakdown.forEach((cr, idx) => {
          const rowH = 5.5;
          setFill(idx % 2 === 0 ? C.white : C.slate1); pdf.rect(ml, y, cw, rowH, 'F');
          pdf.setFontSize(7); pdf.setFont('helvetica', 'normal'); setTxt(C.slate7);
          pdf.text(`${cr.direction === 'negative' ? '▼' : '▲'}  ${cr.name}`, ml + 2, y + 3.8);
          setTxt(cr.direction === 'negative' ? C.orange : C.teal);
          pdf.setFontSize(6.5);
          pdf.text(cr.direction === 'negative' ? 'Negative (less=better)' : 'Positive (more=better)', ml + 68, y + 3.8);
          setTxt(C.slate5);
          pdf.text(`${Math.round(cr.weight * 100)}%`, ml + 85, y + 3.8);
          y += rowH;
        });
        y += 4;
      }

      // ══════════════════════════════════════════════════════════════════════════
      // DETAIL PAGES — one per location
      // ══════════════════════════════════════════════════════════════════════════
      for (let li = 0; li < ranked.length; li++) {
        const loc = ranked[li];
        pdf.addPage(); drawPageHeader();

        // ── Location header card ──
        const headerH = 20;
        setFill(loc.excluded ? C.slate1 : C.slate1);
        pdf.rect(ml, y, cw, headerH, 'F');
        const accentCol = scoreColor(loc.mcda_score, loc.excluded);
        setFill(accentCol); pdf.rect(ml, y, 3, headerH, 'F');

        // Rank badge
        setFill(accentCol); pdf.rect(ml + 5, y + 3, 8, 8, 'F');
        pdf.setFontSize(11); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        pdf.text(`${li + 1}`, ml + 7, y + 9.5);

        // Name + coordinates
        pdf.setFontSize(14); pdf.setFont('helvetica', 'bold');
        setTxt(loc.excluded ? C.slate5 : C.slate9);
        pdf.text(loc.name + (loc.excluded ? '  [EXCLUDED]' : ''), ml + 16, y + 8);
        pdf.setFontSize(7.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
        pdf.text(`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}   ·   Search radius: ${(loc.searchRadiusM / 1000).toFixed(1)}km`, ml + 16, y + 14);

        // Score pill (large)
        const pillX = pw - mr - 22; const pillY = y + 3;
        setFill(accentCol); pdf.roundedRect(pillX, pillY, 20, 12, 2, 2, 'F');
        pdf.setFontSize(16); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        const scoreStr = loc.mcda_score.toFixed(1);
        pdf.text(scoreStr, pillX + 10 - pdf.getTextWidth(scoreStr) / 2, pillY + 9);
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal');
        pdf.text('/ 10', pillX + 10 - pdf.getTextWidth('/ 10') / 2, pillY + 13.5);
        y += headerH + 4;

        // ── Exclusion reason ──
        const failedExcl = loc.exclusions.filter(e => !e.passed);
        if (failedExcl.length > 0) {
          setFill([254,226,226] as [number,number,number]); pdf.rect(ml, y, cw, 7 * failedExcl.length + 2, 'F');
          setFill(C.red); pdf.rect(ml, y, 2, 7 * failedExcl.length + 2, 'F');
          failedExcl.forEach((ex, ei) => {
            pdf.setFontSize(7.5); pdf.setFont('helvetica', 'bold'); setTxt(C.red);
            pdf.text(`Exclusion constraint failed: ${ex.rule}`, ml + 4, y + 5 + ei * 7);
          });
          y += 7 * failedExcl.length + 6;
        }

        // ── GIS Analyst Reasoning ──
        sectionLabel('GIS Analyst Assessment');
        const rLines = pdf.splitTextToSize(loc.reasoning, cw);
        const reasonH = Math.min(rLines.length, 8) * 4 + 6;
        card(reasonH);
        setFill(accentCol); pdf.rect(ml, y, 2, reasonH, 'F');
        pdf.setFontSize(8.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate7);
        pdf.text(rLines.slice(0, 8), ml + 5, y + 4.5);
        y += reasonH + 5;

        // ── Criteria breakdown table ──
        sectionLabel('Scoring Criteria Breakdown');

        // Table header
        setFill(C.slate9); pdf.rect(ml, y, cw, 6.5, 'F');
        pdf.setFontSize(6.5); pdf.setFont('helvetica', 'bold'); setTxt(C.white);
        pdf.text('CRITERION', ml + 2, y + 4.5);
        pdf.text('SCORE INDEX', ml + 66, y + 4.5);
        pdf.text('RAW EVIDENCE', ml + 112, y + 4.5);
        pdf.text('WEIGHT', pw - mr - 11, y + 4.5);
        y += 6.5;

        loc.criteria_breakdown.forEach((cr, idx) => {
          ensureSpace(9);
          const rowH = 9;
          setFill(idx % 2 === 0 ? C.white : C.slate1); pdf.rect(ml, y, cw, rowH, 'F');

          // Criterion name + justification
          const arrow = cr.direction === 'negative' ? '▼' : '▲';
          pdf.setFontSize(8); pdf.setFont('helvetica', 'bold');
          setTxt(cr.direction === 'negative' ? C.orange : C.navy);
          pdf.text(`${arrow}  ${cr.name}`, ml + 2, y + 4);
          pdf.setFontSize(6); pdf.setFont('helvetica', 'italic'); setTxt(C.slate5);
          const justLines = pdf.splitTextToSize(cr.justification || '', 60);
          pdf.text(justLines.slice(0, 1), ml + 2, y + 7.5);

          // Score bar + number (0–10 scale)
          const barX = ml + 66; const barW = 44; const barY2 = y + 3.5; const barH2 = 3;
          setFill(C.slate2); pdf.rect(barX, barY2, barW, barH2, 'F');
          const crColor = cr.direction === 'negative'
            ? (cr.score <= 3 ? C.red : cr.score <= 6 ? C.orange : C.green)
            : (cr.score >= 7 ? C.green : cr.score >= 4 ? C.blue : C.red);
          setFill(crColor); pdf.rect(barX, barY2, Math.max(0.5, (cr.score / 10) * barW), barH2, 'F');
          pdf.setFontSize(8); pdf.setFont('helvetica', 'bold'); setTxt(crColor);
          pdf.text(`${cr.score.toFixed(1)}/10`, barX + barW + 1, y + 5.5);

          // Raw evidence
          pdf.setFontSize(8); pdf.setFont('helvetica', 'bold'); setTxt(C.slate9);
          pdf.text(`${cr.rawValue ?? 0} observed`, ml + 112, y + 4);
          pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
          pdf.text('within search radius', ml + 112, y + 7.5);

          // Weight badge
          setFill(C.slate2); pdf.roundedRect(pw - mr - 13, y + 2, 11, 5, 1, 1, 'F');
          pdf.setFontSize(7); pdf.setFont('helvetica', 'bold'); setTxt(C.slate7);
          const wtLbl = `${Math.round(cr.weight * 100)}%`;
          pdf.text(wtLbl, pw - mr - 7.5 - pdf.getTextWidth(wtLbl) / 2, y + 5.5);

          // Row border
          setStroke(C.slate2); pdf.setLineWidth(0.2);
          pdf.line(ml, y + rowH, pw - mr, y + rowH);
          y += rowH;
        });
        y += 6;

        // ── OSM signal summary ──
        if (loc.osmSignals && Object.keys(loc.osmSignals).length > 0) {
          ensureSpace(16);
          sectionLabel('Raw Spatial Evidence (OSM Signal Counts)');
          setFill(C.slate1); pdf.rect(ml, y, cw, 5, 'F');
          const signals = Object.entries(loc.osmSignals);
          const colW = cw / Math.min(signals.length, 5);
          signals.slice(0, 5).forEach(([key, val], si) => {
            const sx = ml + si * colW;
            pdf.setFontSize(9); pdf.setFont('helvetica', 'bold'); setTxt(C.navy);
            pdf.text(String(val), sx + 2, y + 3.5);
          });
          y += 5;
          signals.slice(0, 5).forEach(([key], si) => {
            const sx = ml + si * colW;
            pdf.setFontSize(5.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
            pdf.text(key.replace(/_/g,' '), sx + 2, y + 3);
          });
          y += 6;
        }
      }

      // ══════════════════════════════════════════════════════════════════════════
      // FINAL PAGE — Benchmark + Methodology
      // ══════════════════════════════════════════════════════════════════════════
      pdf.addPage(); drawPageHeader();

      // ── Benchmark ──
      if (spec?.sectorId) {
        const topNE = ranked.find(l => !l.excluded);
        if (topNE) {
          const bench = compareToBenchmark(topNE.mcda_score, spec.sectorId, spec.geography?.city);
          if (bench) {
            sectionLabel('Industry Benchmark Comparison');
            card(30);
            setFill(C.navy); pdf.rect(ml, y, 2, 30, 'F');

            // Score vs benchmark visual
            const bBarX = ml + 5; const bBarW = 80;
            pdf.setFontSize(8); pdf.setFont('helvetica', 'bold'); setTxt(C.slate9);
            pdf.text('This Analysis', bBarX, y + 6);
            setFill(scoreColor(topNE.mcda_score, false));
            pdf.rect(bBarX, y + 7, (topNE.mcda_score / 10) * bBarW, 4, 'F');
            pdf.setFontSize(8); pdf.setFont('helvetica', 'bold'); setTxt(C.slate9);
            pdf.text(`${topNE.mcda_score.toFixed(1)}/10`, bBarX + (topNE.mcda_score / 10) * bBarW + 1, y + 10.5);

            pdf.setFontSize(8); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
            pdf.text('Sector Average', bBarX, y + 18);
            setFill(C.slate5);
            pdf.rect(bBarX, y + 19, (bench.sectorAvg / 10) * bBarW, 4, 'F');
            pdf.text(`${bench.sectorAvg.toFixed(1)}/10`, bBarX + (bench.sectorAvg / 10) * bBarW + 1, y + 22.5);

            // Rating label
            const ratingX = ml + 100;
            pdf.setFontSize(18); pdf.setFont('helvetica', 'bold');
            setTxt(scoreColor(topNE.mcda_score, false));
            pdf.text(bench.ratingLabel, ratingX, y + 14);
            pdf.setFontSize(7.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate5);
            const insightLines = pdf.splitTextToSize(bench.insight, cw - 100 - 5);
            pdf.text(insightLines.slice(0, 2), ratingX, y + 20);
            y += 36;
          }
        }
      }

      // ── Methodology ──
      divider(4);
      sectionLabel('Methodology & Data Sources');
      const methBlocks = [
        {
          title: '1. Intent Extraction',
          body: 'The user query is parsed by GPT-4o-mini using a sector-specific GIS handbook prompt to extract business type, location, constraints, and scoring criteria. The system generates MCDA criteria dynamically per business profile.',
        },
        {
          title: '2. Spatial Data Collection',
          body: 'Candidate neighborhoods are geocoded via Google Geocoding API (Nominatim fallback). For each candidate, OpenStreetMap Overpass API and Google Places API are queried to count relevant features (transit, commercial, competitors, etc.) within the search radius.',
        },
        {
          title: '3. MCDA Scoring',
          body: 'Raw feature counts are mapped to 0–10 scores using continuous linear interpolation against sector-calibrated thresholds. Positive criteria reward higher counts; negative criteria penalize them. A weighted composite score is computed per location.',
        },
        {
          title: '4. Exclusion & Feasibility',
          body: 'Named-area exclusions are geocoded and applied as hard filters. Feasibility is checked against site profile (land intensity, urban preference, market positioning). Confidence is scored from 0–100 based on geocoding quality, data sufficiency, and candidate pool.',
        },
        {
          title: 'Important Limitations',
          body: 'This is a screening-level assessment only. OSM coverage varies by region; less-mapped areas produce sparser evidence. Scores reflect relative suitability from available data — they are not investment recommendations. Field validation and site-level due diligence are required before any real estate or investment decision.',
        },
      ];
      methBlocks.forEach((blk, bi) => {
        ensureSpace(18);
        setFill(bi === methBlocks.length - 1 ? [255,251,235] as [number,number,number] : C.slate1);
        pdf.rect(ml, y, cw, 16, 'F');
        setFill(bi === methBlocks.length - 1 ? C.amber : C.navy);
        pdf.rect(ml, y, 2, 16, 'F');
        pdf.setFontSize(8); pdf.setFont('helvetica', 'bold');
        setTxt(bi === methBlocks.length - 1 ? C.amber : C.navy);
        pdf.text(blk.title, ml + 4, y + 5);
        pdf.setFontSize(7.5); pdf.setFont('helvetica', 'normal'); setTxt(C.slate7);
        const bodyLines = pdf.splitTextToSize(blk.body, cw - 6);
        pdf.text(bodyLines.slice(0, 2), ml + 4, y + 10);
        y += 18;
      });

      // All page footers
      drawAllFooters();

      pdf.save(`Stratageo-SiteSuitability-${result.business_type.replace(/\s+/g, '-')}-${result.target_location.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0,10)}.pdf`);
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
