
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SURAHS, SYSTEM_INSTRUCTION } from './constants';
import { Surah, RecitationMessage, AppState } from './types';
import { decode, encode, decodeAudioData, createPcmBlob } from './services/audioUtils';

const SurahCard: React.FC<{ 
  surah: Surah; 
  onSelect: (s: Surah) => void;
  isSelected: boolean;
}> = ({ surah, onSelect, isSelected }) => (
  <button 
    onClick={() => onSelect(surah)}
    className={`group relative p-5 rounded-[2.5rem] border-2 transition-all duration-300 text-right flex flex-col gap-2 active:scale-[0.98] overflow-hidden ${
      isSelected 
        ? 'border-emerald-600 bg-emerald-50/60 shadow-xl ring-4 ring-emerald-600/5' 
        : 'border-white bg-white/80 hover:border-emerald-100 shadow-sm'
    }`}
  >
    <div className="flex justify-between items-center w-full relative z-10">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black transition-all ${
        isSelected ? 'bg-emerald-600 text-white rotate-12' : 'bg-emerald-50 text-emerald-600'
      }`}>
        {surah.id}
      </div>
      <div className="flex flex-col items-end">
        <span className={`quran-font text-2xl font-bold transition-all ${
          isSelected ? 'text-emerald-900' : 'text-slate-800'
        }`}>{surah.name}</span>
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
          {surah.transliteration}
        </span>
      </div>
    </div>

    <div className={`flex justify-between items-center w-full mt-2 pt-3 border-t transition-colors ${
      isSelected ? 'border-emerald-200' : 'border-slate-100'
    }`}>
      <span className={`text-[11px] font-black ${isSelected ? 'text-emerald-700' : 'text-slate-500'}`}>
        {surah.versesCount} آية
      </span>
      {isSelected && (
        <div className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-1 rounded-full text-[10px] font-black animate-in fade-in zoom-in">
          <span>مختارة</span>
        </div>
      )}
    </div>
  </button>
);

const App: React.FC = () => {
  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [messages, setMessages] = useState<RecitationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const sessionErrorsRef = useRef<{type: string, text: string, timestamp: number}[]>([]);

  useEffect(() => {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    });
  }, []);

  const handleInstallClick = () => {
    if (installPrompt) {
      installPrompt.prompt();
      installPrompt.userChoice.then((choice: any) => {
        if (choice.outcome === 'accepted') setInstallPrompt(null);
      });
    } else {
      setShowInstallGuide(true);
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

  const filteredSurahs = useMemo(() => {
    return SURAHS.filter(s => 
      s.name.includes(searchQuery) || 
      s.transliteration.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toString() === searchQuery
    );
  }, [searchQuery]);

  const stopRecitation = useCallback(async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (inputAudioContextRef.current) {
      await inputAudioContextRef.current.close();
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();

    if (appState === AppState.RECITING) {
      console.log(`%c[ملخص الجلسة] سورة: ${selectedSurah?.name}`, 'color: #10b981; font-weight: bold;');
      if (sessionErrorsRef.current.length > 0) console.table(sessionErrorsRef.current);
    }

    setAppState(AppState.IDLE);
    setAudioLevel(0);
  }, [selectedSurah, appState]);

  const startRecitation = async () => {
    if (!selectedSurah) return;
    try {
      setAppState(AppState.PREPARING);
      setError(null);
      setMessages([]);
      sessionErrorsRef.current = [];
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const analyser = inputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `${SYSTEM_INSTRUCTION}\nأنت تسمع الآن سورة ${selectedSurah.name}. كن يقظاً جداً وتابع الآيات واحدة بواحدة.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setAppState(AppState.RECITING);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            source.connect(analyser);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            const updateLevel = () => {
              if (appState === AppState.IDLE) return;
              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              analyser.getByteFrequencyData(dataArray);
              setAudioLevel(dataArray.reduce((a, b) => a + b) / dataArray.length);
              requestAnimationFrame(updateLevel);
            };
            updateLevel();
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              sessionPromise.then(session => session.sendRealtimeInput({ media: createPcmBlob(inputData) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = outputAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
            if (message.serverContent?.inputTranscription) {
              currentInputText.current += message.serverContent.inputTranscription.text;
              setMessages(p => [...p.filter(m => m.id !== 'live-input'), { id: 'live-input', type: 'user', text: currentInputText.current, timestamp: Date.now() }]);
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputText.current += message.serverContent.outputTranscription.text;
              const isTajweedErr = currentOutputText.current.includes('تنبيه تجويد');
              const isHifzErr = currentOutputText.current.includes('تنبيه حفظ') || currentOutputText.current.includes('خطأ');
              const isErr = isTajweedErr || isHifzErr;
              if (isErr && navigator.vibrate) navigator.vibrate([200, 100, 200]);
              setMessages(p => [...p.filter(m => m.id !== 'live-output'), { 
                id: 'live-output', 
                type: 'bot', 
                text: currentOutputText.current, 
                timestamp: Date.now(), 
                isError: isErr,
                isTajweed: isTajweedErr 
              }]);
            }
            if (message.serverContent?.turnComplete) {
              const text = currentOutputText.current;
              if (text.includes('تنبيه')) {
                sessionErrorsRef.current.push({ type: text.includes('تجويد') ? 'Tajweed' : 'Hifz', text, timestamp: Date.now() });
              }
              currentInputText.current = '';
              currentOutputText.current = '';
            }
          },
          onerror: () => stopRecitation(),
          onclose: () => setAppState(AppState.IDLE)
        }
      });
    } catch (err) {
      setError("يجب السماح بالميكروفون.");
      setAppState(AppState.IDLE);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-[#F8FBFF] overflow-hidden relative shadow-[0_0_100px_rgba(0,0,0,0.1)]">
      {/* Decorative Background Patterns */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/islamic-art.png")' }}></div>
      <div className="h-safe-top bg-emerald-900 w-full shrink-0"></div>

      {/* HEADER SECTION - BALANCED SPACE */}
      <header className={`bg-emerald-900 text-white transition-all duration-500 z-30 shrink-0 ${
        appState === AppState.IDLE ? 'p-6 rounded-b-[4rem] pb-10 shadow-[0_10px_40px_-10px_rgba(6,95,70,0.4)]' : 'p-6 pb-12 rounded-b-[5rem]'
      }`}>
        <div className="flex justify-between items-center mb-8">
          <button onClick={() => setShowInstallGuide(true)} className="p-3 bg-white/10 rounded-2xl active:scale-90 transition-all border border-white/10 backdrop-blur-md">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-3xl font-black tracking-tight leading-none">حافظ برو</h1>
            <div className="flex items-center justify-center gap-1.5 mt-1.5 opacity-60">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse"></div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em]">تسميع ذكي</p>
            </div>
          </div>
          <button onClick={handleInstallClick} className={`p-3 rounded-2xl border border-white/10 transition-all ${installPrompt ? 'bg-emerald-500 shadow-lg animate-bounce' : 'bg-white/10'}`}>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="relative group px-2">
            <input 
              type="text" placeholder="ابحث عن السورة أو رقمها..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-emerald-950/40 border border-white/10 rounded-[1.75rem] py-4.5 pr-14 pl-6 text-white placeholder-emerald-100/30 focus:outline-none transition-all text-right text-lg font-bold backdrop-blur-2xl shadow-inner"
            />
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 absolute right-7 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        ) : (
          <div className="flex items-center gap-6 bg-emerald-950/40 p-6 rounded-[3rem] backdrop-blur-3xl border border-white/10 mx-2 shadow-2xl">
            <div className="w-20 h-20 rounded-[2rem] bg-emerald-600 flex items-center justify-center relative overflow-hidden shrink-0 border-2 border-white/20 shadow-xl">
              <span className="text-4xl">📖</span>
              <div className="absolute bottom-0 left-0 right-0 bg-white/40 transition-all duration-200" style={{ height: `${Math.min(audioLevel * 4, 100)}%` }}></div>
            </div>
            <div className="flex-1 text-right">
              <span className="text-[11px] text-amber-400 font-black uppercase tracking-widest block mb-1.5 animate-pulse">يسمعك الآن..</span>
              <p className="font-bold text-3xl text-white drop-shadow-lg">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      {/* CONTENT AREA - SPACIOUS FOR LISTING */}
      <main className="flex-1 overflow-y-auto px-6 py-6 no-scrollbar relative" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-8">
            <div className="flex justify-between items-center px-2">
               <h2 className="text-emerald-900 font-black text-xl tracking-tight">اختر سورة للمراجعة</h2>
               <div className="flex items-center gap-2 bg-emerald-50 px-4 py-1.5 rounded-full border border-emerald-100">
                <span className="text-[10px] font-black text-emerald-700 uppercase tracking-widest">{filteredSurahs.length} سورة</span>
               </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-40">
              {filteredSurahs.map(surah => (
                <SurahCard key={surah.id} surah={surah} isSelected={selectedSurah?.id === surah.id} onSelect={setSelectedSurah} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8 pb-10">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-slate-400 gap-8 text-center animate-in fade-in duration-1000">
                <div className="relative">
                  <div className="w-40 h-40 bg-white rounded-[4rem] flex items-center justify-center shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] border-4 border-emerald-50 relative z-10">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-emerald-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <div className="absolute -inset-4 bg-emerald-100/50 rounded-[4.5rem] animate-ping opacity-20"></div>
                </div>
                <div className="space-y-3 px-10">
                  <p className="font-black text-2xl text-emerald-950">تفضل بالبدء</p>
                  <p className="text-sm text-slate-500 leading-relaxed">اقرأ آية آية بتمهل، وسأقوم بتصحيحك فوراً عند أي خطأ.</p>
                </div>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`max-w-[90%] p-6 rounded-[3rem] shadow-xl transition-all animate-in slide-in-from-bottom-4 duration-500 ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-emerald-950 rounded-tr-none border-r-[8px] border-emerald-500' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? ( (msg as any).isTajweed ? 'bg-amber-600 ring-[10px] ring-amber-50 animate-shake' : 'bg-rose-600 ring-[10px] ring-rose-50 animate-shake' ) : 'bg-emerald-900 shadow-emerald-950/20'}`
                }`}
              >
                <div className="flex justify-between items-center mb-2 opacity-50">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em]">
                    {msg.type === 'user' ? 'تلاوتك' : ( (msg as any).isTajweed ? 'تنبيه تجويد ⚖️' : (msg.isError ? 'تنبيه حفظ ⚠️' : 'تصحيح 💬') )}
                  </span>
                </div>
                <p className={`${msg.type === 'user' ? 'quran-font text-3xl' : 'text-base font-bold'} text-right leading-relaxed`}>
                  {msg.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* FOOTER SECTION - RESTORED & BEAUTIFIED */}
      <footer className={`bg-white/90 backdrop-blur-3xl border-t border-emerald-50 z-40 shrink-0 transition-all duration-500 ${
        appState === AppState.IDLE ? 'p-6 pb-12 rounded-t-[4rem] shadow-[0_-20px_60px_rgba(0,0,0,0.05)]' : 'p-8 pb-14 rounded-t-[5rem]'
      }`}>
        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation} disabled={!selectedSurah}
            className={`w-full py-7 rounded-[2.25rem] font-black text-2xl flex items-center justify-center gap-6 transition-all active:scale-95 shadow-2xl relative overflow-hidden group ${
              selectedSurah ? 'bg-emerald-600 text-white shadow-emerald-600/40' : 'bg-slate-100 text-slate-300'
            }`}
          >
            {selectedSurah && (
               <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out"></div>
            )}
            <div className={`p-4 rounded-[1.5rem] transition-all ${selectedSurah ? 'bg-emerald-500 shadow-inner' : 'bg-slate-200'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span className="relative z-10">ابدأ التسميع الآن</span>
          </button>
        ) : (
          <div className="space-y-8">
            <div className="flex justify-between items-center px-6">
               <div className="flex gap-2 items-end h-10">
                 {[...Array(15)].map((_, i) => (
                   <div key={i} className={`w-2 rounded-full transition-all duration-300 ${i < (audioLevel / 6) ? 'bg-emerald-600 h-10 shadow-lg shadow-emerald-600/30' : 'bg-slate-200 h-2'}`}></div>
                 ))}
               </div>
               <div className="text-right">
                 <p className="text-[12px] text-emerald-600 font-black tracking-widest animate-pulse">يتم الرصد الفوري..</p>
                 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest opacity-60">نظام التصحيح التفاعلي</p>
               </div>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-6 bg-rose-50 text-rose-600 border-[3px] border-rose-100 rounded-[2.25rem] font-black text-2xl flex items-center justify-center gap-5 active:scale-95 transition-all shadow-xl"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إنهاء التسميع
            </button>
          </div>
        )}
      </footer>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-8px); }
          75% { transform: translateX(8px); }
        }
        .animate-shake {
          animation: shake 0.15s cubic-bezier(.36,.07,.19,.97) both;
          animation-iteration-count: 2;
        }
        .h-safe-top { height: env(safe-area-inset-top, 24px); }
        .quran-font { line-height: 1.5; }
        ::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
};

export default App;
