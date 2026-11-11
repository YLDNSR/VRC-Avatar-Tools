// CHZZK chat for the viewer: the main process logs in and holds the chat session; chat arrives here as
// events and goes to the brain.
import type { Brain, ChatRole } from './brain';
import type { ChzzkChat, ChzzkConnection, ChzzkState, CastResult, ViewerBridge } from '../../shared/bridge';
import { tc } from './strings';

const vav = (window as any).vav as ViewerBridge;

function roleOf(code: string): ChatRole {
  if (code === 'streamer') return 'streamer';
  if (code === 'streaming_channel_manager' || code === 'streaming_chat_manager') return 'manager';
  return 'viewer';
}

export class ChzzkLink {
  connection: ChzzkConnection = 'idle';
  message = '';
  onStatus?: () => void;

  constructor(brain: Brain) {
    vav.on('autocast:chat', (c: ChzzkChat) => {
      brain.receive({ nick: c.nickname, text: c.content, role: roleOf(c.role), source: 'chzzk' });
    });
    vav.on('autocast:chzzk-status', (s: { state: ChzzkConnection; message: string }) => {
      this.connection = s.state;
      this.message = s.message;
      this.onStatus?.();
    });
    vav.autocast.chzzk.state().then((r) => {
      if (r.ok) { this.connection = r.value.connection; this.onStatus?.(); }
    });
  }

  async run(kind: 'login' | 'logout' | 'connect' | 'disconnect'): Promise<CastResult<ChzzkState>> {
    const r = await vav.autocast.chzzk[kind]();
    if (r.ok) this.connection = r.value.connection;
    this.onStatus?.();
    return r;
  }

  /** Connects when logged in; quietly does nothing otherwise. */
  async connectIfReady() {
    const s = await vav.autocast.chzzk.state();
    if (!s.ok || !s.value.loggedIn || s.value.connection === 'connected' || s.value.connection === 'connecting') return;
    await this.run('connect');
  }

  explain(error: string) {
    const known = ['no-client', 'not-logged-in', 'port-busy', 'timeout', 'login-denied', 'keychain-unavailable'];
    return known.includes(error) ? tc(`chzzk.err.${error}`) : error;
  }
}
