
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
        ? 'border-emerald-600 bg-emerald-50/40 shadow-[0_25px_50px_-15px_rgba(5,150,105,0.2)] ring-4 ring-emerald-600/5 scale-[1.02]' 
        : 'border-white bg-white/80 backdrop-blur-sm hover:border-emerald-100 shadow-sm hover:shadow-xl hover:shadow-emerald-900/5'
    }`}
  >
    <div className={`absolute top-0 right-0 w-32 h-32 -mr-12 -mt-12 rounded-full transition-all duration-1000 blur-2xl ${
      isSelected ? 'bg-emerald-500/20 scale-150 opacity-100' : 'bg-slate-100 scale-0 opacity-0 group-hover:scale-100 group-hover:opacity-100'
    }`} />
    
    <div className="flex justify-between items-center w-full relative z-10">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black transition-all duration-500 ${
        isSelected ? 'bg-emerald-600 text-white rotate-[15deg] shadow-lg shadow-emerald-600/30' : 'bg-emerald-50 text-emerald-600'
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
      isSelected ? 'border-emerald-200' : 'border-slate-100'
    }`}>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isSelected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-200'}`} />
        <span className={`text-xs font-black ${isSelected ? 'text-emerald-700' : 'text-slate-500'}`}>
          {surah.versesCount} آية
        </span>
      </div>
      
      {isSelected && (
        <div className="flex items-center gap-1.5 bg-emerald-600 text-white px-4 py-1.5 rounded-full text-[10px] font-black shadow-lg">
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

    // Log Session Summary to Console
    if (appState === AppState.RECITING) {
      console.log(`%c[ملخص الجلسة] سورة: ${selectedSurah?.name}`, 'color: #10b981; font-weight: bold; font-size: 14px;');
      console.log(`إجمالي الأخطاء: ${sessionErrorsRef.current.length}`);
      if (sessionErrorsRef.current.length > 0) {
        console.table(sessionErrorsRef.current.map(err => ({
          'النوع': err.type,
          'التوقيت': new Date(err.timestamp).toLocaleTimeString(),
          'التنبيه': err.text
        })));
      }
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
      sessionErrorsRef.current = []; // Reset errors for new session
      
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
          systemInstruction: `${SYSTEM_INSTRUCTION}\nالمستخدم يراجع سورة ${selectedSurah.name}. كن دقيقاً جداً في أحكام التجويد.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setAppState(AppState.RECITING);
            console.log(`%c[بدء الجلسة] سورة: ${selectedSurah.name}`, 'color: #059669; font-weight: bold;');
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
              if (isErr && navigator.vibrate) navigator.vibrate([150, 50, 150]);
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
              // Track identified errors for console logging
              const finalizedText = currentOutputText.current;
              const isTajweedErr = finalizedText.includes('تنبيه تجويد');
              const isHifzErr = finalizedText.includes('تنبيه حفظ') || finalizedText.includes('خطأ');
              
              if (isTajweedErr || isHifzErr) {
                const errorData = {
                  type: isTajweedErr ? 'تجويد' : 'حفظ',
                  text: finalizedText,
                  timestamp: Date.now()
                };
                sessionErrorsRef.current.push(errorData);
                console.warn(`[تنبيه خطأ] سورة: ${selectedSurah.name} | النوع: ${errorData.type} | النص: ${finalizedText}`);
              }

              currentInputText.current = '';
              currentOutputText.current = '';
            }
          },
          onerror: (e) => {
            console.error('[Session Error]', e);
            stopRecitation();
          },
          onclose: () => setAppState(AppState.IDLE)
        }
      });
    } catch (err) {
      console.error('[Start Error]', err);
      setError("يجب السماح بالميكروفون.");
      setAppState(AppState.IDLE);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-[#FBFDFF] overflow-hidden relative shadow-[0_0_100px_rgba(0,0,0,0.15)]">
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/islamic-art.png")' }}></div>
      <div className="h-safe-top bg-emerald-900 w-full shrink-0"></div>

      {/* Install Guide Modal */}
      {showInstallGuide && (
        <div className="absolute inset-0 z-50 bg-emerald-950/60 backdrop-blur-md flex items-center justify-center p-6">
          <div className="bg-white rounded-[4rem] p-10 w-full max-w-sm shadow-2xl border border-emerald-50/50 animate-in zoom-in-95 duration-500 relative overflow-hidden">
            <div className="w-24 h-24 bg-emerald-600 rounded-[2.5rem] flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-emerald-600/30">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h3 className="text-3xl font-black text-emerald-900 text-center mb-10">تثبيت حافظ برو</h3>
            <div className="space-y-4 text-right">
              {[
                { n: 1, t: "افتح الرابط في متصفح Chrome" },
                { n: 2, t: "اضغط على القائمة (3 نقاط)" },
                { n: 3, t: "اختر 'تثبيت التطبيق' للوصول" }
              ].map(step => (
                <div key={step.n} className="flex gap-4 items-center bg-emerald-50/30 p-5 rounded-[2rem] border border-emerald-100/50 backdrop-blur-sm">
                  <span className="text-sm text-emerald-900 font-bold flex-1">{step.t}</span>
                  <div className="w-8 h-8 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 text-xs font-black shadow-lg">{step.n}</div>
                </div>
              ))}
            </div>
            <button 
              onClick={() => setShowInstallGuide(false)}
              className="w-full mt-10 py-6 bg-emerald-600 text-white rounded-[2rem] font-black text-xl shadow-2xl shadow-emerald-600/40 active:scale-95 transition-transform"
            >
              بدء الاستخدام
            </button>
          </div>
        </div>
      )}

      <header className="bg-emerald-900 text-white p-6 pb-16 rounded-b-[5.5rem] z-30 shadow-[0_30px_70px_-15px_rgba(6,95,70,0.5)] relative overflow-hidden shrink-0">
        <div className="absolute top-[-20%] right-[-10%] w-80 h-80 bg-emerald-400/20 rounded-full blur-[120px]"></div>
        <div className="flex justify-between items-center mb-12 relative z-10">
          <button onClick={() => setShowInstallGuide(true)} className="p-4 bg-white/10 rounded-[1.75rem] active:scale-90 transition-all border border-white/10 backdrop-blur-xl">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-4xl font-black tracking-tightest">حافظ برو</h1>
            <div className="flex items-center justify-center gap-2 mt-2 bg-emerald-500/20 px-4 py-1.5 rounded-full backdrop-blur-md border border-white/10">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]"></div>
              <p className="text-[11px] text-emerald-50 font-black uppercase tracking-[0.4em]">Smart Hafiz</p>
            </div>
          </div>
          <button onClick={handleInstallClick} className={`p-4 rounded-[1.75rem] transition-all border border-white/10 backdrop-blur-xl ${installPrompt ? 'bg-emerald-500 shadow-2xl animate-bounce' : 'bg-white/10'}`}>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-4 relative z-10 px-3">
            <div className="relative group">
              <input 
                type="text" placeholder="ابحث عن السورة..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-emerald-950/40 border border-white/10 rounded-[2.25rem] py-6 pr-16 pl-8 text-white placeholder-emerald-100/40 focus:outline-none focus:bg-emerald-950/60 transition-all text-right text-xl font-bold backdrop-blur-2xl shadow-inner"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 absolute right-6 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-6 bg-emerald-950/50 p-8 rounded-[4rem] backdrop-blur-3xl border border-white/10 shadow-2xl relative z-10 mx-3">
            <div className="w-24 h-24 rounded-[3rem] bg-emerald-600 flex items-center justify-center shadow-2xl relative overflow-hidden border-2 border-white/30">
              <span className="quran-font text-5xl">📖</span>
              <div className="absolute bottom-0 left-0 right-0 bg-white/40 transition-all duration-200" style={{ height: `${Math.min(audioLevel * 3.5, 100)}%` }}></div>
            </div>
            <div className="flex-1 text-right">
              <div className="flex items-center justify-end gap-1.5 mb-2">
                <span className="text-[10px] text-amber-400 font-black uppercase tracking-[0.2em]">مراقبة الأحكام</span>
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
              </div>
              <p className="font-bold text-3xl text-white drop-shadow-2xl">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-12 no-scrollbar relative" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-10">
            <div className="flex justify-between items-center px-4">
              <h2 className="text-emerald-900 font-black text-2xl tracking-tight">قائمة السور</h2>
              <div className="flex items-center gap-2 bg-emerald-50 px-5 py-2.5 rounded-[1.5rem] shadow-sm border border-emerald-100">
                <span className="text-sm font-black text-emerald-700">{filteredSurahs.length}</span>
                <span className="text-[11px] font-bold text-emerald-600/60 uppercase tracking-widest">سورة</span>
              </div>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-7">
              {filteredSurahs.map(surah => (
                <SurahCard key={surah.id} surah={surah} isSelected={selectedSurah?.id === surah.id} onSelect={setSelectedSurah} />
              ))}
            </div>

            {filteredSurahs.length > 0 && (
              <div className="py-20 flex flex-col items-center justify-center gap-8 opacity-40">
                <div className="text-center px-6">
                  <p className="quran-font text-3xl text-emerald-900 mb-4">إِنَّا نَحْنُ نَزَّلْنَا الذِّكْرَ وَإِنَّا لَهُ لَحَافِظُونَ</p>
                  <p className="text-[10px] text-emerald-600 font-black uppercase tracking-[0.3em]">سورة الحجر - الآية 9</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-10">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-48 text-slate-300 gap-12">
                <div className="relative">
                  <div className="w-48 h-48 bg-white rounded-[5rem] flex items-center justify-center shadow-2xl border border-emerald-50">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-24 w-24 text-emerald-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-amber-500 text-white px-8 py-3 rounded-[1.5rem] text-[10px] font-black shadow-2xl z-20 whitespace-nowrap tracking-widest">مراقب التجويد نشط</div>
                </div>
                <div className="text-center px-12">
                  <p className="font-black text-emerald-950 text-3xl mb-4">تفضل بالبدء</p>
                  <p className="text-sm text-slate-500 font-medium leading-loose">اقرأ بتمهل، وسأقوم بتنبيهك فور حدوث أي خطأ في "أحكام التجويد" أو "الآيات".</p>
                </div>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`max-w-[92%] p-8 rounded-[3.5rem] shadow-2xl transition-all duration-700 transform animate-in slide-in-from-bottom-8 ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-emerald-950 rounded-tr-none border-r-[10px] border-emerald-500' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? ( (msg as any).isTajweed ? 'bg-amber-600 ring-[15px] ring-amber-50 shadow-amber-900/20' : 'bg-rose-600 ring-[15px] ring-rose-50 animate-shake shadow-rose-950/20' ) : 'bg-emerald-900 shadow-emerald-950/40'}`
                }`}
              >
                <div className="flex justify-between items-center mb-4 opacity-50">
                  <span className="text-[11px] font-black uppercase tracking-[0.3em]">
                    {msg.type === 'user' ? 'تلاوتك' : ( (msg as any).isTajweed ? 'حكم تجويد ⚖️' : (msg.isError ? 'تنبيه الحفظ ⚠️' : 'تصحيح ذكي ✅') )}
                  </span>
                </div>
                <p className={`${msg.type === 'user' ? 'quran-font text-4xl' : 'text-xl font-bold'} text-right leading-relaxed`}>
                  {msg.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="p-10 pb-16 bg-white/90 backdrop-blur-3xl rounded-t-[5.5rem] border-t border-emerald-50 shadow-[0_-30px_100px_rgba(0,0,0,0.1)] relative z-40 shrink-0">
        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation} disabled={!selectedSurah}
            className={`w-full py-8 rounded-[3rem] font-black text-3xl flex items-center justify-center gap-6 transition-all active:scale-[0.96] group relative overflow-hidden ${
              selectedSurah ? 'bg-emerald-600 text-white shadow-emerald-500/50' : 'bg-slate-100 text-slate-300'
            }`}
          >
            <div className={`p-4 rounded-[1.75rem] ${selectedSurah ? 'bg-emerald-500' : 'bg-slate-200'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-9 w-9" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span>بدء التسميع</span>
          </button>
        ) : (
          <div className="space-y-10">
            <div className="flex justify-between items-center px-8">
               <div className="flex gap-3 items-end h-12">
                 {[...Array(16)].map((_, i) => (
                   <div key={i} className={`w-2.5 rounded-full transition-all duration-300 ${i < (audioLevel / 5.5) ? 'bg-emerald-600 h-12 shadow-[0_0_25px_rgba(16,185,129,0.6)]' : 'bg-slate-200 h-2.5'}`}></div>
                 ))}
               </div>
               <div className="text-right">
                 <p className="text-[13px] text-emerald-600 font-black tracking-[0.3em] animate-pulse">فحص المخارج والأحكام</p>
                 <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest opacity-60">نظام الذكاء التجويدي</p>
               </div>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-8 bg-rose-50 text-rose-600 border-[5px] border-rose-100 rounded-[3rem] font-black text-3xl flex items-center justify-center gap-6 active:scale-[0.96] shadow-2xl"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-9 w-9" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إيقاف الجلسة
            </button>
          </div>
        )}
      </footer>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        .animate-shake {
          animation: shake 0.12s cubic-bezier(.36,.07,.19,.97) both;
          animation-iteration-count: 3;
        }
        .h-safe-top { height: env(safe-area-inset-top, 24px); }
        .quran-font { line-height: 1.5; }
      `}</style>
    </div>
  );
};

export default App;
