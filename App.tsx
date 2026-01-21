
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
    className={`group relative p-5 rounded-[2.5rem] border-2 transition-all duration-300 text-right flex flex-col gap-2 active:scale-95 ripple overflow-hidden ${
      isSelected 
        ? 'border-emerald-500 bg-white shadow-[0_20px_40px_-15px_rgba(16,185,129,0.25)] ring-4 ring-emerald-500/10' 
        : 'border-slate-100 bg-white hover:border-emerald-200 shadow-sm hover:shadow-md'
    }`}
  >
    {/* Background Accent for Selected State */}
    {isSelected && (
      <div className="absolute top-0 left-0 w-1.5 h-full bg-emerald-500 rounded-r-full" />
    )}
    
    <div className="flex justify-between items-start w-full">
      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-black transition-colors ${
        isSelected ? 'bg-emerald-500 text-white' : 'bg-slate-50 text-slate-400 group-hover:bg-emerald-50 group-hover:text-emerald-600'
      }`}>
        {surah.id}
      </div>
      <div className="flex flex-col items-end">
        <span className={`quran-font text-2xl font-bold transition-colors ${
          isSelected ? 'text-emerald-700' : 'text-slate-800'
        }`}>{surah.name}</span>
        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
          {surah.transliteration}
        </span>
      </div>
    </div>

    <div className="flex justify-between items-center w-full mt-3 pt-3 border-t border-slate-50">
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-200'}`} />
        <span className={`text-[10px] font-black ${isSelected ? 'text-emerald-600' : 'text-slate-400'}`}>
          {surah.versesCount} آية
        </span>
      </div>
      {isSelected && (
        <div className="bg-emerald-500 text-white p-1 rounded-full shadow-lg shadow-emerald-500/30">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
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
    setAppState(AppState.IDLE);
    setAudioLevel(0);
  }, []);

  const startRecitation = async () => {
    if (!selectedSurah) return;
    try {
      setAppState(AppState.PREPARING);
      setError(null);
      setMessages([]);
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
          systemInstruction: `${SYSTEM_INSTRUCTION}\nالمستخدم يسمع سورة ${selectedSurah.name}. كن يقظاً جداً لأي خطأ.`,
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
              const isErr = currentOutputText.current.includes('تنبيه') || currentOutputText.current.includes('خطأ');
              if (isErr && navigator.vibrate) navigator.vibrate([200, 100, 200]);
              setMessages(p => [...p.filter(m => m.id !== 'live-output'), { id: 'live-output', type: 'bot', text: currentOutputText.current, timestamp: Date.now(), isError: isErr }]);
            }
            if (message.serverContent?.turnComplete) {
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
    <div className="flex flex-col h-screen max-w-md mx-auto bg-slate-50 overflow-hidden relative shadow-2xl">
      <div className="h-safe-top bg-emerald-900 w-full shrink-0"></div>

      {/* Install Guide Modal */}
      {showInstallGuide && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-white rounded-[3rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
            <div className="w-20 h-20 bg-emerald-100 rounded-3xl flex items-center justify-center mx-auto mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h3 className="text-2xl font-black text-emerald-900 text-center mb-6">تثبيت حافظ برو</h3>
            <div className="space-y-4 text-right">
              {[
                { n: 1, t: "افتح الرابط في Chrome على الأندرويد" },
                { n: 2, t: "اضغط على القائمة (3 نقاط)" },
                { n: 3, t: "اختر 'تثبيت التطبيق' للوصول السريع" }
              ].map(step => (
                <div key={step.n} className="flex gap-4 items-center bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <span className="text-sm text-slate-700 font-bold">{step.t}</span>
                  <div className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0 text-xs font-black">{step.n}</div>
                </div>
              ))}
            </div>
            <button 
              onClick={() => setShowInstallGuide(false)}
              className="w-full mt-8 py-5 bg-emerald-600 text-white rounded-2xl font-black shadow-lg shadow-emerald-600/20 active:scale-95 transition-transform"
            >
              حسناً، فهمت
            </button>
          </div>
        </div>
      )}

      <header className="bg-emerald-900 text-white p-6 pb-12 rounded-b-[4.5rem] z-30 shadow-2xl relative overflow-hidden shrink-0">
        <div className="absolute top-[-50%] right-[-20%] w-64 h-64 bg-emerald-400/10 rounded-full blur-[100px]"></div>
        
        <div className="flex justify-between items-center mb-8 relative z-10">
          <button onClick={() => setShowInstallGuide(true)} className="p-3 bg-white/10 rounded-2xl active:scale-90 transition-all">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-2xl font-black tracking-tighter">حافظ برو</h1>
            <div className="flex items-center justify-center gap-1.5 mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
              <p className="text-[10px] text-emerald-300 font-black uppercase tracking-widest">Al-Mu'allem AI</p>
            </div>
          </div>
          <button 
            onClick={handleInstallClick}
            className={`p-3 rounded-2xl transition-all ${installPrompt ? 'bg-emerald-500 shadow-lg shadow-emerald-500/40' : 'bg-white/10'}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-4 relative z-10">
            <div className="relative group">
              <input 
                type="text" placeholder="ابحث عن السورة (اسم أو رقم)..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-3xl py-4.5 pr-14 pl-6 text-white placeholder-emerald-200/40 focus:outline-none focus:bg-white/15 focus:ring-4 focus:ring-emerald-500/20 transition-all text-right text-base font-bold"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 absolute right-5 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-6 bg-emerald-950/30 p-6 rounded-[3rem] backdrop-blur-3xl border border-white/10 shadow-inner relative z-10">
            <div className="w-16 h-16 rounded-[2rem] bg-emerald-500 flex items-center justify-center shadow-2xl relative overflow-hidden group">
              <span className="quran-font text-4xl group-hover:scale-110 transition-transform">📖</span>
              <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
              <div className="absolute bottom-0 left-0 right-0 bg-white/50 transition-all duration-150" style={{ height: `${Math.min(audioLevel * 2.5, 100)}%` }}></div>
            </div>
            <div className="flex-1 text-right">
              <p className="text-[10px] text-emerald-300 uppercase tracking-widest font-black mb-1">جلسة تسميع نشطة</p>
              <p className="font-bold text-2xl text-white">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-5 py-8 no-scrollbar bg-slate-50 relative" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-6">
            <div className="flex justify-between items-center px-2">
              <h2 className="text-slate-800 font-black text-xl">قائمة السور</h2>
              <span className="text-[10px] font-black bg-slate-200 text-slate-500 px-3 py-1 rounded-full uppercase tracking-widest">
                {filteredSurahs.length} متوفرة
              </span>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pb-32">
              {filteredSurahs.map(surah => (
                <SurahCard 
                  key={surah.id} 
                  surah={surah} 
                  isSelected={selectedSurah?.id === surah.id} 
                  onSelect={setSelectedSurah} 
                />
              ))}
            </div>
            
            {filteredSurahs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 opacity-30">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <p className="font-bold">لا توجد نتائج لبحثك</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-32 text-slate-300 gap-8">
                <div className="relative">
                  <div className="w-32 h-32 bg-white rounded-[3rem] flex items-center justify-center shadow-xl border border-slate-100">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-emerald-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <div className="absolute -bottom-2 -right-2 w-10 h-10 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-white shadow-lg">
                    <div className="w-2 h-2 bg-white rounded-full animate-ping"></div>
                  </div>
                </div>
                <div className="text-center">
                  <p className="font-black text-slate-700 text-xl tracking-tight">ابدأ التلاوة بوضوح</p>
                  <p className="text-sm text-slate-400 mt-2 font-medium">سأقوم بمتابعتك وتصحيح أي خطأ فوراً</p>
                </div>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`max-w-[90%] p-6 rounded-[2.5rem] shadow-xl transition-all duration-300 transform ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-slate-800 rounded-tr-none border-r-8 border-emerald-500' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? 'bg-rose-600 ring-8 ring-rose-50 animate-shake' : 'bg-emerald-800'}`
                }`}
              >
                <div className="flex justify-between items-center mb-2 opacity-50">
                  <span className="text-[10px] font-black uppercase tracking-widest">
                    {msg.type === 'user' ? 'تلاوتك' : (msg.isError ? 'تنبيه الخطأ' : 'المعلم')}
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

      <footer className="p-8 pb-12 bg-white rounded-t-[4.5rem] border-t border-slate-100 shadow-[0_-20px_50px_rgba(0,0,0,0.05)] relative z-40 shrink-0">
        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation} disabled={!selectedSurah}
            className={`w-full py-6 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-4 transition-all active:scale-95 group relative overflow-hidden ${
              selectedSurah 
                ? 'bg-emerald-600 text-white shadow-emerald-500/30 shadow-2xl' 
                : 'bg-slate-100 text-slate-300'
            }`}
          >
            {selectedSurah && (
              <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
            )}
            <div className={`p-2.5 rounded-2xl transition-colors ${selectedSurah ? 'bg-white/20' : 'bg-slate-200'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span>ابدأ التسميع الآن</span>
          </button>
        ) : (
          <div className="space-y-6">
            <div className="flex justify-between items-center px-4">
               <div className="flex gap-2 items-end h-8">
                 {[...Array(12)].map((_, i) => (
                   <div 
                    key={i} 
                    className={`w-1.5 rounded-full transition-all duration-150 ${i < (audioLevel / 8) ? 'bg-emerald-600 h-8 shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'bg-slate-200 h-2'}`}
                   ></div>
                 ))}
               </div>
               <div className="text-right">
                 <p className="text-[10px] text-emerald-600 font-black tracking-widest animate-pulse">النظام يسمعك</p>
                 <p className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter">AI Processing...</p>
               </div>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-6 bg-rose-50 text-rose-600 border-4 border-rose-100 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-4 active:scale-95 transition-all shadow-xl hover:bg-rose-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إنهاء التسميع
            </button>
          </div>
        )}
      </footer>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-5px); }
          75% { transform: translateX(5px); }
        }
        .animate-shake {
          animation: shake 0.2s cubic-bezier(.36,.07,.19,.97) both;
          animation-iteration-count: 2;
        }
        .h-safe-top { height: env(safe-area-inset-top, 20px); }
        @media (max-width: 480px) {
          .rounded-b-[4.5rem] { border-bottom-left-radius: 3rem; border-bottom-right-radius: 3rem; }
          .rounded-t-[4.5rem] { border-top-left-radius: 3rem; border-top-right-radius: 3rem; }
        }
      `}</style>
    </div>
  );
};

export default App;
