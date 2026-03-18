import React, { useState } from 'react';
import { XMarkIcon } from './icons';

export interface ExportOptions {
    includeMeta: boolean;
    includeSummary: boolean;
    includeMethodology: boolean;
    includeMap: boolean;
    includeLocationDetails: boolean;
    includeGrounding: boolean;
}

interface ExportOptionsModalProps {
    onClose: () => void;
    onExport: (options: ExportOptions) => void;
}

export const ExportOptionsModal: React.FC<ExportOptionsModalProps> = ({ onClose, onExport }) => {
    const [options, setOptions] = useState<ExportOptions>({
        includeMeta: true,
        includeSummary: true,
        includeMethodology: true,
        includeMap: true,
        includeLocationDetails: true,
        includeGrounding: true,
    });

    const toggleOption = (key: keyof ExportOptions) => {
        setOptions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    return (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-gray-100">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                    <h2 className="text-xl font-bold text-blue-800">Export Report Options</h2>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-gray-200 rounded-full transition-colors"
                    >
                        <XMarkIcon className="h-5 w-5 text-gray-500" />
                    </button>
                </div>
                
                <div className="p-6 space-y-4">
                    <p className="text-sm text-gray-600 mb-4">Select the sections you want to include in your professional suitability report.</p>
                    
                    <div className="space-y-3">
                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeMeta} 
                                onChange={() => toggleOption('includeMeta')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">Analysis Context</span>
                                <span className="text-xs text-gray-500">Business type and target location info</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeSummary} 
                                onChange={() => toggleOption('includeSummary')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">Executive Summary</span>
                                <span className="text-xs text-gray-500">AI-generated overview of the analysis</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeMethodology} 
                                onChange={() => toggleOption('includeMethodology')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">MCDA Methodology</span>
                                <span className="text-xs text-gray-500">Explanation of the scoring system</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeMap} 
                                onChange={() => toggleOption('includeMap')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">Map Visual</span>
                                <span className="text-xs text-gray-500">Snapshot of the interactive map</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeLocationDetails} 
                                onChange={() => toggleOption('includeLocationDetails')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">Detailed Site Analysis</span>
                                <span className="text-xs text-gray-500">Breakdown for each identified location</span>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors group">
                            <input 
                                type="checkbox" 
                                checked={options.includeGrounding} 
                                onChange={() => toggleOption('includeGrounding')}
                                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <div className="flex flex-col">
                                <span className="font-semibold text-gray-800 group-hover:text-blue-700">Data Sources</span>
                                <span className="text-xs text-gray-500">Grounding sources and reliability info</span>
                            </div>
                        </label>
                    </div>
                </div>
                
                <div className="p-6 bg-gray-50 border-t border-gray-100 flex gap-3">
                    <button 
                        onClick={onClose}
                        className="flex-1 py-3 px-4 rounded-xl border border-gray-200 text-gray-700 font-semibold hover:bg-white transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={() => onExport(options)}
                        className="flex-2 py-3 px-4 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-500 transition-colors shadow-lg shadow-blue-200"
                    >
                        Generate PDF
                    </button>
                </div>
            </div>
        </div>
    );
};
