// Shared application context passed to UI panels.
import type { Stage } from './stage';
import type { Avatar } from './avatar';
import type { AnimationPlayer } from './animation';
import type { GestureController } from './gestures';
import type { StreamingInput } from './streaming';
import type { SyphonOutput } from './syphon';
import type { VrcRuntime } from './vrcMeta';
import type { AvatarProfile, SysInfo } from '../shared/bridge';

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
  view: 'welcome' | 'folder' | 'avatar';
  /** set when the avatar was opened from the folder browser */
  cameFromFolder: boolean;

  loadAvatar(path: string, opts?: { keepCamera?: boolean }): Promise<void>;
  openAvatarDialog(): Promise<void>;
  openFolderDialog(): Promise<void>;
  showWelcome(): void;
  showFolder(dir?: string): void;
  setTransparent(on: boolean): void;
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
}
