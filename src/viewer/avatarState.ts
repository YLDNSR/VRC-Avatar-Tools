// Per-avatar memory of the avatar menu values (outfit, hair, colours, toggles, dances, AFK), the playing
// motion and, for plain VRM / glTF avatars, the expression / blendshape and object visibility values.
// Saved automatically while the avatar is shown and applied again when it is opened (or reloaded).
import { persisted } from '../shared/store';

export interface ManualState {
  /** 'e:<expression>' or '<mesh>\u0000<blendshape>' → weight */
  morphs: Record<string, number>;
  /** Names of objects switched off in the Object Toggles list */
  hidden: string[];
}

export interface AvatarState {
  /** Avatar menu / animator parameters that differ from their defaults (VRChat sidecar) */
  params?: Record<string, number>;
  /** Animation player item; avatar-clip:<n> items are found again by name */
  motion?: { path: string; name: string; playing: boolean } | null;
  manual?: ManualState;
  savedAt: string;
}

export const avatarStates = persisted('settings.avatarState', {
  enabled: true,
  /** By avatar key (layoutKey: file name without extension) */
  byAvatar: {} as Record<string, AvatarState>,
});
