// Shared application context passed to UI panels.
import type { Stage } from './stage';
import type { Avatar } from './avatar';
import type { AnimationPlayer } from './animation';
import type { GestureController } from './gestures';
import type { StreamingInput } from './streaming';
import type { SyphonOutput } from './syphon';
import type { VrcRuntime } from './vrcMeta';
import type { AvatarProfile, SysInfo } from '../shared/bridge';

/** The autonomous broadcast (beta), loaded when switched on in Settings → Labs. */
export interface AutocastHandle {
  panel: { el: HTMLElement; refresh(): void; onShow?(): void };
  /** The broadcast is running */
  live(): boolean;
  /** Something is going on (keeps the frame rate up) */
  busy(): boolean;
  /** Every frame, before the desktop character motion: the voice level for lip sync */
  update(dt: number): void;
  /** Stops everything (switch turned off) */
  shutdown(): void;
}

/** The desktop character motion (beta): idle motion and small actions, also moving the avatar during the broadcast. */
export interface MateHandle {
  /** Its section in the Animation panel */
  section(): HTMLElement;
  /** Entries of the radial menu's "Actions" ring */
  menu(): { label: string; active?: () => boolean; run(): void }[];
  /** Something is going on (keeps the frame rate up, at least at 30 fps) */
  busy(): boolean;
  /** Start of every frame, before anything poses the bones: takes last frame's motion off */
  beginFrame(): void;
  /** Every frame, before the avatar updates: face, idle motion, actions */
  update(dt: number): void;
  /** Takes its motion off the avatar (switched off) */
  shutdown(): void;
  /** Its controls apply now: left click reacts, left drag moves the window, scroll over the avatar zooms */
  controls(transparent: boolean): boolean;
  /** Short help on those controls (shown when the background turns transparent) */
  controlsHint(): string;
  /** Left click at window point (x, y); onAvatar: known to be on the avatar. False when it was not. */
  poke(x: number, y: number, onAvatar: boolean): boolean;
}

export interface App {
  stage: Stage;
  avatar: Avatar | null;
  /** VRChat sidecar (<name>.vavmeta.json) of the loaded avatar: v2 animator or v1 FX toggles */
  vrc: VrcRuntime | null;
  player: AnimationPlayer;
  gestures: GestureController;
  streaming: StreamingInput;
  syphon: SyphonOutput;
  profiles: AvatarProfile[];
  profileErrors: { file: string; message: string }[];
  sysInfo: SysInfo | null;
  fps: number;
  transparent: boolean;
  /** Dedicated Desktop Mate mode (compact borderless desktop companion, distinct from Studio mode) */
  mateMode: boolean;
  view: 'welcome' | 'folder' | 'avatar';
  /** set when the avatar was opened from the folder browser */
  cameFromFolder: boolean;

  loadAvatar(path: string, opts?: { keepCamera?: boolean }): Promise<void>;
  openAvatarDialog(): Promise<void>;
  openFolderDialog(): Promise<void>;
  showWelcome(): void;
  showFolder(dir?: string): void;
  setTransparent(on: boolean): void;
  setMateMode(on: boolean): Promise<void>;
  toggleDesktopMate(): Promise<void>;
  centerAvatar(): void;
  applyTransparentOptions(): void;
  markActive(): void;
  rerenderUI(): void;
  closePanels(except?: string): void;
  togglePanel(id: string): void;
  reloadProfiles(): Promise<void>;
  applyProfile(): void;
  faceFront(): void;
  /** Saves the avatar's position / scale / rotation and the camera view (per avatar). */
  saveLayout(): void;
  /** Applies the saved layout of this avatar (or the most recent save). */
  restoreLayout(): boolean;
  resetLayout(): void;
  setLayoutLocked(v: boolean): void;
  /** Shows the move grip at (x, y): dragging it (or the avatar) moves the window. */
  startWindowMove(x: number, y: number): void;
  /** Saves the avatar's menu values / motion / manual expressions soon (per avatar). */
  rememberAvatarState(): void;
  /** Set while the autonomous broadcast switch is on */
  autocast: AutocastHandle | null;
  setAutocastEnabled(on: boolean): Promise<void>;
  /** Set while the desktop character switch or the broadcast is on */
  mate: MateHandle | null;
  setMateEnabled(on: boolean): Promise<void>;
}
