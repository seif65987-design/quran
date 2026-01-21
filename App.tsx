
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SURAHS, SYSTEM_INSTRUCTION } from './constants';
import { Surah, RecitationMessage, AppState } from './types';
import { decode, encode, decodeAudioData, createPcmBlob } from './services/audioUtils';

// Component for the Surah selection cards
const SurahCard: React.FC<{ 
  surah: Surah; 
  onSelect: (s: Surah) => void;
  isSelected: boolean;
}> = ({ surah, onSelect, isSelected }) => (
  <button 
    onClick={() => onSelect(surah)}
    className={`p-4 rounded-2xl border-2 transition-all text-right flex flex-col gap-1 ${
      isSelected 
        ? 'border-emerald-600 bg-emerald-50 shadow-md ring-2 ring-emerald-500 ring-offset-2' 
        : 'border-white bg-white hover:border-emerald-200 shadow-sm'
    }`}
  >
    <div className="flex justify-between items-center w-full">
      <span className="text-xs font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
        {surah.id}
      </span>
      <span className="quran-font text-xl font-bold">{surah.name}</span>
    </div>
    <div className="flex justify-between items-center w-full mt-1">
      <span className="text-xs text-slate-400">{surah.transliteration}</span>
      <span className="text-xs text-slate-500">{surah.versesCount} آية</span>
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

  // Audio Contexts & Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  
  // Refs for accumulating transcription text within a turn
  const currentInputText = useRef('');
  const currentOutputText = useRef('');

  const scrollToEnd = () => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTo({
        top: transcriptContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

  useEffect(() => {
    scrollToEnd();
  }, [messages]);

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
    sessionRef.current = null;
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

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const analyser = inputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      
      nextStartTimeRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `${SYSTEM_INSTRUCTION}\n\nIMPORTANT: The user is practicing Surah ${selectedSurah.name}. Listen intently and provide feedback as they speak. ALWAYS output transcription of what you say.`,
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
              setMessages(prev => {
                const filtered = prev.filter(m => m.id !== 'live-output');
                return [...filtered, { id: 'live-output', type: 'bot', text: currentOutputText.current, timestamp: Date.now(), isError: currentOutputText.current.includes('خطأ') || currentOutputText.current.includes('أخطأت') }];
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

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error("Gemini Error:", e);
            setError("حدث خطأ في الاتصال بالمعلم.");
            stopRecitation();
          },
          onclose: () => {
            setAppState(AppState.IDLE);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setError("تعذر الوصول إلى الميكروفون أو الخادم.");
      setAppState(AppState.IDLE);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-emerald-50 overflow-hidden shadow-2xl relative border-x border-emerald-100">
      {/* Header */}
      <header className="bg-emerald-700 text-white p-6 rounded-b-[2.5rem] shadow-lg z-20 transition-all">
        <div className="flex justify-between items-center mb-4">
          <div className="bg-emerald-600/50 p-2 rounded-xl">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">حافظ برو</h1>
          <div className="bg-emerald-600/50 p-2 rounded-xl">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-4">
             <div className="bg-emerald-800/40 p-4 rounded-2xl backdrop-blur-sm">
              <p className="text-emerald-100 text-sm leading-relaxed">
                مرحباً بك! اختر أي سورة من القرآن الكريم لنبدأ المراجعة.
              </p>
            </div>
            {/* Search Bar */}
            <div className="relative group">
              <input 
                type="text" 
                placeholder="ابحث عن سورة (اسم أو رقم)..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-2xl py-3 px-10 text-white placeholder-emerald-200/60 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white/20 transition-all"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-3 top-1/2 -translate-y-1/2 text-emerald-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4 bg-emerald-800/40 p-3 rounded-2xl border border-white/10">
            <div className="relative">
              <div className="w-12 h-12 rounded-full bg-emerald-500 flex items-center justify-center shadow-inner overflow-hidden">
                <span className="quran-font text-2xl">📖</span>
                <div 
                  className="absolute bottom-0 left-0 right-0 bg-white/30 transition-all duration-75" 
                  style={{ height: `${Math.min(audioLevel * 1.5, 100)}%` }}
                ></div>
              </div>
            </div>
            <div className="flex-1">
              <p className="text-[10px] text-emerald-200 uppercase tracking-widest font-bold">جاري الاستماع للسورة</p>
              <p className="font-bold text-xl">{selectedSurah?.name}</p>
            </div>
            <div className="flex gap-1 items-end h-6">
               {[1,2,3,4].map(i => (
                 <div 
                   key={i} 
                   className="w-1 bg-emerald-300 rounded-full transition-all duration-75"
                   style={{ height: `${Math.random() * audioLevel + 10}%` }}
                 ></div>
               ))}
            </div>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-4 py-6 no-scrollbar" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="space-y-6">
            <div className="flex justify-between items-center px-2">
              <h2 className="text-slate-800 font-bold text-lg">قائمة السور ({filteredSurahs.length})</h2>
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="text-emerald-600 text-xs font-bold hover:underline"
                >
                  مسح البحث
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 pb-10">
              {filteredSurahs.length > 0 ? (
                filteredSurahs.map(surah => (
                  <SurahCard 
                    key={surah.id} 
                    surah={surah} 
                    isSelected={selectedSurah?.id === surah.id} 
                    onSelect={setSelectedSurah} 
                  />
                ))
              ) : (
                <div className="col-span-2 py-10 text-center text-slate-400">
                  <p>لا توجد نتائج مطابقة لبحثك.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-4">
                <div className="w-24 h-24 bg-emerald-100/50 rounded-full flex items-center justify-center animate-pulse">
                  <div className="w-16 h-16 bg-emerald-200 rounded-full flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                </div>
                <div className="text-center px-6">
                  <p className="font-bold text-slate-600">المعلم ينصت إليك...</p>
                  <p className="text-sm text-slate-400 mt-1">ابدأ تلاوة سورة {selectedSurah?.name} الآن بوضوح لضمان دقة التصحيح.</p>
                </div>
              </div>
            )}
            {messages.map((msg) => (
              <div 
                key={msg.id}
                className={`max-w-[90%] p-4 rounded-2xl shadow-sm transition-all duration-300 ${
                  msg.type === 'user' 
                    ? 'self-start bg-white text-slate-700 rounded-tr-none border-l-4 border-emerald-400' 
                    : `self-end text-white rounded-tl-none ${msg.isError ? 'bg-rose-500 ring-4 ring-rose-100' : 'bg-emerald-600'}`
                } ${msg.id.includes('live') ? 'opacity-80 scale-[0.98]' : 'opacity-100 scale-100'}`}
              >
                <div className="flex justify-between items-start mb-1 gap-4">
                   <span className="text-[9px] font-bold uppercase tracking-widest opacity-50">
                     {msg.type === 'user' ? 'تلاوتك' : 'تصحيح المعلم'}
                   </span>
                   {msg.id.includes('live') && (
                     <span className="flex gap-0.5">
                       <span className="w-1 h-1 bg-current rounded-full animate-bounce"></span>
                       <span className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:0.2s]"></span>
                       <span className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:0.4s]"></span>
                     </span>
                   )}
                </div>
                <p className={`${msg.type === 'user' ? 'quran-font text-2xl' : 'text-sm font-medium'} leading-relaxed`}>
                  {msg.text}
                </p>
                <span className="text-[10px] opacity-40 mt-2 block text-right">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Action Footer */}
      <footer className="p-6 bg-white border-t border-emerald-100 relative">
        {error && (
          <div className="absolute top-0 left-0 right-0 -translate-y-full px-6 py-2">
            <div className="bg-rose-500 text-white p-3 rounded-t-xl text-xs flex items-center gap-2 shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </div>
          </div>
        )}

        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation}
            disabled={!selectedSurah}
            className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 shadow-lg transition-all transform active:scale-95 ${
              selectedSurah 
                ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <div className="bg-white/20 p-2 rounded-lg">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            ابدأ التسميع الآن
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center px-2">
               <div className="flex gap-1">
                 {[...Array(5)].map((_, i) => (
                   <div 
                    key={i} 
                    className={`w-1.5 rounded-full transition-all duration-150 ${i < (audioLevel / 20) ? 'bg-emerald-500 h-4' : 'bg-slate-200 h-2'}`}
                   ></div>
                 ))}
               </div>
               <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-widest animate-pulse">نظام التعرف نشط</span>
            </div>
            <button
              onClick={stopRecitation}
              className="w-full py-4 bg-rose-50 text-rose-600 border-2 border-rose-100 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all active:scale-95 hover:bg-rose-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              إنهاء التسميع
            </button>
          </div>
        )}
      </footer>

      {/* Background decoration */}
      <div className="absolute top-1/4 right-0 w-64 h-64 bg-emerald-100/30 rounded-full blur-3xl -z-10 pointer-events-none"></div>
      <div className="absolute bottom-1/4 left-0 w-64 h-64 bg-emerald-200/20 rounded-full blur-3xl -z-10 pointer-events-none"></div>
    </div>
  );
};

export default App;
