
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
    className={`p-4 rounded-3xl border-2 transition-all text-right flex flex-col gap-1 active:scale-90 android-ripple ${
      isSelected 
        ? 'border-emerald-600 bg-emerald-50 shadow-lg ring-2 ring-emerald-500/30' 
        : 'border-white bg-white hover:border-emerald-100 shadow-sm'
    }`}
  >
    <div className="flex justify-between items-center w-full">
      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
        #{surah.id}
      </span>
      <span className="quran-font text-xl font-bold text-slate-800">{surah.name}</span>
    </div>
    <div className="flex justify-between items-center w-full mt-1">
      <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{surah.transliteration}</span>
      <span className="text-[10px] text-emerald-600 font-bold">{surah.versesCount} آية</span>
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

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');

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
    inputAudioContextRef.current = null;
    currentInputText.current = '';
    currentOutputText.current = '';
    setAudioLevel(0);
  }, []);

  const startRecitation = async () => {
    if (!selectedSurah) return;
    
    try {
      setAppState(AppState.PREPARING);
      setError(null);
      setMessages([]);
      currentInputText.current = '';
      currentOutputText.current = '';

      // Initialize with the provided key (injected via environment in this platform)
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
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `${SYSTEM_INSTRUCTION}\nالمستخدم يسمع الآن سورة ${selectedSurah.name}. كن يقظاً جداً لأي خطأ.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setAppState(AppState.RECITING);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            source.connect(analyser);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const updateLevel = () => {
              if (appState === AppState.IDLE) return;
              analyser.getByteFrequencyData(dataArray);
              const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
              setAudioLevel(average);
              requestAnimationFrame(updateLevel);
            };
            updateLevel();

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
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
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              currentInputText.current += text;
              setMessages(prev => {
                const filtered = prev.filter(m => m.id !== 'live-input');
                return [...filtered, { id: 'live-input', type: 'user', text: currentInputText.current, timestamp: Date.now() }];
              });
            }

            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              currentOutputText.current += text;
              
              const isWarning = currentOutputText.current.includes('تنبيه') || currentOutputText.current.includes('خطأ');
              if (isWarning && navigator.vibrate) {
                navigator.vibrate([100, 50, 100]); // اهتزاز بنمط تنبيه أندرويد
              }

              setMessages(prev => {
                const filtered = prev.filter(m => m.id !== 'live-output');
                return [...filtered, { id: 'live-output', type: 'bot', text: currentOutputText.current, timestamp: Date.now(), isError: isWarning }];
              });
            }

            if (message.serverContent?.turnComplete) {
              setMessages(prev => {
                const finalized = prev.map(m => {
                  if (m.id === 'live-input') return { ...m, id: `final-input-${Date.now()}` };
                  if (m.id === 'live-output') return { ...m, id: `final-output-${Date.now()}` };
                  return m;
                });
                return finalized;
              });
              currentInputText.current = '';
              currentOutputText.current = '';
            }
          },
          onerror: () => {
            setError("عذراً، حدث خطأ في النظام الذكي. جرب مرة أخرى.");
            stopRecitation();
          },
          onclose: () => setAppState(AppState.IDLE)
        }
      });
    } catch (err) {
      setError("يجب السماح بالوصول للميكروفون لبدء التسميع.");
      setAppState(AppState.IDLE);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-slate-50 overflow-hidden relative shadow-[0_0_50px_rgba(0,0,0,0.1)]">
      {/* Android Top Nav */}
      <header className="bg-emerald-900 text-white p-6 pb-10 rounded-b-[3.5rem] z-30 transition-all shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16 blur-2xl"></div>
        
        <div className="flex justify-between items-center mb-6 relative z-10">
          <button className="p-2 bg-white/10 rounded-2xl active:scale-90 transition-transform">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-2xl font-black tracking-tighter">حافظ برو</h1>
            <div className="flex items-center justify-center gap-1">
              <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse"></span>
              <p className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest">Gemini Native</p>
            </div>
          </div>
          <button className="p-2 bg-white/10 rounded-2xl active:scale-90 transition-transform">
            <div className="w-6 h-6 rounded-full bg-emerald-400/20 border-2 border-emerald-400"></div>
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-5 relative z-10">
            <div className="bg-white/5 p-4 rounded-3xl backdrop-blur-md border border-white/10">
              <p className="text-emerald-50 text-sm font-medium leading-relaxed text-right">
                سأقوم بمراجعة تلاوتك وتنبيهك فوراً عند الخطأ. اختر سورة لتبدأ.
              </p>
            </div>
            <div className="relative group">
              <input 
                type="text" 
                placeholder="ابحث عن السورة (اسم أو رقم)..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-2xl py-4 pr-12 pl-6 text-white placeholder-emerald-200/50 focus:outline-none focus:ring-4 focus:ring-emerald-500/30 focus:bg-white/20 transition-all text-right text-sm"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute right-4 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-5 bg-white/10 p-5 rounded-[2.5rem] backdrop-blur-xl border border-white/10 shadow-inner relative z-10">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center shadow-2xl overflow-hidden ring-4 ring-emerald-400/40">
                <span className="quran-font text-3xl animate-pulse">📖</span>
                <div 
                  className="absolute bottom-0 left-0 right-0 bg-white/30 transition-all duration-100" 
                  style={{ height: `${Math.min(audioLevel * 2, 100)}%` }}
                ></div>
              </div>
            </div>
            <div className="flex-1 text-right">
              <p className="text-[10px] text-emerald-300 uppercase tracking-widest font-black mb-1">المعلم يسمع تلاوتك</p>
              <p className="font-bold text-2xl text-white">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto px-5 py-6 no-scrollbar" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-6">
            <div className="flex justify-between items-center px-1">
              <h2 className="text-slate-800 font-black text-xl">اختر سورة</h2>
              <span className="text-xs text-slate-400 font-bold">114 سورة</span>
            </div>
            <div className="grid grid-cols-2 gap-4 pb-24">
              {filteredSurahs.map(surah => (
                <SurahCard 
                  key={surah.id} 
                  surah={surah} 
                  isSelected={selectedSurah?.id === surah.id} 
                  onSelect={setSelectedSurah} 
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-slate-300 gap-6">
                <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center border-4 border-white shadow-xl animate-pulse">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="font-black text-slate-600 text-lg">أنا بانتظار سماع تلاوتك</p>
                  <p className="text-xs text-slate-400 mt-2">ابدأ بقراءة الآيات بوضوح...</p>
                </div>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id}
                className={`max-w-[90%] p-5 rounded-[2rem] shadow-xl transition-all duration-300 transform active:scale-98 ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-slate-800 rounded-tr-none border-l-8 border-emerald-500' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? 'bg-rose-600 ring-8 ring-rose-50' : 'bg-emerald-800 shadow-emerald-900/10'}`
                }`}
              >
                <div className="flex justify-between items-center mb-2">
                   <span className="text-[9px] font-black uppercase tracking-widest opacity-50">
                     {msg.type === 'user' ? 'تلاوتك' : 'تنبيه المعلم'}
                   </span>
                </div>
                <p className={`${msg.type === 'user' ? 'quran-font text-2xl' : 'text-sm font-bold'} leading-relaxed text-right`}>
                  {msg.text}
                </p>
                <div className="mt-2 flex justify-end opacity-30">
                  <span className="text-[8px] font-mono">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Android Bottom Action Area */}
      <footer className="p-6 pb-10 bg-white shadow-[0_-20px_50px_rgba(0,0,0,0.05)] rounded-t-[3.5rem] border-t border-emerald-50">
        {error && (
          <div className="mb-4 bg-rose-500 text-white p-4 rounded-2xl text-xs font-bold flex items-center gap-3 shadow-lg animate-bounce">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {error}
          </div>
        )}

        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation}
            disabled={!selectedSurah}
            className={`w-full py-5 rounded-3xl font-black text-xl flex items-center justify-center gap-4 transition-all transform active:scale-95 shadow-2xl ${
              selectedSurah 
                ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
                : 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
            }`}
          >
            <div className="bg-white/20 p-2 rounded-xl">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            ابدأ التسميع الآن
          </button>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-between items-center px-4">
               <div className="flex gap-1 items-end h-6">
                 {[...Array(10)].map((_, i) => (
                   <div 
                    key={i} 
                    className={`w-1 rounded-full transition-all duration-100 ${i < (audioLevel / 10) ? 'bg-emerald-600 h-6' : 'bg-slate-200 h-2'}`}
                   ></div>
                 ))}
               </div>
               <span className="text-[10px] text-emerald-600 font-black tracking-widest animate-pulse">النظام ينصت...</span>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-5 bg-rose-50 text-rose-600 border-4 border-rose-100 rounded-3xl font-black text-xl flex items-center justify-center gap-3 active:scale-95 transition-all shadow-lg"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إنهاء التسميع
            </button>
          </div>
        )}
      </footer>
    </div>
  );
};

export default App;
