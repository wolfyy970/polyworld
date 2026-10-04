/**
 * Lane L14 — `AgentTracker` (`library/monitor/AgentTracker.{h,cc}`): the "which agent is this
 * monitor about" selection, as pure data.
 *
 * A tracker is one of
 *   - **FITNESS**: follow the agent at `rank` in the current fittest list (1 = best, -1 =
 *     worst), or
 *   - **NUMBER**: follow the agent whose `Number()` is `number`,
 * and it re-selects every step *unless* the caller asked for `TrackMode Agent`
 * (`trackTilDeath`, the default) and it already has a target — in which case it keeps the
 * agent until it dies, and the death listener clears the target so the next step re-selects.
 *
 * Native evidence for the pieces a probe can reach is in
 * `src/model/monitor/native/vectors/enums.json`: the `Mode` values, the two factory defaults
 * (`trackTilDeath` = true, `rank`/`number` carried), and the no-target state title
 * (`"No Agent"`).
 *
 * PORT-NOTE(monitor/parms-union): native `Parms` is a tagged `union` — `createFitness` writes
 * `fitness.rank` and leaves `Parms::number` reading uninitialized memory (the two members
 * overlap). The port models it as a discriminated union on `mode`, so the inactive member is
 * unrepresentable instead of garbage; every native read site switches on `mode` anyway, so no
 * behaviour changes and a mis-read stops being possible.
 *
 * PORT-NOTE(monitor/setTarget-is-native-private): native `setTarget` is private with
 * `friend class Listener; friend class MonitorManager;`. TypeScript has no friendship, so the
 * method is public here and documented as native-private: only `Listener` (the death
 * callback below) and `MonitorManager` may call it. Do not treat it as part of the lane's
 * public API.
 */

import { Signal } from './signal';
import type { AgentDeathListener, TrackedAgent } from './simSurface';

/** Native `AgentTracker::Mode`. Values pinned by `vectors/enums.json`. */
export const TrackerMode = {
  FITNESS: 0,
  NUMBER: 1,
} as const;
export type TrackerMode = (typeof TrackerMode)[keyof typeof TrackerMode];

/** Native `AgentTracker::Parms` — see `PORT-NOTE(monitor/parms-union)`. */
export type TrackerParms =
  | { readonly mode: typeof TrackerMode.FITNESS; readonly trackTilDeath: boolean; readonly rank: number }
  | { readonly mode: typeof TrackerMode.NUMBER; readonly trackTilDeath: boolean; readonly number: number };

/** Native `AgentTracker::Parms::createFitness( rank, trackTilDeath = true )`. */
export function createFitnessParms(rank: number, trackTilDeath = true): TrackerParms {
  return { mode: TrackerMode.FITNESS, trackTilDeath, rank };
}

/** Native `AgentTracker::Parms::createNumber( number, trackTilDeath = true )`. */
export function createNumberParms(number: number, trackTilDeath = true): TrackerParms {
  return { mode: TrackerMode.NUMBER, trackTilDeath, number };
}

export class AgentTracker {
  /** Native `util::Signal<AgentTracker *> targetChanged` — emits `this`. */
  readonly targetChanged: Signal<[AgentTracker]> = new Signal<[AgentTracker]>();

  private readonly name: string;
  private readonly parms: TrackerParms;
  private target: TrackedAgent | null = null;

  /**
   * Native `AgentTracker::Listener` — a nested `AgentListener` that clears the target when the
   * tracked agent dies.
   *
   * NOTE for lane L8: native `agent::removeListener` is a no-op while `!fAlive`, so the
   * listener stays registered on the dying agent; the tracker calls it regardless (see
   * `simSurface.ts` → `TrackedAgent.removeListener`).
   */
  private readonly listener: AgentDeathListener = {
    died: (_a: TrackedAgent): void => {
      this.setTarget(null);
    },
  };

  constructor(name: string, parms: TrackerParms) {
    this.name = name;
    this.parms = parms;
  }

  getName(): string {
    return this.name;
  }

  getTarget(): TrackedAgent | null {
    return this.target;
  }

  getParms(): TrackerParms {
    return this.parms;
  }

  /**
   * Native `AgentTracker::getStateTitle()` — the label a UI shows for this tracker:
   * `"T<rank>:<number>"` / `"<rank>:<number>"` (fitness mode), `"T:<number>"` / `":<number>"`
   * (number mode), or `"No Agent"` with no target. `T` is the `trackTilDeath` marker.
   *
   * Native has a `char buf[128]` and can truncate; the port has no fixed buffer, so a title
   * longer than 127 bytes is returned whole instead of truncated. Recorded in PARITY.md →
   * Deviations (the title is UI text, never written to a frozen artifact).
   */
  getStateTitle(): string {
    if (this.target !== null) {
      const prefix = this.parms.trackTilDeath ? 'T' : '';
      const number = this.target.Number();

      switch (this.parms.mode) {
        case TrackerMode.FITNESS:
          return `${prefix}${this.parms.rank}:${number}`;
        case TrackerMode.NUMBER:
          return `${prefix}:${number}`;
      }
    }

    return 'No Agent';
  }

  /**
   * Native `AgentTracker::setTarget( agent *a )` — native-private, see the PORT-NOTE above.
   *
   * Re-registers the death listener only when the target actually changes, and emits
   * `targetChanged` only then (native's `if( a != target )` guard).
   */
  setTarget(a: TrackedAgent | null): void {
    if (a !== this.target) {
      if (this.target !== null) this.target.removeListener(this.listener);

      this.target = a;

      if (this.target !== null) this.target.addListener(this.listener);

      this.targetChanged.emit(this);
    }
  }
}
