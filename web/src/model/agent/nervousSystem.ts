/**
 * Lane L8 — the agent-side view of the nervous system: which nerves an agent creates, in
 * which order, and what the output nerves are called.
 *
 * `agent::grow()` is where an agent's brain gets its I/O vocabulary. Lane L6 owns the
 * `NervousSystem` itself; the *ordering and naming* of these calls is the agent lane's
 * contribution, and it is contract: `createNerve()` assigns indices in call order, the
 * genome's brain topology refers to nerves by index, and every recorded brain/anatomy log
 * is written through those indices.
 *
 * PORT-NOTE(L8/nerve-order-is-contract): the two plans below are transcribed from
 * `agent::grow()` in native order, conditionals included (`YawOppose` only for
 * `YawEncoding == YE_OPPOSE`, `Light` only when `hasLightBehavior`, `Give`/`Pickup`/`Drop`
 * only when their enable flags are set). A port that reorders them produces a
 * different-but-plausible brain and every downstream golden diverges.
 *
 * PORT-NOTE(L8/nervous-system-seam): this is the L8-side interface, not a second
 * implementation. Lane L6's concrete `NervousSystem` must satisfy it (or L8 adopts L6's
 * class at this seam, as with every other cut in `contracts.ts`).
 */

import type {
  BrainLike,
  NerveKind,
  NerveLike,
  NervousSystemRngLike,
  SensorLike,
} from './contracts';
import type { GenomeLike } from './contracts';

/** Native `class NervousSystem` — the subset the agent core calls. */
export interface NervousSystemLike {
  /** Native `createNerve( Nerve::Kind, name )` — index assignment is call order. */
  createNerve(kind: NerveKind, name: string): NerveLike;
  /** Native `getNerve( name )` — the sensors look their input nerve up by name. */
  getNerve(name: string): NerveLike;
  /** Native `addSensor( Sensor * )`. */
  addSensor(sensor: SensorLike): void;
  /** Native `grow( genome )` — grows the brain from the genome. */
  grow(genome: GenomeLike): void;
  /** Native `prebirth()`. */
  prebirth(): void;
  /** Native `update( debugCheck )`. */
  update(debugCheck: boolean): void;
  /** Native `getEnergyUse()` — the brain's own energy consumption for this step. */
  getEnergyUse(): number;
  /** Native `getRNG()`. */
  getRNG(): NervousSystemRngLike;
  /** Native `getBrain()`. */
  getBrain(): BrainLike;
}

/**
 * Native `agent::OutputNerves`. Fields that a worldfile can disable are `null`: native
 * leaves the pointer unset and only reads it under the same flag
 * (`agent::UpdateColor()`, `NormalizedYaw()`, `FieldOfView()`), so a `null` that is read is
 * a port bug, not a missing feature.
 */
export interface AgentOutputNerves {
  eat: NerveLike;
  mate: NerveLike;
  fight: NerveLike;
  speed: NerveLike;
  yaw: NerveLike;
  yawOppose: NerveLike | null;
  light: NerveLike | null;
  focus: NerveLike;
  visionPitch: NerveLike | null;
  visionYaw: NerveLike | null;
  give: NerveLike | null;
  pickup: NerveLike | null;
  drop: NerveLike | null;
}

/** The input nerve names `agent::grow()` creates, in native order. */
export const INPUT_NERVE_FIELDS = [
  'Random',
  'Energy',
  'MateWaitFeedback',
  'SpeedFeedback',
  'Carrying',
  'BeingCarried',
  'Red',
  'Green',
  'Blue',
] as const;

/**
 * The output nerve names `agent::grow()` creates, in native order, paired with the field of
 * `AgentOutputNerves` they fill.
 */
export const OUTPUT_NERVE_FIELDS: readonly (readonly [keyof AgentOutputNerves, string])[] = [
  ['eat', 'Eat'],
  ['mate', 'Mate'],
  ['fight', 'Fight'],
  ['speed', 'Speed'],
  ['yaw', 'Yaw'],
  ['yawOppose', 'YawOppose'],
  ['light', 'Light'],
  ['focus', 'Focus'],
  ['visionPitch', 'VisionPitch'],
  ['visionYaw', 'VisionYaw'],
  ['give', 'Give'],
  ['pickup', 'Pickup'],
  ['drop', 'Drop'],
];
