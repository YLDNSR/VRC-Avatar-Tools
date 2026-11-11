// Settings of the desktop character motion (also used while the autonomous broadcast runs).
import { persisted } from '../../shared/store';

export type ActionRate = 'off' | 'rare' | 'normal' | 'often';
/** When the desktop character controls apply (left click reacts, left drag moves the window, scroll zooms) */
export type ControlMode = 'transparent' | 'always' | 'off';

/** Seconds between two actions played on their own [min, max] */
export const ACTION_GAPS: Record<Exclude<ActionRate, 'off'>, [number, number]> = {
  rare: [70, 160],
  normal: [30, 75],
  often: [14, 35],
};

export const mate = persisted('settings.mate', {
  /** How often a small action (stretching, looking around, …) plays on its own */
  actions: 'normal' as ActionRate,
  /** Arms relaxed at the sides instead of the T-pose when nothing else poses them */
  restPose: true,
  /** Now and then another way of standing (hands together in front, behind the back) */
  poses: true,
  breathing: true,
  /** Weight from one leg to the other now and then */
  weightShift: true,
  /** Eyes and head look around now and then */
  lookAround: true,
  /** Small moves now and then: a smile at the viewer, a head tilt, a little nod, up on the toes */
  smallMoves: true,
  /** The whole body moves (hips, knees, steps); off, or while the broadcast runs: mostly the upper body */
  fullBody: true,
  /** Looks toward the camera (the viewer) most of the time */
  lookAtViewer: true,
  blink: true,
  /** Size of the idle motion */
  intensity: 1,
  controls: 'transparent' as ControlMode,
});
