
export interface Surah {
  id: number;
  name: string;
  transliteration: string;
  versesCount: number;
}

export interface RecitationMessage {
  id: string;
  type: 'user' | 'bot';
  text: string;
  isError?: boolean;
  isTajweed?: boolean;
  timestamp: number;
}

export enum AppState {
  IDLE = 'IDLE',
  PREPARING = 'PREPARING',
  RECITING = 'RECITING',
  REFLECTING = 'REFLECTING',
  ERROR = 'ERROR'
}
