
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
    className={`group relative p-6 rounded-[2.5rem] border-2 transition-all duration-500 text-right flex flex-col gap-3 active:scale-[0.97] overflow-hidden ${
      isSelected 
        ? 'border-emerald-500 bg-emerald-50/30 shadow-[0_20px_50px_-15px_rgba(16,185,129,0.3)] ring-4 ring-emerald-500/5 scale-[1.02]' 
        : 'border-white bg-white hover:border-emerald-100 shadow-sm hover:shadow-xl hover:shadow-emerald-900/5'
    }`}
  >
    {/* Visual Marker for Selection */}
    <div className={`absolute top-0 right-0 w-24 h-24 -mr-8 -mt-8 rounded-full transition-all duration-700 ${
      isSelected ? 'bg-emerald-500/10 scale-150' : 'bg-slate-50 scale-0 group-hover:scale-100'
    }`} />
    
    <div className="flex justify-between items-center w-full relative z-10">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black transition-all duration-500 ${
        isSelected ? 'bg-emerald-600 text-white rotate-[15deg] shadow-lg shadow-emerald-600/20' : 'bg-emerald-50 text-emerald-600'
      }`}>
        {surah.id}
      </div>
      <div className="flex flex-col items-end">
        <span className={`quran-font text-3xl font-bold transition-all duration-500 ${
          isSelected ? 'text-emerald-900' : 'text-slate-800'
        }`}>{surah.name}</span>
        <span className={`text-[10px] font-black uppercase tracking-[0.2em] mt-1 transition-all duration-500 ${
          isSelected ? 'text-emerald-600' : 'text-slate-400'
        }`}>
          {surah.transliteration}
        </span>
      </div>
    </div>

    <div className={`flex justify-between items-center w-full mt-2 pt-4 border-t transition-colors duration-500 relative z-10 ${
      isSelected ? 'border-emerald-200' : 'border-slate-50'
    }`}>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isSelected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-200'}`} />
        <span className={`text-xs font-black ${isSelected ? 'text-emerald-700' : 'text-slate-500'}`}>
          {surah.versesCount} آية
        </span>
      </div>
      
      {isSelected && (
        <div className="flex items-center gap-1 bg-emerald-600 text-white px-3 py-1 rounded-full text-[10px] font-black shadow-md animate-in fade-in slide-in-from-left-2">
          <span>تم الاختيار</span>
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
    <div className="flex flex-col h-screen max-w-md mx-auto bg-[#F7F9FB] overflow-hidden relative shadow-[0_0_100px_rgba(0,0,0,0.1)]">
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-emerald-50 to-transparent pointer-events-none"></div>
      
      <div className="h-safe-top bg-emerald-900 w-full shrink-0"></div>

      {/* Install Guide Modal */}
      {showInstallGuide && (
        <div className="absolute inset-0 z-50 bg-emerald-950/40 backdrop-blur-md flex items-center justify-center p-6">
          <div className="bg-white rounded-[3.5rem] p-8 w-full max-w-sm shadow-2xl border border-emerald-50 animate-in zoom-in-95 duration-500">
            <div className="w-24 h-24 bg-emerald-50 rounded-[2.5rem] flex items-center justify-center mx-auto mb-8 shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h3 className="text-3xl font-black text-emerald-900 text-center mb-8">تحويل لـ APK</h3>
            <div className="space-y-4 text-right">
              {[
                { n: 1, t: "افتح الرابط في متصفح Chrome" },
                { n: 2, t: "اضغط على زر القائمة (3 نقاط)" },
                { n: 3, t: "اختر 'تثبيت التطبيق' للوصول السريع" }
              ].map(step => (
                <div key={step.n} className="flex gap-4 items-center bg-slate-50 p-5 rounded-3xl border border-slate-100/50">
                  <span className="text-sm text-slate-700 font-bold flex-1">{step.t}</span>
                  <div className="w-8 h-8 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 text-xs font-black shadow-lg shadow-emerald-600/20">{step.n}</div>
                </div>
              ))}
            </div>
            <button 
              onClick={() => setShowInstallGuide(false)}
              className="w-full mt-10 py-6 bg-emerald-600 text-white rounded-[2rem] font-black text-xl shadow-2xl shadow-emerald-600/30 active:scale-95 transition-transform"
            >
              فهمت ذلك
            </button>
          </div>
        </div>
      )}

      <header className="bg-emerald-900 text-white p-6 pb-14 rounded-b-[5rem] z-30 shadow-[0_20px_60px_-15px_rgba(6,95,70,0.4)] relative overflow-hidden shrink-0">
        <div className="absolute top-[-20%] right-[-10%] w-72 h-72 bg-emerald-400/10 rounded-full blur-[100px]"></div>
        <div className="absolute bottom-[-10%] left-[-5%] w-48 h-48 bg-emerald-500/10 rounded-full blur-[80px]"></div>
        
        <div className="flex justify-between items-center mb-10 relative z-10">
          <button onClick={() => setShowInstallGuide(true)} className="p-3.5 bg-white/10 rounded-[1.5rem] active:scale-90 transition-all border border-white/10 backdrop-blur-md">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-3xl font-black tracking-tightest">حافظ برو</h1>
            <div className="flex items-center justify-center gap-2 mt-1.5 bg-white/10 px-3 py-1 rounded-full backdrop-blur-md border border-white/5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
              <p className="text-[10px] text-emerald-100 font-black uppercase tracking-[0.3em]">Smart Companion</p>
            </div>
          </div>
          <button 
            onClick={handleInstallClick}
            className={`p-3.5 rounded-[1.5rem] transition-all border border-white/10 backdrop-blur-md ${installPrompt ? 'bg-emerald-500 shadow-xl shadow-emerald-500/40 animate-bounce' : 'bg-white/10'}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-4 relative z-10 px-2">
            <div className="relative group">
              <input 
                type="text" placeholder="ابحث عن السورة..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-emerald-950/30 border border-white/10 rounded-[2rem] py-5 pr-14 pl-6 text-white placeholder-emerald-100/30 focus:outline-none focus:bg-emerald-950/50 focus:ring-4 focus:ring-emerald-500/20 transition-all text-right text-lg font-bold backdrop-blur-xl"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 absolute right-5 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-6 bg-emerald-950/40 p-7 rounded-[3.5rem] backdrop-blur-3xl border border-white/10 shadow-inner relative z-10 mx-2">
            <div className="w-20 h-20 rounded-[2.5rem] bg-emerald-600 flex items-center justify-center shadow-2xl relative overflow-hidden group border-2 border-white/20">
              <span className="quran-font text-5xl group-hover:scale-110 transition-transform duration-500">📖</span>
              <div className="absolute inset-0 bg-gradient-to-tr from-emerald-400/20 to-transparent"></div>
              <div className="absolute bottom-0 left-0 right-0 bg-white/40 transition-all duration-200" style={{ height: `${Math.min(audioLevel * 3, 100)}%` }}></div>
            </div>
            <div className="flex-1 text-right">
              <p className="text-[10px] text-emerald-300 uppercase tracking-[0.3em] font-black mb-1.5 opacity-80">نظام المراجعة النشط</p>
              <p className="font-bold text-3xl text-white drop-shadow-lg">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-10 no-scrollbar relative" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-8">
            <div className="flex justify-between items-center px-2">
              <h2 className="text-slate-900 font-black text-2xl tracking-tight">اختر السورة</h2>
              <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
                <span className="text-xs font-black text-emerald-600">{filteredSurahs.length}</span>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">سورة</span>
              </div>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-40">
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
              <div className="flex flex-col items-center justify-center py-32 text-slate-300 gap-6">
                <div className="w-24 h-24 bg-white rounded-full flex items-center justify-center shadow-sm border border-slate-100">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <p className="font-bold text-slate-400">لم نعثر على سورة بهذا الاسم</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-40 text-slate-300 gap-10">
                <div className="relative group">
                  <div className="w-40 h-40 bg-white rounded-[4rem] flex items-center justify-center shadow-[0_30px_60px_-12px_rgba(0,0,0,0.08)] border border-slate-50 relative z-10 group-hover:scale-105 transition-transform duration-500">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-emerald-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-2 rounded-2xl text-xs font-black shadow-xl z-20 whitespace-nowrap">جاري الاستماع...</div>
                </div>
                <div className="text-center px-10">
                  <p className="font-black text-slate-800 text-2xl tracking-tight">تفضل بالقراءة الآن</p>
                  <p className="text-sm text-slate-400 mt-3 font-medium leading-relaxed">سأقوم بتصحيح مخارج الحروف والآيات فوراً كما يفعل الشيخ تماماً</p>
                </div>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`max-w-[90%] p-7 rounded-[3rem] shadow-2xl transition-all duration-500 transform animate-in slide-in-from-bottom-5 ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-slate-800 rounded-tr-none border-r-8 border-emerald-500 shadow-emerald-900/5' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? 'bg-rose-600 ring-[12px] ring-rose-50 animate-shake shadow-rose-900/20' : 'bg-emerald-900 shadow-emerald-950/40'}`
                }`}
              >
                <div className="flex justify-between items-center mb-3 opacity-60">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em]">
                    {msg.type === 'user' ? 'تلاوتك' : (msg.isError ? 'تنبيه الخطأ ⚠️' : 'تصحيح المعلم ✅')}
                  </span>
                </div>
                <p className={`${msg.type === 'user' ? 'quran-font text-4xl' : 'text-lg font-bold'} text-right leading-relaxed`}>
                  {msg.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="p-8 pb-14 bg-white/80 backdrop-blur-3xl rounded-t-[5rem] border-t border-slate-100 shadow-[0_-20px_80px_rgba(0,0,0,0.08)] relative z-40 shrink-0">
        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation} disabled={!selectedSurah}
            className={`w-full py-7 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-5 transition-all active:scale-[0.96] group relative overflow-hidden ${
              selectedSurah 
                ? 'bg-emerald-600 text-white shadow-[0_25px_50px_-12px_rgba(16,185,129,0.4)]' 
                : 'bg-slate-100 text-slate-300'
            }`}
          >
            {selectedSurah && (
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-500"></div>
            )}
            <div className={`p-3 rounded-2xl transition-all duration-500 ${selectedSurah ? 'bg-emerald-500 shadow-inner' : 'bg-slate-200'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span className="drop-shadow-md">ابدأ المراجعة الآن</span>
          </button>
        ) : (
          <div className="space-y-8">
            <div className="flex justify-between items-center px-6">
               <div className="flex gap-2.5 items-end h-10">
                 {[...Array(15)].map((_, i) => (
                   <div 
                    key={i} 
                    className={`w-2 rounded-full transition-all duration-300 ${i < (audioLevel / 6) ? 'bg-emerald-600 h-10 shadow-[0_0_20px_rgba(16,185,129,0.5)]' : 'bg-slate-200 h-2'}`}
                   ></div>
                 ))}
               </div>
               <div className="text-right">
                 <p className="text-[12px] text-emerald-600 font-black tracking-[0.2em] animate-pulse">نظام نشط</p>
                 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tighter">Gemini AI Engine</p>
               </div>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-7 bg-rose-50 text-rose-600 border-4 border-rose-100 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-5 active:scale-[0.96] transition-all shadow-xl hover:bg-rose-100 shadow-rose-900/5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إنهاء الجلسة
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
          animation-iteration-count: 3;
        }
        .h-safe-top { height: env(safe-area-inset-top, 24px); }
        @media (max-width: 480px) {
          .rounded-b-[5rem] { border-bottom-left-radius: 4rem; border-bottom-right-radius: 4rem; }
          .rounded-t-[5rem] { border-top-left-radius: 4rem; border-top-right-radius: 4rem; }
        }
        .tracking-tightest { tracking-spacing: -0.05em; }
        .quran-font { line-height: 1.4; }
      `}</style>
    </div>
  );
};

export default App;
