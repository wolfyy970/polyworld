/**
 * Lane L14 — the `Monitor` base class (`library/monitor/Monitor.h`, `Monitor.cc:15-62`).
 *
 * A monitor is a *passive observer*: it is stepped once per simulation step from
 * `Simulation::stepEnding` (via `MonitorManager::step`) with the current step number, and it
 * reads state — it never writes model state and never consumes RNG (see
 * `simSurface.ts` → `PORT-NOTE(monitor/observer-only)`).
 *
 * PORT-NOTE(monitor/type-enum): the six `Monitor::Type` values and their order are part of the
 * native ABI of the UI dispatch (`TerminalUI.cc:55` and `MainWindow.cc` do
 * `monitor->getType() == Monitor::STATUS_TEXT`), so they are pinned here exactly:
 * CHART 0, BRAIN 1, POV 2, STATUS_TEXT 3, FARM 4, SCENE 5
 * (`src/model/monitor/native/vectors/enums.json`, from the linked library).
 *
 * PORT-NOTE(monitor/dump-is-empty): native `Monitor::dump(ostream&)` is an empty virtual with
 * no overrides anywhere in `library/monitor/**` (only `Monitor::dump` is defined; measured by
 * grep). It exists so a future monitor could report itself. The port keeps the method (so the
 * surface matches) and passes a text sink instead of an `std::ostream`.
 */

import type { MonitorSim } from './simSurface';

/** Native `Monitor::Type`. Values and order matter — see the PORT-NOTE above. */
export const MonitorType = {
  CHART: 0,
  BRAIN: 1,
  POV: 2,
  STATUS_TEXT: 3,
  FARM: 4,
  SCENE: 5,
} as const;
export type MonitorType = (typeof MonitorType)[keyof typeof MonitorType];

/** Where `Monitor::dump` writes (native `std::ostream &`). */
export interface MonitorDumpSink {
  write(text: string): void;
}

export abstract class Monitor {
  protected readonly sim: MonitorSim;

  private readonly type: MonitorType;
  private readonly id: string;
  private readonly name: string;
  private readonly title: string;

  constructor(type: MonitorType, sim: MonitorSim, id: string, name: string, title: string) {
    this.sim = sim;
    this.type = type;
    this.id = id;
    this.name = name;
    this.title = title;
  }

  getType(): MonitorType {
    return this.type;
  }

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getTitle(): string {
    return this.title;
  }

  getSimulation(): MonitorSim {
    return this.sim;
  }

  /** Native `virtual void step( long timestep )` — called with `Simulation::getStep()`. */
  abstract step(timestep: number): void;

  /** Native `virtual void dump( std::ostream &out )` — empty in the native tree. */
  dump(_out: MonitorDumpSink): void {}
}
