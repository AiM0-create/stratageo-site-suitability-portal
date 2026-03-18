import React, { useState, useCallback, useMemo } from 'react';
import type { LocationData, AnalysisResult, AnalysisStatus, HeatmapType } from './types';
import { config } from './config';
import { runDemoAnalysis, runLiveAnalysis } from './services/analysisService';
import { recalculateWithWeights } from './services/scoringEngine';
import { TopBar } from './components/TopBar';
import { MapView } from './components/MapView';
import { FloatingAssistant } from './components/FloatingAssistant';
import { ResultsDrawer } from './components/ResultsDrawer';
import { MethodologyDialog } from './components/MethodologyDialog';

declare const html2canvas: any;
declare const jspdf: any;

const App: React.FC = () => {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [selectedLocations, setSelectedLocations] = useState<LocationData[]>([]);
  const [customWeights, setCustomWeights] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>({ message: '', progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [heatmapType, setHeatmapType] = useState<HeatmapType>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);

  const locations = useMemo(() => {
    if (!result) return [];
    return recalculateWithWeights(result.locations, customWeights);
  }, [result, customWeights]);

  const selectedRecalculated = useMemo(() => {
    return locations.filter(loc => selectedLocations.some(sl => sl.name === loc.name));
  }, [locations, selectedLocations]);

  const handleRunAnalysis = useCallback(async (businessType: string, city: string) => {
    setIsLoading(true);
    setError(null);
    setResult(null);
    setSelectedLocations([]);
    setCustomWeights({});
    setHeatmapType(null);
    setDrawerOpen(false);
    setAnalysisStatus({ message: 'Starting analysis...', progress: 5 });

    setMessages(prev => [...prev, { role: 'user' as const, text: `${businessType} in ${city}` }]);

    try {
      const analysisResult = config.isDemoMode
        ? await runDemoAnalysis({ businessType, city }, setAnalysisStatus)
        : await runLiveAnalysis({ businessType, city }, setAnalysisStatus);

      setResult(analysisResult);

      if (analysisResult.locations.length > 0) {
        const weights: Record<string, number> = {};
        analysisResult.locations[0].criteria_breakdown.forEach(c => {
          weights[c.name] = c.weight;
        });
        setCustomWeights(weights);
      }

      setDrawerOpen(true);

      const top = analysisResult.locations[0];
      setMessages(prev => [...prev, {
        role: 'assistant' as const,
        text: top
          ? `Found ${analysisResult.locations.length} candidate areas in ${analysisResult.target_location}. ${top.name} ranks highest at ${top.mcda_score}/10.`
          : analysisResult.summary,
      }]);
    } catch (err: any) {
      const msg = err?.message || 'Analysis failed. Please try again.';
      setError(msg);
      setMessages(prev => [...prev, { role: 'assistant' as const, text: msg }]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSelectLocation = useCallback((location: LocationData) => {
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    setSelectedLocations(prev => {
      const isSelected = prev.some(l => l.name === location.name);
      if (isSelected) return prev.filter(l => l.name !== location.name);
      if (prev.length < 2) return [...prev, location];
      return [prev[prev.length - 1], location];
    });

    if (!drawerOpen) setDrawerOpen(true);
  }, [drawerOpen]);

  const handleDeselectAll = useCallback(() => {
    setSelectedLocations([]);
  }, []);

  const handleWeightChange = useCallback((name: string, weight: number) => {
    setCustomWeights(prev => ({ ...prev, [name]: weight }));
  }, []);

  const handleNewAnalysis = useCallback(() => {
    setResult(null);
    setSelectedLocations([]);
    setCustomWeights({});
    setError(null);
    setHeatmapType(null);
    setDrawerOpen(false);
    setMessages([]);
  }, []);

  const handleExportPDF = useCallback(async () => {
    if (!result || locations.length === 0) return;
    setIsLoading(true);
    try {
      const { jsPDF } = jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const m = 15;
      let y = m;
      const hdr = () => {
        y = m;
        pdf.setFontSize(18); pdf.setFont('helvetica', 'bold');
        pdf.setTextColor('#1d4ed8'); pdf.text('STRATA', m, y);
        pdf.setTextColor('#059669'); pdf.text('GEO', m + pdf.getTextWidth('STRATA') + 1, y);
        pdf.setFontSize(9); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(100, 116, 139);
        const t = 'Site Suitability Report';
        pdf.text(t, pw - m - pdf.getTextWidth(t), y);
        y += 8; pdf.setDrawColor(226, 232, 240); pdf.line(m, y, pw - m, y); y += 8;
      };
      hdr();
      pdf.setFontSize(11); pdf.setTextColor(55, 65, 81);
      pdf.text(`${result.business_type} — ${result.target_location}`, m, y); y += 8;
      pdf.setFontSize(9); pdf.setTextColor(55, 65, 81);
      const sl = pdf.splitTextToSize(result.summary, pw - m * 2);
      pdf.text(sl, m, y); y += sl.length * 4 + 6;
      const mapEl = document.getElementById('map-container');
      if (mapEl) {
        try {
          const c = await html2canvas(mapEl, { useCORS: true, logging: false, scale: 2 });
          const img = c.toDataURL('image/png');
          const ip = pdf.getImageProperties(img);
          const w = pw - m * 2;
          const h = (ip.height * w) / ip.width;
          if (y + h > ph - 20) { pdf.addPage(); hdr(); }
          pdf.addImage(img, 'PNG', m, y, w, Math.min(h, 100));
          y += Math.min(h, 100) + 6;
        } catch { /* skip */ }
      }
      for (const loc of locations) {
        if (y > ph - 50) { pdf.addPage(); hdr(); }
        pdf.setFontSize(12); pdf.setTextColor(29, 78, 216);
        pdf.text(`${loc.name} — ${loc.mcda_score}/10`, m, y); y += 5;
        pdf.setFontSize(9); pdf.setTextColor(55, 65, 81);
        const r = pdf.splitTextToSize(loc.reasoning, pw - m * 2);
        pdf.text(r, m, y); y += r.length * 4 + 3;
        for (const cr of loc.criteria_breakdown) {
          if (y > ph - 15) { pdf.addPage(); hdr(); }
          pdf.setFontSize(9); pdf.setTextColor(30, 58, 138);
          pdf.text(`${cr.name}: ${cr.score}/10 (w:${cr.weight.toFixed(2)})`, m, y); y += 3.5;
          pdf.setFontSize(8); pdf.setTextColor(100, 116, 139);
          const j = pdf.splitTextToSize(cr.justification, pw - m * 2);
          pdf.text(j, m, y); y += j.length * 3.5 + 2.5;
        }
        y += 3;
      }
      const pc = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= pc; i++) {
        pdf.setPage(i); pdf.setFontSize(7); pdf.setTextColor(156, 163, 175);
        pdf.text(`${i}/${pc}`, pw - m - 10, ph - 8);
        pdf.text('Stratageo', m, ph - 8);
      }
      pdf.save('Stratageo-Report.pdf');
    } catch { setError('PDF export failed.'); }
    finally { setIsLoading(false); }
  }, [result, locations]);

  return (
    <div className="portal">
      <MapView
        locations={locations}
        selectedLocations={selectedRecalculated}
        onSelectLocation={handleSelectLocation}
        onDeselectAll={handleDeselectAll}
        heatmapType={heatmapType}
      />

      <TopBar
        mode={config.isDemoMode ? 'demo' : 'live'}
        hasResults={locations.length > 0}
        onExportPDF={handleExportPDF}
        onMethodology={() => setMethodologyOpen(true)}
        onNewAnalysis={handleNewAnalysis}
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
      />

      {result && (
        <ResultsDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          result={result}
          locations={locations}
          selectedLocations={selectedRecalculated}
          onSelectLocation={handleSelectLocation}
          customWeights={customWeights}
          onWeightChange={handleWeightChange}
          heatmapType={heatmapType}
          onHeatmapChange={setHeatmapType}
        />
      )}

      <MethodologyDialog
        open={methodologyOpen}
        onClose={() => setMethodologyOpen(false)}
      />
    </div>
  );
};

export default App;
