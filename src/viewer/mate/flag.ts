// Switch for the desktop character motion: the avatar idles and now and then does something on its own.
import { persisted } from '../../shared/store';

export const mateFlag = persisted('settings.mateFlag', { enabled: true });
