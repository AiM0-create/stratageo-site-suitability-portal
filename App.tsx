

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Chatbot } from './components/Chatbot';
import { Map } from './components/Map';
import { DetailsPanel } from './components/DetailsPanel';
import { HelpGuide } from './components/HelpGuide';
import { Header } from './components/Header';
import { ExportOptionsModal, ExportOptions } from './components/ExportOptionsModal';
import { ChatMessage, LocationData, FileAttachment, WeatherData, GroundingSource } from './types';
import { getGeoInsights } from './services/geminiService';

// Declare jsPDF and html2canvas for TypeScript
declare const html2canvas: any;
declare const jspdf: any;

interface WeatherState {
    [locationName: string]: WeatherData | null;
}

const App: React.FC = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: '1',
            sender: 'ai',
            text: "Welcome to Stratageo Site Suitability Portal! Tell me about your business idea (e.g., 'Cafe in Bengaluru') and I'll analyze the best locations for you.",
        }
    ]);
    const [locations, setLocations] = useState<LocationData[]>([]);
    const [selectedLocations, setSelectedLocations] = useState<LocationData[]>([]);
    const [weatherData, setWeatherData] = useState<WeatherState>({});
    const [isLoading, setIsLoading] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState<{ message: string; progress: number }>({ message: '', progress: 0 });
    const [error, setError] = useState<string | null>(null);
    const [showHelpGuide, setShowHelpGuide] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);
    const [analysisMeta, setAnalysisMeta] = useState<{ 
        business_type?: string; 
        target_location?: string; 
        methodology?: string; 
        summary?: string;
        grounding_sources?: GroundingSource[];
    }>({});
    const [heatmapType, setHeatmapType] = useState<'competitor' | 'transport' | 'commercial' | 'residential' | null>(null);
    const [heatmapRadius, setHeatmapRadius] = useState(25);
    const [heatmapBlur, setHeatmapBlur] = useState(15);
    const [heatmapOpacity, setHeatmapOpacity] = useState(0.8);
    const [customWeights, setCustomWeights] = useState<Record<string, number>>({});

    useEffect(() => {
        const hasSeenGuide = localStorage.getItem('hasSeenHelpGuide');
        if (!hasSeenGuide) {
            setShowHelpGuide(true);
        }
    }, []);

    const handleNewChat = useCallback(() => {
        setMessages([
            {
                id: '1',
                sender: 'ai',
                text: "Welcome to Stratageo Site Suitability Portal! Tell me about your business idea (e.g., 'Cafe in Bengaluru') and I'll analyze the best locations for you.",
            }
        ]);
        setLocations([]);
        setSelectedLocations([]);
        setWeatherData({});
        setAnalysisMeta({});
        setError(null);
    }, []);

    const handleCloseHelpGuide = useCallback(() => {
        localStorage.setItem('hasSeenHelpGuide', 'true');
        setShowHelpGuide(false);
    }, []);

    const handleShowHelpGuide = useCallback(() => {
        setShowHelpGuide(true);
    }, []);

    const fetchWeatherForLocations = async (locationsToFetch: LocationData[]) => {
        const validLocations = locationsToFetch
            .map(loc => ({ ...loc, lat: Number(loc.lat), lng: Number(loc.lng) }))
            .filter(loc => Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
        const weatherPromises = validLocations.map(async (loc) => {
            try {
                const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto`);
                if (!response.ok) return [loc.name, null];
                const data = await response.json();
                return [loc.name, data];
            } catch (error) {
                console.error(`Failed to fetch weather for ${loc.name}`, error);
                return [loc.name, null];
            }
        });
        const weatherResults = await Promise.all(weatherPromises);
        setWeatherData(Object.fromEntries(weatherResults));
    };

    const handleSendMessage = useCallback(async (text: string, file: FileAttachment | null) => {
        const userMessage: ChatMessage = {
            id: Date.now().toString(),
            sender: 'user',
            text,
            file: file ? { name: file.name, type: file.mimeType } : undefined,
        };

        setMessages(prev => [...prev, userMessage]);
        setIsLoading(true);
        setAnalysisStatus({ message: 'Initializing analysis...', progress: 5 });
        setError(null);
        setLocations([]); 
        setSelectedLocations([]);
        setWeatherData({});

        try {
            const result = await getGeoInsights(text, file, (message, progress) => {
                setAnalysisStatus({ message, progress });
            });
            
            const aiMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                sender: 'ai',
                text: result.summary,
            };
            setMessages(prev => [...prev, aiMessage]);
            const parsedLocations = result.locations.map(loc => ({
                ...loc,
                lat: Number(loc.lat),
                lng: Number(loc.lng),
                pois: loc.pois?.map(p => ({
                    ...p,
                    lat: Number(p.lat),
                    lng: Number(p.lng)
                }))
            }));
            
            setLocations(parsedLocations);
            
            // Initialize custom weights from the first location's criteria
            if (parsedLocations.length > 0) {
                const initialWeights: Record<string, number> = {};
                parsedLocations[0].criteria_breakdown.forEach(c => {
                    initialWeights[c.name] = c.weight;
                });
                setCustomWeights(initialWeights);
            }

            setAnalysisMeta({
                business_type: result.business_type,
                target_location: result.target_location,
                methodology: result.methodology,
                summary: result.summary,
                grounding_sources: result.grounding_sources
            });
            fetchWeatherForLocations(parsedLocations);

        } catch (err: any) {
            console.error("Error fetching geo insights:", err);
            let errorMessage = "Sorry, I couldn't fetch insights right now. Please try again later.";
            
            // Handle rate limit error
            const errorStr = JSON.stringify(err).toUpperCase();
            const isRateLimit = 
                err?.status === 429 || 
                err?.code === 429 ||
                err?.error?.code === 429 ||
                errorStr.includes("RESOURCE_EXHAUSTED") || 
                errorStr.includes("429") ||
                errorStr.includes("QUOTA") ||
                (err?.message && err.message.toUpperCase().includes("RESOURCE_EXHAUSTED"));

            if (isRateLimit) {
                errorMessage = "The AI is currently experiencing high demand (Rate Limit Exceeded). Please wait a minute and try again.";
            } else if (err?.message) {
                if (err.message.startsWith('GEOCODING_FAILED:')) {
                    errorMessage = `**Location Not Found.**\n\nI couldn't find the specific neighborhoods on the map. \n\n**Suggestions:**\n- Try specifying a larger or more well-known city.\n- Check for any spelling errors in the location name.\n- Provide a broader region instead of specific street names.`;
                } else if (err.message.startsWith('OSM_FAILED:')) {
                    errorMessage = `**Data Retrieval Issue.**\n\nI was able to locate the area, but I couldn't fetch the detailed OpenStreetMap data (competitors, transport, etc.) right now. The server might be busy.\n\n**Suggestions:**\n- Please wait a moment and try your request again.\n- Try a slightly different location or business type.`;
                } else if (err.message.startsWith('DATA_FETCH_FAILED:')) {
                     errorMessage = `**Insufficient Data.**\n\nI couldn't gather enough real-world data to perform a reliable analysis for this specific request.\n\n**Suggestions:**\n- Try a different, perhaps more populated, target city.\n- Broaden your business type description.`;
                } else {
                    errorMessage = `Error: ${err.message}`;
                }
            }

            setError(errorMessage);
            const aiError: ChatMessage = {
                id: (Date.now() + 1).toString(),
                sender: 'ai',
                text: errorMessage
            };
            setMessages(prev => [...prev, aiError]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const handleSelectLocation = useCallback((location: LocationData) => {
        // Double check coordinates to prevent Leaflet NaN errors
        const lat = Number(location.lat);
        const lng = Number(location.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            console.error("Attempted to select location with invalid coordinates:", location);
            return;
        }

        const validLocation = { ...location, lat, lng };

        setSelectedLocations(prev => {
            const isSelected = prev.some(l => l.name === validLocation.name);
            if (isSelected) {
                return prev.filter(l => l.name !== validLocation.name);
            }
            if (prev.length < 2) {
                return [...prev, validLocation];
            }
            return [prev[prev.length -1], validLocation]; // Replace the older of the two
        });
    }, []);

    const handleDeselectLocations = useCallback(() => {
        setSelectedLocations([]);
    }, []);

    const handleWeightChange = (criteriaName: string, newWeight: number) => {
        setCustomWeights(prev => ({ ...prev, [criteriaName]: newWeight }));
    };

    // Recalculate locations based on custom weights
    const recalculatedLocations = useMemo(() => {
        if (Object.keys(customWeights).length === 0) return locations;

        return locations.map(loc => {
            let totalWeightedScore = 0;
            let totalWeight = 0;

            const newCriteria = loc.criteria_breakdown.map(c => {
                const weight = customWeights[c.name] !== undefined ? customWeights[c.name] : c.weight;
                totalWeightedScore += c.score * weight;
                totalWeight += weight;
                return { ...c, weight };
            });

            const newScore = totalWeight > 0 ? Number((totalWeightedScore / totalWeight).toFixed(1)) : 0;

            return {
                ...loc,
                mcda_score: newScore,
                criteria_breakdown: newCriteria
            };
        });
    }, [locations, customWeights]);

    const recalculatedSelectedLocations = useMemo(() => {
        return recalculatedLocations.filter(loc => selectedLocations.some(sl => sl.name === loc.name));
    }, [recalculatedLocations, selectedLocations]);

    const handleExportPDF = useCallback(async (options: ExportOptions) => {
        if (locations.length === 0) return;
        setShowExportModal(false);
        setIsLoading(true);

        const { jsPDF } = jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageHeight = pdf.internal.pageSize.getHeight();
        const pageWidth = pdf.internal.pageSize.getWidth();
        const margin = 15;
        let yPos = 0;

        const addHeader = () => {
            yPos = margin;
            pdf.setFontSize(20);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor('#1e40af'); // text-blue-800
            pdf.text("STRATA", margin, yPos);
            pdf.setTextColor('#047857'); // text-green-600
            pdf.text("GEO", margin + pdf.getTextWidth("STRATA") + 1, yPos);
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(100, 116, 139); // text-slate-500
            const reportTitle = "Site Suitability Analysis Report";
            pdf.text(reportTitle, pageWidth - margin - pdf.getTextWidth(reportTitle), yPos);
            yPos += 10;
            pdf.setDrawColor(226, 232, 240); // slate-200
            pdf.line(margin, yPos, pageWidth - margin, yPos);
            yPos += 10;
        };

        const addFooter = () => {
            const pageCount = pdf.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                pdf.setPage(i);
                pdf.setFontSize(8);
                pdf.setTextColor(156, 163, 175); // text-gray-400
                const pageText = `Page ${i} of ${pageCount}`;
                const stratageoText = "© Stratageo | https://stratageo.in/";
                pdf.text(pageText, pageWidth - margin - pdf.getTextWidth(pageText), pageHeight - 10);
                pdf.text(stratageoText, margin, pageHeight - 10);
            }
        };

        addHeader();

        // Add Analysis Meta
        if (options.includeMeta) {
            if (analysisMeta.business_type) {
                pdf.setFontSize(12);
                pdf.setTextColor(55, 65, 81);
                pdf.text(`Business Type: ${analysisMeta.business_type}`, margin, yPos);
                yPos += 6;
            }
            if (analysisMeta.target_location) {
                pdf.setFontSize(12);
                pdf.setTextColor(55, 65, 81);
                pdf.text(`Target Location: ${analysisMeta.target_location}`, margin, yPos);
                yPos += 10;
            }
        }

        // Add Summary
        if (options.includeSummary) {
            const executiveSummary = analysisMeta.summary || "No summary available.";
            pdf.setFontSize(16);
            pdf.setTextColor(29, 78, 216); // Blue-700
            pdf.text("Executive Summary", margin, yPos);
            yPos += 8;
            pdf.setFontSize(10);
            pdf.setTextColor(55, 65, 81); // Gray-600
            const summaryLines = pdf.splitTextToSize(executiveSummary, pageWidth - (margin * 2));
            pdf.text(summaryLines, margin, yPos);
            yPos += (summaryLines.length * 4) + 10;
        }

        // Add Methodology
        if (options.includeMethodology && analysisMeta.methodology) {
             if (yPos > pageHeight - 60) { pdf.addPage(); addHeader(); }
             pdf.setFontSize(16);
             pdf.setTextColor(29, 78, 216);
             pdf.text("MCDA Methodology", margin, yPos);
             yPos += 8;
             pdf.setFontSize(10);
             pdf.setTextColor(55, 65, 81);
             const methodLines = pdf.splitTextToSize(analysisMeta.methodology, pageWidth - (margin * 2));
             pdf.text(methodLines, margin, yPos);
             yPos += (methodLines.length * 4) + 10;
        }
        
        // Add Map Image
        if (options.includeMap) {
            const mapElement = document.getElementById('map-tour-target');
            if (mapElement) {
                const canvas = await html2canvas(mapElement, { useCORS: true, logging: false, scale: 2 });
                const imgData = canvas.toDataURL('image/png');
                const imgProps = pdf.getImageProperties(imgData);
                const pdfWidth = pageWidth - (margin * 2);
                const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
                if (yPos + pdfHeight > pageHeight - margin) {
                    pdf.addPage();
                    addHeader();
                }
                pdf.addImage(imgData, 'PNG', margin, yPos, pdfWidth, pdfHeight);
                yPos += pdfHeight + 10;
            }
        }

        // Add Locations
        if (options.includeLocationDetails) {
            for (const loc of recalculatedLocations) {
                 if (yPos > pageHeight - 60) { // Check if enough space for header
                    pdf.addPage();
                    addHeader();
                }
                pdf.setFontSize(16);
                pdf.setTextColor(29, 78, 216); // Blue-700
                pdf.text(loc.name, margin, yPos);
                yPos += 8;
                
                // Suitability Score
                pdf.setFontSize(12);
                pdf.setTextColor(4, 120, 87); // Green-700
                pdf.text(`Suitability Score: ${loc.mcda_score}/10`, margin, yPos);
                yPos += 10;
    
                const addSection = (title: string, content: string | number | undefined, yStart = yPos, xStart = margin) => {
                    if (!content) return 0;
                    const sectionHeight = pdf.getTextDimensions(String(content), { fontSize: 10, maxWidth: pageWidth - (margin * 2) - xStart }).h + 12;
                    if (yStart + sectionHeight > pageHeight - margin - 10) {
                        return -1; // Indicates page break needed
                    }
                    pdf.setFontSize(12);
                    pdf.setTextColor(30, 58, 138); // Blue-900
                    pdf.text(title, xStart, yStart);
                    pdf.setFontSize(10);
                    pdf.setTextColor(55, 65, 81); // Gray-600
                    const lines = pdf.splitTextToSize(String(content), pageWidth - (margin * 2) - xStart);
                    pdf.text(lines, xStart, yStart + 6);
                    return (lines.length * 4) + 10;
                };
                
                let height = addSection('Reasoning', loc.reasoning);
                if (height === -1) { pdf.addPage(); addHeader(); height = addSection('Reasoning', loc.reasoning); }
                yPos += height;
                
                // MCDA Breakdown Table
                if (loc.criteria_breakdown && loc.criteria_breakdown.length > 0) {
                    if (yPos > pageHeight - 60) { pdf.addPage(); addHeader(); }
                    pdf.setFontSize(12);
                    pdf.setTextColor(30, 58, 138);
                    pdf.text("Criteria Breakdown", margin, yPos);
                    yPos += 8;
                    
                    loc.criteria_breakdown.forEach(criteria => {
                         if (yPos > pageHeight - 20) { pdf.addPage(); addHeader(); }
                         pdf.setFontSize(10);
                         pdf.setTextColor(0, 0, 0);
                         pdf.text(`${criteria.name} (Weight: ${criteria.weight})`, margin, yPos);
                         pdf.text(`${criteria.score}/10`, pageWidth - margin - 20, yPos);
                         yPos += 5;
                         pdf.setFontSize(9);
                         pdf.setTextColor(100, 116, 139);
                         const justLines = pdf.splitTextToSize(criteria.justification, pageWidth - (margin * 2));
                         pdf.text(justLines, margin, yPos);
                         yPos += (justLines.length * 4) + 5;
                    });
                    yPos += 5;
                }
    
                const details = [
                    { title: 'Demographics', content: loc.demographics },
                    { title: 'Footfall', content: loc.footfall },
                    { title: 'Marketing Radius', content: `${loc.marketing_radius_km} km` },
                ];
                
                for(const detail of details) {
                     height = addSection(detail.title, detail.content);
                     if (height === -1) { pdf.addPage(); addHeader(); height = addSection(detail.title, detail.content); }
                     yPos += height;
                }
    
                height = addSection('Strategic Recommendation', loc.marketing_strategy);
                if (height === -1) { pdf.addPage(); addHeader(); height = addSection('Strategic Recommendation', loc.marketing_strategy); }
                yPos += height;
            }
        }

        // Add Grounding Sources
        if (options.includeGrounding && analysisMeta.grounding_sources && analysisMeta.grounding_sources.length > 0) {
            if (yPos > pageHeight - 40) { pdf.addPage(); addHeader(); }
            pdf.setFontSize(16);
            pdf.setTextColor(29, 78, 216);
            pdf.text("Data Sources & Grounding", margin, yPos);
            yPos += 8;
            
            analysisMeta.grounding_sources.forEach(source => {
                if (yPos > pageHeight - 30) { pdf.addPage(); addHeader(); }
                pdf.setFontSize(10);
                pdf.setTextColor(30, 58, 138);
                pdf.text(source.title, margin, yPos);
                yPos += 5;
                
                pdf.setFontSize(8);
                pdf.setTextColor(100, 116, 139);
                pdf.text(source.uri, margin, yPos);
                yPos += 4;
                
                pdf.setFontSize(7);
                pdf.setTextColor(71, 85, 105);
                pdf.text(`Reliability: ${source.reliability} | Retrieved: ${new Date(source.retrievedAt).toLocaleDateString()}`, margin, yPos);
                yPos += 8;
            });
        }

        addFooter();
        pdf.save('Stratageo-Suitability-Report.pdf');
        setIsLoading(false);

    }, [locations, messages, analysisMeta]);


    return (
        <div className="flex flex-col h-screen w-screen">
            <Header onHelpClick={handleShowHelpGuide} onExportPDF={() => setShowExportModal(true)} isExportEnabled={locations.length > 0} />
            <div className="relative flex-grow">
                {showHelpGuide && <HelpGuide onClose={handleCloseHelpGuide} />}
                {showExportModal && <ExportOptionsModal onClose={() => setShowExportModal(false)} onExport={handleExportPDF} />}
                <Map 
                    locations={recalculatedLocations}
                    selectedLocations={recalculatedSelectedLocations}
                    onSelectLocation={handleSelectLocation}
                    onDeselectLocation={handleDeselectLocations}
                    heatmapType={heatmapType}
                    heatmapRadius={heatmapRadius}
                    heatmapBlur={heatmapBlur}
                    heatmapOpacity={heatmapOpacity}
                />
                
                {recalculatedLocations.length > 0 && (
                    <div className="absolute top-4 left-4 z-[1000] bg-white/90 backdrop-blur-sm p-3 rounded-2xl shadow-lg border border-gray-100 w-64">
                        <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wider mb-2">Heatmap Layers</h3>
                        <div className="flex flex-col gap-2 mb-4">
                            <button 
                                onClick={() => setHeatmapType(heatmapType === 'competitor' ? null : 'competitor')}
                                className={`text-sm px-3 py-1.5 rounded-lg transition-colors text-left ${heatmapType === 'competitor' ? 'bg-red-100 text-red-700 font-semibold' : 'hover:bg-gray-100 text-gray-600'}`}
                            >
                                🔴 Competitors
                            </button>
                            <button 
                                onClick={() => setHeatmapType(heatmapType === 'transport' ? null : 'transport')}
                                className={`text-sm px-3 py-1.5 rounded-lg transition-colors text-left ${heatmapType === 'transport' ? 'bg-purple-100 text-purple-700 font-semibold' : 'hover:bg-gray-100 text-gray-600'}`}
                            >
                                🟣 Transport Hubs
                            </button>
                            <button 
                                onClick={() => setHeatmapType(heatmapType === 'commercial' ? null : 'commercial')}
                                className={`text-sm px-3 py-1.5 rounded-lg transition-colors text-left ${heatmapType === 'commercial' ? 'bg-orange-100 text-orange-700 font-semibold' : 'hover:bg-gray-100 text-gray-600'}`}
                            >
                                🟠 Commercial Areas
                            </button>
                        </div>

                        {heatmapType && (
                            <div className="border-t border-gray-200 pt-3 mt-2">
                                <h4 className="text-xs font-semibold text-gray-700 mb-2">Heatmap Settings</h4>
                                
                                <div className="mb-2">
                                    <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                                        <span>Radius</span>
                                        <span>{heatmapRadius}px</span>
                                    </div>
                                    <input 
                                        type="range" min="10" max="50" value={heatmapRadius} 
                                        onChange={(e) => setHeatmapRadius(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                    />
                                </div>
                                
                                <div className="mb-2">
                                    <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                                        <span>Blur</span>
                                        <span>{heatmapBlur}px</span>
                                    </div>
                                    <input 
                                        type="range" min="5" max="40" value={heatmapBlur} 
                                        onChange={(e) => setHeatmapBlur(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                    />
                                </div>

                                <div className="mb-3">
                                    <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                                        <span>Opacity</span>
                                        <span>{Math.round(heatmapOpacity * 100)}%</span>
                                    </div>
                                    <input 
                                        type="range" min="0.1" max="1" step="0.1" value={heatmapOpacity} 
                                        onChange={(e) => setHeatmapOpacity(Number(e.target.value))}
                                        className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                    />
                                </div>

                                <div className="mt-3">
                                    <h4 className="text-[10px] font-semibold text-gray-700 mb-1 uppercase tracking-wider">Intensity Legend</h4>
                                    <div className="flex h-3 w-full rounded overflow-hidden" style={{
                                        background: heatmapType === 'competitor' 
                                            ? 'linear-gradient(to right, blue, cyan, lime, yellow, red)'
                                            : heatmapType === 'transport'
                                            ? 'linear-gradient(to right, purple, magenta, pink, white)'
                                            : 'linear-gradient(to right, green, yellow, orange, red)'
                                    }}></div>
                                    <div className="flex justify-between text-[9px] text-gray-500 mt-1">
                                        <span>Low</span>
                                        <span>High</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {recalculatedLocations.length > 0 && (
                    <div className="absolute top-4 right-4 z-[1000]">
                        <a href="https://stratageo.in/contact.php" target="_blank" rel="noopener noreferrer" className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-xl shadow-lg transition-colors flex items-center gap-2">
                            <span>Contact an Expert</span>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                            </svg>
                        </a>
                    </div>
                )}

                <DetailsPanel 
                    locations={recalculatedSelectedLocations}
                    allLocations={recalculatedLocations}
                    onClose={handleDeselectLocations}
                    groundingSources={analysisMeta.grounding_sources}
                    customWeights={customWeights}
                    onWeightChange={handleWeightChange}
                />
                <Chatbot
                    messages={messages}
                    onSendMessage={handleSendMessage}
                    isLoading={isLoading}
                    analysisStatus={analysisStatus}
                    error={error}
                    onNewChat={handleNewChat}
                />
            </div>
        </div>
    );
};

export default App;