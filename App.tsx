
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
    className={`p-4 rounded-3xl border-2 transition-all text-right flex flex-col gap-1 active:scale-90 ripple ${
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
            <h3 className="text-2xl font-black text-emerald-900 text-center mb-6">كيفية التثبيت على هاتفك</h3>
            <div className="space-y-6 text-right">
              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 font-bold">1</div>
                <p className="text-sm text-slate-600">افتح هذا الرابط في متصفح <b>Chrome</b> على الأندرويد.</p>
              </div>
              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 font-bold">2</div>
                <p className="text-sm text-slate-600">اضغط على زر القائمة (3 نقاط) في المتصفح.</p>
              </div>
              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 font-bold">3</div>
                <p className="text-sm text-slate-600">اختر <b>"تثبيت التطبيق"</b> أو <b>"Add to Home Screen"</b>.</p>
              </div>
            </div>
            <div className="mt-8 bg-slate-50 p-4 rounded-2xl border border-slate-100 break-all text-[10px] font-mono text-slate-400 select-all">
              {window.location.href}
            </div>
            <button 
              onClick={() => setShowInstallGuide(false)}
              className="w-full mt-6 py-4 bg-emerald-600 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-transform"
            >
              فهمت ذلك
            </button>
          </div>
        </div>
      )}

      <header className="bg-emerald-900 text-white p-6 pb-12 rounded-b-[4rem] z-30 shadow-2xl relative overflow-hidden">
        <div className="flex justify-between items-center mb-6 relative z-10">
          <button onClick={() => setShowInstallGuide(true)} className="p-2.5 bg-white/10 rounded-2xl active:scale-90">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div className="text-center">
            <h1 className="text-2xl font-black">حافظ برو</h1>
            <p className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest">Smart Hifz App</p>
          </div>
          <button 
            onClick={handleInstallClick}
            className={`px-4 py-2 rounded-2xl text-[10px] font-black transition-all ${installPrompt ? 'bg-emerald-500 animate-pulse' : 'bg-white/10'}`}
          >
            تثبيت التطبيق
          </button>
        </div>
        
        {appState === AppState.IDLE ? (
          <div className="space-y-4 relative z-10">
            <div className="relative group">
              <input 
                type="text" placeholder="ابحث عن السورة..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-2xl py-4 pr-12 pl-6 text-white placeholder-emerald-200/40 focus:outline-none text-right text-sm"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute right-4 top-1/2 -translate-y-1/2 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-6 bg-white/10 p-6 rounded-[3rem] backdrop-blur-2xl border border-white/10 shadow-inner relative z-10">
            <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center shadow-2xl relative">
              <span className="quran-font text-4xl animate-bounce">📖</span>
              <div className="absolute bottom-0 left-0 right-0 bg-white/40 transition-all duration-150" style={{ height: `${Math.min(audioLevel * 2.5, 100)}%` }}></div>
            </div>
            <div className="flex-1 text-right">
              <p className="text-[10px] text-emerald-300 uppercase tracking-widest font-black">جلسة نشطة</p>
              <p className="font-bold text-2xl text-white">سورة {selectedSurah?.name}</p>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-5 py-8 no-scrollbar bg-slate-50" ref={transcriptContainerRef}>
        {appState === AppState.IDLE ? (
          <div className="grid grid-cols-2 gap-4 pb-32">
            {filteredSurahs.map(surah => (
              <SurahCard key={surah.id} surah={surah} isSelected={selectedSurah?.id === surah.id} onSelect={setSelectedSurah} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-32 text-slate-300 gap-6">
                <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center border-8 border-white animate-pulse">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <p className="font-bold text-slate-500">ابدأ القراءة الآن، أنا أسمعك...</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`max-w-[92%] p-5 rounded-[2.5rem] shadow-xl transition-all ${msg.type === 'user' ? 'self-start bg-white text-slate-800 border-r-8 border-emerald-500' : `self-end text-white ${msg.isError ? 'bg-rose-600 ring-8 ring-rose-50' : 'bg-emerald-800'}`}`}>
                <p className={`${msg.type === 'user' ? 'quran-font text-3xl' : 'text-base font-bold'} text-right`}>{msg.text}</p>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="p-8 pb-12 bg-white rounded-t-[4rem] border-t border-emerald-50 shadow-2xl relative z-40">
        {appState === AppState.IDLE ? (
          <button
            onClick={startRecitation} disabled={!selectedSurah}
            className={`w-full py-6 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-4 transition-all active:scale-95 ${selectedSurah ? 'bg-emerald-600 text-white shadow-emerald-500/30 shadow-2xl' : 'bg-slate-100 text-slate-300'}`}
          >
            ابدأ التسميع
          </button>
        ) : (
          <button
            onClick={stopRecitation}
            className="w-full py-6 bg-rose-50 text-rose-600 border-4 border-rose-100 rounded-[2.5rem] font-black text-2xl flex items-center justify-center gap-4 active:scale-95"
          >
            إنهاء الجلسة
          </button>
        )}
      </footer>
    </div>
  );
};

export default App;
