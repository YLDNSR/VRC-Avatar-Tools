// Types for the APIs exposed by the preload scripts.

export interface LoginItemState {
  supported: boolean;
  openAtLogin: boolean;
  status: 'enabled' | 'not-registered' | 'requires-approval' | 'not-found' | 'unsupported';
  appPath?: string;
  error?: string;
}

export interface CursorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
  screen: { x: number; y: number; width: number; height: number };
  modifiers: Record<string, boolean>;
  buttons: number;
}

export interface FolderAvatar {
  path: string;
  file: string;
  title: string;
  author: string;
  version: string;
  thumbnail: string | null;
  size: number;
  mtime: number;
}

export interface ProfileExpression {
  source: string;
  target: string;
  renderer: string | null;
  minWeight: number;
  maxWeight: number;
}

export interface AvatarProfile {
  file: string;
  name: string;
  expressions: ProfileExpression[];
}

export interface SysInfo {
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  memory: number;
  electron: string;
  chrome: string;
  appVersion: string;
}

/** Result of an autocast call in the main process (errors come back instead of being thrown). */
export type CastResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SayVoice { name: string; locale: string; sample: string }

export interface ChzzkState {
  clientId: string;
  hasSecret: boolean;
  loggedIn: boolean;
  channelName: string;
  /** Login redirect URL to register for the app in the CHZZK developer center */
  redirectUri: string;
  /** The client secret and tokens are encrypted with the keychain; false: they cannot be stored */
  keychain: boolean;
  connection: ChzzkConnection;
}

export type ChzzkConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ChzzkChat {
  id: string;
  nickname: string;
  /** streamer | common_user | streaming_channel_manager | streaming_chat_manager */
  role: string;
  content: string;
  time: number;
  senderChannelId: string;
}

export interface LlmRequest {
  id?: string;
  api: 'ollama' | 'openai';
  url: string;
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
}

export interface AutocastBridge {
  sayVoices(): Promise<CastResult<SayVoice[]>>;
  say(text: string, voice: string, rate: number): Promise<CastResult<Uint8Array>>;
  ttsHttp(url: string, body: Record<string, unknown>): Promise<CastResult<Uint8Array>>;
  llm(req: LlmRequest): Promise<CastResult<string>>;
  llmCancel(id: string): void;
  llmModels(api: string, url: string): Promise<CastResult<string[]>>;
  chzzk: {
    state(): Promise<CastResult<ChzzkState>>;
    setClient(clientId: string, clientSecret: string): Promise<CastResult<ChzzkState>>;
    login(): Promise<CastResult<ChzzkState>>;
    logout(): Promise<CastResult<ChzzkState>>;
    connect(): Promise<CastResult<ChzzkState>>;
    disconnect(): Promise<CastResult<ChzzkState>>;
  };
}

interface StoreApi {
  all(): Record<string, any>;
  set(key: string, value: any): void;
}

export interface ViewerBridge {
  platform: string;
  /** 'beta': the separate beta app (own settings folder) */
  channel: string;
  store: StoreApi;
  dialog: {
    openAvatar(): Promise<string | null>;
    openFolder(defaultPath?: string): Promise<string | null>;
    openAnimations(multi: boolean): Promise<string[]>;
  };
  fs: {
    readText(p: string): Promise<string>;
    exists(p: string): Promise<boolean>;
    stat(p: string): Promise<{ size: number; mtime: number } | null>;
  };
  fileUrl(p: string): string;
  pathForFile(file: File): string;
  listFolder(dir: string): Promise<FolderAvatar[]>;
  watchAvatar(p: string | null): void;
  profiles: {
    list(): Promise<{ dir: string; profiles: AvatarProfile[]; errors: { file: string; message: string }[] }>;
    openFolder(): Promise<string>;
  };
  sysInfo(): Promise<SysInfo>;
  win: {
    setTransparent(opts: {
      transparent?: boolean;
      alwaysOnTop?: boolean;
      clickThrough?: boolean;
    }): {
      overlay: boolean;
      from: { x: number; y: number; width: number; height: number };
      to: { x: number; y: number; width: number; height: number };
    } | null;
    setMateMode(opts: {
      mateMode: boolean;
      alwaysOnTop?: boolean;
      clickThrough?: boolean;
    }): {
      mateMode: boolean;
      from: { x: number; y: number; width: number; height: number };
      to: { x: number; y: number; width: number; height: number };
      workArea: { x: number; y: number; width: number; height: number };
    } | null;
    resizeMate(opts: {
      width?: number;
      height?: number;
      petWidth?: number;
      petHeight?: number;
      anchorX?: number;
      anchorY?: number;
      expanded?: boolean;
      restoreOnly?: boolean;
    }): {
      from: { x: number; y: number; width: number; height: number };
      to: { x: number; y: number; width: number; height: number };
      petBounds: { x: number; y: number; width: number; height: number };
      charOffset: { x: number; y: number };
      workArea: { x: number; y: number; width: number; height: number };
    } | null;
    setIgnoreMouse(ignore: boolean): void;
    wantCursor(want: boolean): void;
    moveBy(dx: number, dy: number): void;
    close(): void;
    minimize(): void;
    /** Windows: transparent windows cannot be resized by their edges. */
    setSize(width: number, height: number): void;
    getSize(): Promise<[number, number]>;
  };
  syphon: {
    start(name: string): Promise<boolean>;
    stop(): Promise<boolean>;
    status(): Promise<{ available: boolean; running: boolean; clients: boolean }>;
    sendFrame(data: Uint8Array, width: number, height: number): void;
  };
  keys: { setGlobal(enable: boolean): Promise<{ ok: boolean; reason?: string }> };
  /** macOS login item ("Open at Login"); supported only in the packaged app. */
  login: {
    get(): Promise<LoginItemState>;
    set(enable: boolean): Promise<LoginItemState>;
    openSettings(): Promise<void>;
  };
  autocast: AutocastBridge;
  openCapture(): Promise<boolean>;
  /** Quits the whole app (viewer and capture windows). */
  quit(): void;
  setLanguage(lang: string): void;
  openExternal(url: string): Promise<void>;
  on(channel: string, cb: (...args: any[]) => void): void;
  udp: {
    listen(port: number, onPacket: (data: Uint8Array, address: string) => void, onError?: (msg: string) => void): Promise<{ ok: boolean; id?: number; error?: string }>;
    close(id: number): void;
  };
}

export interface CaptureBridge {
  platform: string;
  store: StoreApi;
  requestMedia(kind: 'camera' | 'microphone'): Promise<boolean>;
  openViewer(): Promise<boolean>;
  setLanguage(lang: string): void;
  udp: {
    send(host: string, port: number, data: Uint8Array): Promise<string | null>;
    sendMany(host: string, port: number, packets: Uint8Array[]): void;
  };
  ifm: {
    start(port: number, onPacket: (text: string, address: string) => void, onError?: (msg: string) => void): Promise<{ ok: boolean; error?: string }>;
    handshake(ip: string, port: number, message: string): void;
    stop(): void;
  };
}
