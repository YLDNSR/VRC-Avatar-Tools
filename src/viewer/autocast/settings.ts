// Settings of the autonomous broadcast: how chat is answered, idle talk, voice, avatar motion.
import { persisted } from '../../shared/store';

export type ReplyMode = 'llm' | 'read' | 'off';
export type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed';

export const DEFAULT_PERSONA = '밝고 다정한 버추얼 스트리머. 시청자를 반갑게 맞이하고, 짧고 자연스러운 존댓말로 이야기한다. 가끔 장난스럽지만 무례하지 않다.';

export const DEFAULT_IDLE_LINES = [
  '채팅창이 조용하네요. 다들 뭐 하고 계세요?',
  '오늘 하루는 어떠셨어요? 편하게 채팅으로 알려 주세요.',
  '처음 오신 분들도 반가워요. 편하게 놀다 가세요.',
  '잠깐 쉬어 가는 시간이에요. 물 한 잔 마시고 오셔도 좋아요.',
  '궁금한 거 있으면 아무거나 물어봐 주세요.',
];

export const autocast = persisted('settings.autocast', {
  name: '',
  persona: DEFAULT_PERSONA,
  reply: {
    mode: 'llm' as ReplyMode,
    /** Seconds of silence between two answers */
    gapSec: 3,
    /** Chats waiting for an answer; older ones are dropped when chat is busy */
    maxQueue: 3,
    /** Chats starting with one of these (space separated) are skipped, e.g. bot commands */
    ignorePrefixes: '!',
    /** Chats with these words (comma separated) are skipped; an answer with them is not spoken */
    banned: '',
    readFormat: '{nick}님, {msg}',
    maxChars: 90,
  },
  operator: {
    /** The streamer's own chat is spoken by the avatar as written (instead of an LLM answer) */
    streamerSpeaks: true,
    /** Only streamer chats starting with this prefix are spoken (empty: all of them) */
    prefix: '',
    /** Operator speech drops the answers still waiting */
    clearQueue: true,
  },
  idle: {
    enabled: true,
    minSec: 60,
    maxSec: 150,
    useLlm: true,
    topics: '오늘 하루, 좋아하는 음식, 요즘 듣는 노래, 시청자 근황',
    lines: DEFAULT_IDLE_LINES.join('\n'),
  },
  llm: {
    api: 'ollama' as 'ollama' | 'openai',
    url: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    temperature: 0.8,
    /** Previous exchanges sent along for context */
    history: 6,
  },
  voice: {
    engine: 'say' as 'say' | 'http',
    sayVoice: 'Yuna',
    rate: 190,
    volume: 1,
    /** Audio output device (AudioContext.setSinkId); '' = system default */
    sinkId: '',
    httpUrl: 'http://127.0.0.1:8880/v1/audio/speech',
    httpModel: '',
    httpVoice: '',
  },
  /** The avatar's motion while live; standing pose, blinking and actions are the desktop character's (../mate). */
  motion: {
    idle: true,
    emotions: true,
    /** Reaction gestures (wave, bow, nod, …) with the lines and a thinking pose while the LLM works */
    gestures: true,
    lipSync: 1,
  },
  chzzk: {
    /** Connect to CHZZK chat when the broadcast starts */
    connectOnStart: true,
  },
});
