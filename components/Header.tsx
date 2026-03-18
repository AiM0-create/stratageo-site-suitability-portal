import React from 'react';
import { ArrowDownTrayIcon } from './icons';

interface HeaderProps {
    onHelpClick: () => void;
    onExportPDF: () => void;
    isExportEnabled: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onHelpClick, onExportPDF, isExportEnabled }) => {
    return (
        <header className="bg-white/50 backdrop-blur-md border-b border-white/30 px-4 py-2 flex-shrink-0 flex justify-between items-center z-10">
            <button 
                onClick={onHelpClick} 
                className="text-xl font-bold tracking-wider transition-all duration-200 ease-in-out hover:opacity-80 transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-500 rounded-lg"
                aria-label="Show help guide"
            >
                <span className="text-blue-800">STRATA</span>
                <span className="text-green-600">GEO</span>
            </button>

            {isExportEnabled && (
                <button
                    id="export-tour-target"
                    onClick={onExportPDF}
                    className="flex items-center gap-2 bg-green-600 text-white font-semibold px-4 py-2 rounded-lg hover:bg-green-500 transition-colors text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-400"
                >
                    <ArrowDownTrayIcon className="h-5 w-5" />
                    <span>Export to PDF</span>
                </button>
            )}
        </header>
    );
};