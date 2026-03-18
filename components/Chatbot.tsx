import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, FileAttachment } from '../types';
import { SendIcon, PlusCircleIcon, ImageIcon, PaperclipIcon, ChevronDownIcon, ChevronUpIcon } from './icons';

interface ChatbotProps {
    messages: ChatMessage[];
    onSendMessage: (text: string, file: FileAttachment | null) => void;
    isLoading: boolean;
    analysisStatus?: { message: string; progress: number };
    error: string | null;
    onNewChat: () => void;
}

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = (error) => reject(error);
  });

const renderTextWithLinks = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    if (!text.match(urlRegex)) {
        return <p className="whitespace-pre-wrap">{text}</p>;
    }

    const parts = text.split(urlRegex);
    return (
        <p className="whitespace-pre-wrap">
            {parts.map((part, index) => {
                if (part.match(urlRegex)) {
                    return (
                        <a
                            key={index}
                            href={part}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-700 font-medium underline hover:text-green-600"
                        >
                            {part}
                        </a>
                    );
                }
                return part;
            })}
        </p>
    );
};


export const Chatbot: React.FC<ChatbotProps> = ({ messages, onSendMessage, isLoading, analysisStatus, onNewChat }) => {
    const [input, setInput] = useState('');
    const [attachedFile, setAttachedFile] = useState<File | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const [displayProgress, setDisplayProgress] = useState(0);
    const [displayStatus, setDisplayStatus] = useState('Analyzing Site Suitability...');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isExpanded) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isLoading, isExpanded]);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isLoading) {
            if (analysisStatus) {
                setDisplayStatus(analysisStatus.message);
                // Smoothly transition to the new progress
                interval = setInterval(() => {
                    setDisplayProgress(prev => {
                        if (prev < analysisStatus.progress) {
                            return Math.min(analysisStatus.progress, prev + 0.5);
                        }
                        // If we are at or above target, slowly creep forward to show "life"
                        if (prev >= 98) return prev;
                        return prev + 0.05;
                    });
                }, 100);
            } else {
                // Fallback to old simulation if no status provided
                interval = setInterval(() => {
                    setDisplayProgress((prev) => {
                        if (prev >= 90) return prev;
                        const remaining = 95 - prev;
                        const increment = Math.max(0.1, remaining * 0.02); 
                        return Math.min(95, prev + increment);
                    });
                }, 200);
            }
        } else {
            setDisplayProgress(0);
            setDisplayStatus('Analyzing Site Suitability...');
        }
        return () => clearInterval(interval);
    }, [isLoading, analysisStatus]);

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files && event.target.files[0]) {
            setAttachedFile(event.target.files[0]);
        }
    };

    const handleSend = useCallback(async () => {
        const trimmedInput = input.trim();
        if (trimmedInput === '' && !attachedFile) return;

        let fileAttachment: FileAttachment | null = null;
        if (attachedFile) {
            const base64 = await fileToBase64(attachedFile);
            fileAttachment = {
                name: attachedFile.name,
                base64,
                mimeType: attachedFile.type,
            };
        }

        onSendMessage(trimmedInput, fileAttachment);
        setInput('');
        setAttachedFile(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
        if (imageInputRef.current) {
            imageInputRef.current.value = "";
        }
    }, [input, attachedFile, onSendMessage]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    };
    
    return (
        <div id="chatbot-tour-target" className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[95%] md:w-full max-w-3xl">
            <div className={`bg-white/30 backdrop-blur-xl border border-white/20 rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all duration-300 ${isExpanded ? 'max-h-[60vh] md:max-h-[85vh]' : 'max-h-16'}`}>
                <div 
                    className="p-4 border-b border-white/20 flex justify-between items-center cursor-pointer flex-shrink-0"
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="flex items-center gap-4">
                        <h2 className="font-bold text-blue-800 text-sm md:text-base">
                            Stratageo Site Suitability Agent
                        </h2>
                         <button onClick={(e) => { e.stopPropagation(); onNewChat(); }} className="text-xs text-blue-700 font-semibold hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded">New Chat</button>
                    </div>

                    <button className="text-gray-500 hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded-full" aria-label={isExpanded ? 'Collapse chat' : 'Expand chat'}>
                        {isExpanded ? <ChevronDownIcon className="h-6 w-6" /> : <ChevronUpIcon className="h-6 w-6" />}
                    </button>
                </div>
                
                <div className="flex-1 p-4 overflow-y-auto space-y-4" aria-live="polite">
                    {messages.map((msg) => (
                        <div key={msg.id} className={`flex items-end gap-2 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                             {msg.sender === 'ai' && <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-700 to-green-500 flex-shrink-0"></div>}
                            <div className={`max-w-xl p-3 rounded-2xl ${msg.sender === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white/40 backdrop-blur-sm text-gray-800 rounded-bl-none'}`}>
                                {renderTextWithLinks(msg.text)}
                                {msg.file && (
                                    <div className="mt-2 p-2 bg-white/40 rounded-lg flex items-center gap-2">
                                        <PaperclipIcon className="h-4 w-4 text-gray-500" />
                                        <span className="text-sm text-gray-700 truncate">{msg.file.name}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {isLoading && (
                         <div className="flex items-end gap-2 justify-start">
                           <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-700 to-green-500 flex-shrink-0"></div>
                            <div className="p-3 rounded-2xl bg-white/40 backdrop-blur-sm min-w-[200px]">
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center justify-between text-xs text-gray-600 font-medium">
                                        <span className="truncate max-w-[150px]">{displayStatus}</span>
                                        <span>{Math.round(displayProgress)}%</span>
                                    </div>
                                    <div className="w-full bg-gray-200/50 rounded-full h-1.5 overflow-hidden">
                                        <div 
                                            className="bg-gradient-to-r from-blue-500 to-green-500 h-1.5 rounded-full transition-all duration-300 ease-out" 
                                            style={{ width: `${displayProgress}%` }}
                                        ></div>
                                    </div>
                                    <div className="flex items-center justify-center space-x-1 mt-1 opacity-60">
                                        <div className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                        <div className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                        <div className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
                
                {attachedFile && (
                    <div className="px-4 pb-2">
                        <div className="p-2 bg-white/40 backdrop-blur-sm rounded-lg flex justify-between items-center text-sm">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <PaperclipIcon className="h-5 w-5 text-gray-500 flex-shrink-0"/>
                                <span className="text-gray-700 truncate">{attachedFile.name}</span>
                            </div>
                            <button onClick={() => setAttachedFile(null)} className="text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded-full">&times;</button>
                        </div>
                    </div>
                )}

                <div className="p-4 border-t border-white/20">
                    <div className="relative">
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="e.g., An eco-friendly cafe..."
                            className="w-full bg-white/40 backdrop-blur-sm rounded-xl p-3 pr-28 pl-20 text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-400 resize-none h-12 transition-all"
                            rows={1}
                        />
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleFileChange}
                                className="hidden"
                                accept=".txt,.doc,.docx,.pdf"
                            />
                            <button onClick={() => fileInputRef.current?.click()} className="text-gray-500 hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded-full" aria-label="Attach file">
                                <PlusCircleIcon className="h-6 w-6" />
                            </button>
                            <input
                                type="file"
                                ref={imageInputRef}
                                onChange={handleFileChange}
                                className="hidden"
                                accept="image/*"
                            />
                            <button onClick={() => imageInputRef.current?.click()} className="text-gray-500 hover:text-green-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded-full" aria-label="Attach image">
                                <ImageIcon className="h-6 w-6" />
                            </button>
                        </div>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <button onClick={handleSend} disabled={isLoading || (input.trim() === '' && !attachedFile)} className="bg-green-600 text-white rounded-full p-2 disabled:bg-gray-400 disabled:cursor-not-allowed hover:bg-green-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-400">
                                <SendIcon className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};