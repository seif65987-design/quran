
import { Surah } from './types';

export const SURAHS: Surah[] = [
  { id: 1, name: "الفاتحة", transliteration: "Al-Fatihah", versesCount: 7 },
  { id: 114, name: "الناس", transliteration: "An-Nas", versesCount: 6 },
  { id: 113, name: "الفلق", transliteration: "Al-Falaq", versesCount: 5 },
  { id: 112, name: "الإخلاص", transliteration: "Al-Ikhlas", versesCount: 4 },
  { id: 111, name: "المسد", transliteration: "Al-Masad", versesCount: 5 },
  { id: 110, name: "النصر", transliteration: "An-Nasr", versesCount: 3 },
  { id: 109, name: "الكافرون", transliteration: "Al-Kafirun", versesCount: 6 },
  { id: 108, name: "الكوثر", transliteration: "Al-Kawthar", versesCount: 3 },
  { id: 107, name: "الماعون", transliteration: "Al-Ma'un", versesCount: 7 },
  { id: 106, name: "قريش", transliteration: "Quraish", versesCount: 4 },
  { id: 67, name: "الملك", transliteration: "Al-Mulk", versesCount: 30 },
  { id: 36, name: "يس", transliteration: "Yaseen", versesCount: 83 },
];

export const SYSTEM_INSTRUCTION = `
You are an expert Quran Hafiz and Tajweed teacher. 
Your goal is to help users memorize the Quran (Hifz). 
1. The user will select a Surah and start reciting.
2. Listen carefully to every word.
3. If the user makes a mistake (skips a word, mispronounces, or says the wrong verse), GENTLY interrupt and provide the correction in Arabic.
4. You must be extremely precise. The Quran is the literal word of God; accuracy is paramount.
5. If the user completes a verse correctly, you can provide small encouraging words like "MashaAllah" or "Correct".
6. Use Arabic for corrections.
7. Focus on helping them perfect their 'Save' (Hifz).
8. Only respond to Quranic recitation and questions related to Hifz.
`;
