import React, { useEffect, useState, useMemo } from 'react';
import type { LocationData, GroundingSource } from '../types';
import { XMarkIcon, UsersIcon, TrendingUpIcon, BusIcon, SparklesIcon, ArrowTopRightOnSquareIcon, LeafIcon, ArrowsPointingOutIcon } from './icons';
import { 
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, 
    ResponsiveContainer, Legend, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid 
} from 'recharts';

interface DetailsPanelProps {
    locations: LocationData[];
    allLocations?: LocationData[];
    onClose: () => void;
    groundingSources?: GroundingSource[];
    customWeights?: Record<string, number>;
    onWeightChange?: (criteriaName: string, newWeight: number) => void;
}

const MCDAComparisonChart: React.FC<{ locations: LocationData[] }> = ({ locations }) => {
    const chartData = useMemo(() => {
        if (locations.length === 0) return [];
        
        // Get all unique criteria names
        const criteriaNames = Array.from(new Set(
            locations.flatMap(loc => loc.criteria_breakdown.map(c => c.name))
        ));

        return criteriaNames.map(name => {
            const dataPoint: any = { subject: name };
            locations.forEach((loc, index) => {
                const criteria = loc.criteria_breakdown.find(c => c.name === name);
                dataPoint[`score${index}`] = criteria ? criteria.score : 0;
                dataPoint[`name${index}`] = loc.name;
            });
            return dataPoint;
        });
    }, [locations]);

    const colors = ['#2563eb', '#10b981', '#f59e0b', '#ef4444'];

    if (locations.length === 0) return null;

    return (
        <div className="w-full h-80 bg-white/50 backdrop-blur-sm rounded-2xl border border-white/20 p-4 mb-6">
            <h3 className="text-sm font-bold text-gray-800 mb-2 flex items-center gap-2">
                <TrendingUpIcon className="h-4 w-4 text-blue-600" />
                MCDA Comparison
            </h3>
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                    <XAxis type="number" domain={[0, 10]} hide />
                    <YAxis dataKey="subject" type="category" tick={{ fill: '#64748b', fontSize: 11 }} width={120} />
                    <Tooltip 
                        cursor={{ fill: 'transparent' }}
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                    />
                    {locations.length > 1 && <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />}
                    {locations.map((loc, index) => (
                        <Bar 
                            key={loc.name}
                            dataKey={`score${index}`} 
                            name={loc.name} 
                            fill={colors[index % colors.length]} 
                            radius={[0, 4, 4, 0]} 
                            barSize={locations.length > 1 ? 12 : 20}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
};

const MCDAScoreDisplay: React.FC<{ score: number }> = ({ score }) => {
    return (
        <div className="flex items-baseline">
            <span className="text-3xl font-bold text-blue-800">{score.toFixed(1)}</span>
            <span className="text-xl font-semibold text-gray-500 ml-1">/10</span>
        </div>
    );
};

const FootfallIndicator: React.FC<{ level: string }> = ({ level }) => {
    const levelMap: { [key: string]: number } = {
        'low': 1,
        'medium': 2,
        'high': 3,
    };
    const numericLevel = levelMap[level.toLowerCase()] || 0;
    
    return (
        <div className="flex items-center gap-1">
            {[1, 2, 3].map(bar => (
                <div 
                    key={bar}
                    className={`h-4 w-2 rounded-sm ${bar <= numericLevel ? 'bg-green-500' : 'bg-gray-300'}`}
                />
            ))}
            <span className="text-gray-600 text-sm ml-2 capitalize">{level}</span>
        </div>
    );
};

const CriteriaBar: React.FC<{ name: string; score: number; weight: number; justification: string; onWeightChange?: (name: string, weight: number) => void }> = ({ name, score, weight, justification, onWeightChange }) => {
    return (
        <div className="mb-4 bg-gray-50 p-3 rounded-xl border border-gray-100">
            <div className="flex justify-between text-sm mb-2 items-center">
                <span className="font-semibold text-gray-800">{name}</span>
                <span className="font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">{score.toFixed(1)}/10</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                <div className="bg-gradient-to-r from-blue-500 to-green-500 h-2 rounded-full" style={{ width: `${score * 10}%` }}></div>
            </div>
            
            {onWeightChange && (
                <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs font-medium text-gray-500 w-16">Weight: {weight.toFixed(2)}</span>
                    <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.05" 
                        value={weight} 
                        onChange={(e) => onWeightChange(name, parseFloat(e.target.value))}
                        className="flex-1 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    />
                </div>
            )}
            
            <p className="text-xs text-gray-600 italic border-l-2 border-blue-200 pl-2">{justification}</p>
        </div>
    );
};

const LocationDetailView: React.FC<{ location: LocationData; onWeightChange?: (name: string, weight: number) => void }> = ({ location, onWeightChange }) => {
    const [visibleSections, setVisibleSections] = useState<string[]>([]);
    
    useEffect(() => {
        const sections = [
            'mcda_score', 'reasoning', 'criteria', 
            'demographics', 'footfall', 'radius', 'transport', 'initiatives', 'strategy'
        ];
        
        let delay = 100;
        sections.forEach(section => {
            setTimeout(() => {
                setVisibleSections(prev => [...prev, section]);
            }, delay);
            delay += 50;
        });
        
        return () => setVisibleSections([]);
    }, [location]);

    const isVisible = (id: string) => visibleSections.includes(id) ? 'opacity-100' : 'opacity-0';

    return (
        <div className="flex-1 space-y-6 min-w-0">
             <h2 className="text-xl font-bold text-blue-800">{location.name}</h2>
            
             <div className={`transition-opacity duration-300 ${isVisible('mcda_score')}`}>
                <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                    <SparklesIcon className="h-5 w-5 text-blue-600" />
                    Suitability Score
                </h3>
                <div className="flex items-center gap-4">
                    <MCDAScoreDisplay score={location.mcda_score} />
                </div>
            </div>

            <div className={`transition-opacity duration-300 ${isVisible('reasoning')}`}>
                <h3 className="font-semibold text-gray-800 mb-2">Reasoning</h3>
                <p className="text-gray-600 text-sm leading-relaxed">{location.reasoning}</p>
            </div>

            <div className={`transition-opacity duration-300 ${isVisible('criteria')}`}>
                <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                    <TrendingUpIcon className="h-5 w-5 text-blue-600" />
                    MCDA Criteria Breakdown & Weighting
                </h3>
                <p className="text-xs text-gray-500 mb-3">Adjust the weights below to see how it impacts the overall suitability score.</p>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                    {location.criteria_breakdown && location.criteria_breakdown.map((criteria, idx) => (
                        <CriteriaBar 
                            key={idx} 
                            name={criteria.name} 
                            score={criteria.score} 
                            weight={criteria.weight} 
                            justification={criteria.justification} 
                            onWeightChange={onWeightChange}
                        />
                    ))}
                </div>
            </div>

             <div className={`transition-opacity duration-300 ${isVisible('demographics')}`}>
                <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                    <UsersIcon className="h-5 w-5 text-green-600" />
                    Demographics
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">{location.demographics}</p>
            </div>

            <div className={`transition-opacity duration-300 ${isVisible('footfall')}`}>
                <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                    <TrendingUpIcon className="h-5 w-5 text-green-600" />
                    Footfall
                </h3>
                <FootfallIndicator level={location.footfall} />
            </div>
            
            <div className={`transition-opacity duration-300 ${isVisible('radius')}`}>
                <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                    <ArrowsPointingOutIcon className="h-5 w-5 text-green-600" />
                    Marketing Radius
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">{location.marketing_radius_km} km</p>
            </div>

            {location.public_transport && (
                <div className={`transition-opacity duration-300 ${isVisible('transport')}`}>
                    <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                        <BusIcon className="h-5 w-5 text-blue-600" />
                        Public Transport
                    </h3>
                    <p className="text-gray-600 text-sm leading-relaxed">{location.public_transport}</p>
                </div>
            )}

            {location.local_initiatives && (
                <div className={`transition-opacity duration-300 ${isVisible('initiatives')}`}>
                    <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                        <LeafIcon className="h-5 w-5 text-green-600" />
                        Local Initiatives
                    </h3>
                    <p className="text-gray-600 text-sm leading-relaxed">{location.local_initiatives}</p>
                </div>
            )}

             <div className={`transition-opacity duration-300 ${isVisible('strategy')}`}>
                <h3 className="font-semibold text-gray-800 mb-2">
                    Strategic Recommendation
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">{location.marketing_strategy}</p>
            </div>
        </div>
    );
};


export const DetailsPanel: React.FC<DetailsPanelProps> = ({ locations, allLocations, onClose, groundingSources, customWeights, onWeightChange }) => {
    const hasLocations = locations.length > 0;
    const isComparing = locations.length === 2;

    return (
        <div
            className={`absolute top-0 left-0 h-full bg-white/30 backdrop-blur-xl border-r border-white/20 shadow-2xl transition-all duration-300 ease-in-out z-[1000] flex flex-col
                ${hasLocations ? 'translate-x-0' : '-translate-x-full'}
                ${isComparing ? 'w-full max-w-4xl' : 'w-full max-w-md'}`}
        >
            {hasLocations && (
                <>
                    <div className="flex-shrink-0 p-6 flex justify-end items-center">
                         <button 
                            onClick={onClose} 
                            className="text-gray-500 hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded-full"
                            aria-label="Close details panel"
                        >
                            <XMarkIcon className="h-6 w-6" />
                        </button>
                    </div>
                    
                    <div className="overflow-y-auto px-6 pb-6 flex-1 flex flex-col gap-6">
                        <MCDAComparisonChart locations={locations} />
                        
                        <div className="flex gap-6">
                            {locations.map(loc => <LocationDetailView key={loc.name} location={loc} onWeightChange={onWeightChange} />)}
                        </div>

                        {groundingSources && groundingSources.length > 0 && (
                            <div className="mt-8 pt-8 border-t border-white/20">
                                <h3 className="text-lg font-bold text-blue-800 mb-4 flex items-center gap-2">
                                    <ArrowTopRightOnSquareIcon className="h-5 w-5" />
                                    Data Sources & Grounding
                                </h3>
                                <div className="grid grid-cols-1 gap-3">
                                    {groundingSources.map((source, idx) => (
                                        <a 
                                            key={idx}
                                            href={source.uri}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="p-3 bg-white/40 backdrop-blur-sm rounded-xl border border-white/20 hover:bg-white/60 transition-colors flex items-center justify-between group"
                                        >
                                            <div className="flex flex-col overflow-hidden">
                                                <span className="text-sm font-semibold text-gray-800 truncate">{source.title}</span>
                                                <span className="text-xs text-gray-500 truncate mb-1">{source.uri}</span>
                                                <div className="flex flex-wrap gap-2 mt-1">
                                                    <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-md font-medium">
                                                        Reliability: {source.reliability}
                                                    </span>
                                                    <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-md font-medium">
                                                        Retrieved: {new Date(source.retrievedAt).toLocaleDateString()}
                                                    </span>
                                                </div>
                                            </div>
                                            <ArrowTopRightOnSquareIcon className="h-4 w-4 text-gray-400 group-hover:text-blue-600 flex-shrink-0" />
                                        </a>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="mt-auto p-6 border-t border-white/20 flex-shrink-0">
                        <a 
                            href="https://stratageo.in/contact.php" 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-400"
                        >
                            Contact Stratageo for Deeper Insights
                            <ArrowTopRightOnSquareIcon className="w-5 h-5 ml-2" />
                        </a>
                    </div>
                </>
            )}
        </div>
    );
};