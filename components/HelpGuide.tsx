import React, { useState, useEffect, useLayoutEffect } from 'react';

interface HelpGuideProps {
    onClose: () => void;
}

type Position = 'top' | 'bottom' | 'left' | 'right' | 'center';

const steps = [
    {
        title: "Welcome to Stratageo Site Suitability Portal",
        content: "This quick guide will walk you through the key features. You can restart this tour anytime by clicking the STRATAGEO logo.",
        targetId: null, // No target for the first step
        position: 'center' as Position,
    },
    {
        title: "1. Interact with the Agent",
        content: "Use the chat window to describe your business idea (e.g., 'Cafe in Bengaluru'). You can type, upload documents, or even an image to get started.",
        targetId: 'chatbot-tour-target',
        position: 'top' as Position,
    },
    {
        title: "2. Real-World Data Analysis",
        content: "The agent will analyze real-world data from OpenStreetMap and plot the most suitable locations on the map.",
        targetId: 'map-tour-target',
        position: 'center' as Position,
    },
    {
        title: "3. Explore Locations",
        content: "Click on a marker to see a detailed MCDA (Multi-Criteria Decision Analysis) breakdown, including competitor counts, transport accessibility, and commercial density.",
        targetId: null, 
        position: 'center' as Position,
    },
    {
        title: "4. Export Comprehensive Reports",
        content: "Once the analysis is complete, you can export a professional PDF report with executive summaries and strategic recommendations.",
        targetId: 'export-tour-target',
        position: 'bottom' as Position,
    },
];

const getPopoverPosition = (targetElement: HTMLElement | null, position: Position, popoverRef: React.RefObject<HTMLDivElement>) => {
    if (!targetElement || !popoverRef.current) {
        return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', arrow: '' };
    }

    const targetRect = targetElement.getBoundingClientRect();
    const popoverRect = popoverRef.current.getBoundingClientRect();
    const buffer = 15; // Space between target and popover

    switch (position) {
        case 'top':
            return {
                top: `${targetRect.top - popoverRect.height - buffer}px`,
                left: `${targetRect.left + targetRect.width / 2 - popoverRect.width / 2}px`,
                transform: '',
                arrow: 'arrow-bottom',
            };
        case 'bottom':
            return {
                top: `${targetRect.bottom + buffer}px`,
                left: `${targetRect.left + targetRect.width / 2 - popoverRect.width / 2}px`,
                transform: '',
                arrow: 'arrow-top',
            };
        case 'left':
            return {
                top: `${targetRect.top + targetRect.height / 2 - popoverRect.height / 2}px`,
                left: `${targetRect.left - popoverRect.width - buffer}px`,
                transform: '',
                arrow: 'arrow-right',
            };
        case 'right':
             return {
                top: `${targetRect.top + targetRect.height / 2 - popoverRect.height / 2}px`,
                left: `${targetRect.right + buffer}px`,
                transform: '',
                arrow: 'arrow-left',
            };
        default: // center
            return {
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                arrow: '',
            };
    }
};


export const HelpGuide: React.FC<HelpGuideProps> = ({ onClose }) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [popoverStyle, setPopoverStyle] = useState({});
    const [arrowClass, setArrowClass] = useState('');
    const popoverRef = React.useRef<HTMLDivElement>(null);

    const step = steps[currentStep];

    useLayoutEffect(() => {
        if (!step) return;

        const targetElement = step.targetId ? document.getElementById(step.targetId) : null;
        
        const { top, left, transform, arrow } = getPopoverPosition(targetElement, step.position, popoverRef);
        setPopoverStyle({ top, left, transform });
        setArrowClass(arrow);

    }, [currentStep, step]);


    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            setCurrentStep(currentStep + 1);
        } else {
            onClose();
        }
    };

    const handlePrev = () => {
        if (currentStep > 0) {
            setCurrentStep(currentStep - 1);
        }
    };

    const isLastStep = currentStep === steps.length - 1;

    return (
        <div className="fixed inset-0 bg-black/30 z-[2000]">
            <div
                ref={popoverRef}
                style={popoverStyle}
                className="absolute bg-white/50 backdrop-blur-xl rounded-2xl shadow-2xl p-6 max-w-sm w-[90%] border border-white/30 animate-fade-in-up"
            >
                {arrowClass && <div className={`tour-arrow ${arrowClass}`}></div>}
                <h2 className="text-xl font-bold text-blue-800 mb-3">{step.title}</h2>
                <p className="text-gray-600 mb-6 text-sm leading-relaxed">{step.content}</p>

                <div className="flex justify-between items-center">
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-green-600 font-medium text-xs"
                    >
                        Skip Tour
                    </button>
                    <div className="flex items-center gap-2">
                         {currentStep > 0 && (
                            <button
                                onClick={handlePrev}
                                className="text-gray-700 hover:bg-gray-100 font-bold py-2 px-3 rounded-lg text-sm transition-colors"
                            >
                                Back
                            </button>
                         )}
                        <button
                            onClick={handleNext}
                            className="bg-green-600 hover:bg-green-500 text-white font-bold py-2 px-3 rounded-lg text-sm transition-colors"
                        >
                            {isLastStep ? 'Finish' : 'Next'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};