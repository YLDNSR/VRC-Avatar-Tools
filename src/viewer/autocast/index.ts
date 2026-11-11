// Autonomous broadcast (beta): the avatar reads CHZZK chat and answers with a local LLM and voice,
// talks now and then on its own, moves by itself (the desktop character motion, ../mate), and the operator can
// speak through it at any time. Loaded only while the switch in Settings → Labs is on.
import type { App, AutocastHandle } from '../app';
import type { LifeMotion } from '../mate/life';
import { Speaker } from './speaker';
import { Brain } from './brain';
import { ChzzkLink } from './chzzk';
import { createAutocastPanel } from './panel';
import { autocast } from './settings';

export function createAutocast(app: App, life: LifeMotion): AutocastHandle {
  const speaker = new Speaker();
  const brain = new Brain(speaker, life.actions, () => app.avatar?.info.title || '');
  const chzzk = new ChzzkLink(brain);
  (window as any).__autocast = { speaker, brain, life, chzzk }; // for debugging from DevTools

  // What the motion needs from the broadcast: the voice for the mouth, the line's emotion, the thinking pose.
  const gesturesOn = () => autocast.motion.gestures !== false;
  life.driver = {
    live: () => brain.running || speaker.speaking,
    idle: () => autocast.motion.idle,
    voice: speaker,
    lipSync: () => autocast.motion.lipSync,
    emotion: () => brain.emotion,
    emotions: () => autocast.motion.emotions,
    thinking: () => brain.thinking && autocast.reply.mode === 'llm',
    gestures: gesturesOn,
  };

  function start() {
    speaker.unlock();
    brain.start();
    if (autocast.chzzk.connectOnStart) chzzk.connectIfReady();
    app.markActive();
    app.rerenderUI();
  }

  function stop() {
    brain.stop();
    if (chzzk.connection !== 'idle') chzzk.run('disconnect');
    app.rerenderUI();
  }

  const panel = createAutocastPanel(app, { brain, speaker, chzzk, life, start, stop });
  let pending = 0;
  brain.onChange = () => {
    // Many log lines at once (busy chat): redraw once per frame.
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; if (!panel.el.classList.contains('hidden')) panel.refresh(); });
  };

  return {
    panel,
    live: () => brain.running,
    busy: () => brain.running || speaker.speaking,
    update() {
      speaker.update();
    },
    shutdown() {
      stop();
      speaker.stop();
      life.driver = null;
      life.actions.stop();
    },
  };
}
