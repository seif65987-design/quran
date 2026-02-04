
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SURAHS, SYSTEM_INSTRUCTION_RECITATION, SYSTEM_INSTRUCTION_REFLECTION } from './constants';
import { Surah, RecitationMessage, AppState } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';

const SurahCard: React.FC<{ 
  surah: Surah; 
  onSelect: (s: Surah) => void;
  isSelected: boolean;
}> = ({ surah, onSelect, isSelected }) => (
  <button 
    onClick={() => onSelect(surah)}
    className={`group relative p-4 rounded-[1.75rem] border-2 transition-all duration-200 text-right flex flex-col gap-1 active:scale-[0.97] overflow-hidden ${
      isSelected 
        ? 'border-emerald-600 bg-emerald-50/80 shadow-md ring-2 ring-emerald-600/10' 
        : 'border-white bg-white/95 hover:border-emerald-100 shadow-sm'
    }`}
  >
    <div className="flex justify-between items-center w-full relative z-10">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-[10px] font-black transition-all ${
        isSelected ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-600'
      }`}>
        {surah.id}
      </div>
      <div className="flex flex-col items-end">
        <span className={`quran-font text-xl font-bold transition-all ${
          isSelected ? 'text-emerald-900' : 'text-slate-800'
        }`}>{surah.name}</span>
        <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">
          {surah.transliteration}
        </span>
      </div>
    </div>
    <div className={`flex justify-between items-center w-full mt-1 pt-1.5 border-t border-slate-50 transition-colors ${isSelected ? 'border-emerald-100' : ''}`}>
      <span className="text-[9px] font-black text-slate-400">{surah.versesCount} آية</span>
      {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>}
    </div>
  </button>
);

const App: React.FC = () => {
  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [messages, setMessages] = useState<RecitationMessage[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [hasKey, setHasKey] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasKey(selected);
      }
    };
    checkKey();
    return () => { stopSession(); };
  }, []);

  const handleOpenKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
    }
  };

  const scrollToEnd = useCallback(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTo({
        top: transcriptContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [messages, scrollToEnd]);

  const filteredSurahs = useMemo(() =>