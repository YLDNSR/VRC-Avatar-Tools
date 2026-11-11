// Feature switch for the autonomous broadcast (Settings → Labs). Kept apart from the feature itself, so
// the viewer loads none of it while the switch is off. The beta app has it on from the start.
import { persisted } from '../../shared/store';

const vav = (window as any).vav as { channel?: string } | undefined;

export const autocastFlag = persisted('settings.autocastFlag', { enabled: vav?.channel === 'beta' });
