// Desktop character motion (beta): the avatar idles and now and then does something on its own. Loaded only
// while its switch (Settings → Labs) or the autonomous broadcast, which moves the avatar with it, is on.
import type { App, MateHandle } from '../app';
import { LifeMotion } from './life';
import { Interaction } from './interact';
import { createMateSection, mateMenu } from './panel';
import { mateFlag } from './flag';
import { mate } from './settings';
import { tm } from './strings';

export interface MateModule extends MateHandle {
  life: LifeMotion;
}

export function createMate(app: App): MateModule {
  const life = new LifeMotion();
  const interaction = new Interaction(app, life);
  let section: ReturnType<typeof createMateSection> | null = null;
  (window as any).__mate = { life, interaction }; // for debugging from DevTools

  return {
    life,
    section() {
      section ??= createMateSection(app, life);
      section.refresh();
      return section.el;
    },
    menu: () => mateMenu(app, life),
    busy: () => life.busy(),
    beginFrame: () => life.beginFrame(),
    update: (dt: number) => life.update(app, dt),
    shutdown() {
      life.actions.stop();
      life.reset();
    },
    controls: (transparent: boolean) => mateFlag.enabled && (mate.controls === 'always' || (mate.controls === 'transparent' && transparent)),
    controlsHint: () => tm('controlsToast'),
    poke: (x: number, y: number, onAvatar: boolean) => interaction.click(x, y, onAvatar),
  };
}
