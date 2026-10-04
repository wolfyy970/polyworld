/**
 * Lane L14 — `StatusTextMonitor` (`library/monitor/Monitor.h:180-201`, `Monitor.cc:259-322`):
 * the monitor that **writes a frozen artifact**, `run/stats/stat.<timestep>`.
 *
 * `run/stats/**` is inside the compared `run/` tree (`PARITY.md`, `PORT_SPEC.md` "Frozen
 * surface"), and the recorded goldens pin this monitor's contribution exactly:
 *
 * ```
 *   oracle/minitest_voff/run/stats/  ->  stat.1 stat.100 stat.200 stat.300   (endStep 301)
 *   oracle/microtest_voff/run/stats/ ->  stat.1                             (endStep 1)
 * ```
 *
 * With `--ui term`, `etc/term.mf` (`@defaults term`) resolves `FrequencyDisplay = 100`,
 * `FrequencyStore = 100`, `StorePerformance = False` (pinned against the native proplib
 * resolution in `native/vectors/monitorConfig.term.json`), so the four (resp. one) files above
 * are exactly what `(timestep == 1) || (timestep % frequencyStore == 0)` produces for the steps
 * the monitor was stepped on (1..MaxSteps), and nothing else. The **contents** come from
 * `Simulation::getStatusText` (lane L11); the lane's own contribution is the gating, the file
 * name, the `"Rate"` filter and the byte layout — each of which
 * `tests/monitor.test.ts` replays against those golden files.
 *
 * PORT-NOTE(monitor/status-text-gating): the display branch additionally requires
 * `update.receivers() > 0` — a monitor with no listener never refreshes the display, but still
 * *stores* (`doStore` has no such condition). That asymmetry is why a headless `--ui term` run
 * (the terminal UI connects a receiver) and a GUI run can differ in *how often the text is
 * recomputed* while producing identical stat files.
 *
 * PORT-NOTE(monitor/status-text-rate-filter): native keeps a line unless
 * `storePerformance || strncmp( line, "Rate", 4 ) != 0`, i.e. with `StorePerformance False` it
 * drops lines whose **first four bytes** are `Rate`. `EatRate = 85.5` and `MateRate = 0.16`
 * survive (the prefix is not at offset 0); the performance lines `getStatusText` appends
 * (`Rate …`) are the ones dropped. The comparison is byte-wise on the raw line, so the port
 * compares the first four code units — lines arrive from `latin1`-decoded files, one byte per
 * code unit.
 *
 * PORT-NOTE(monitor/status-text-file-write): native does
 * `sprintf( "run/stats/stat.%ld", timestep )` + `makeParentDir` + `fopen( ..., "w" )` +
 * `fprintf( "%s\n", line )` per line + `fclose`. The port builds the same path and the same
 * bytes but hands them to an injected `StatusTextStore`, because a browser has no `fopen`;
 * `makeParentDir` becomes the store's responsibility and is called out in the interface. A
 * failed open is `ERRIF` → throw, never a silent skip.
 */

import { Monitor, MonitorType } from './monitor';
import { Signal } from './signal';
import type { MonitorSim } from './simSurface';

/**
 * Where the status text is written (native `fopen`/`makeParentDir`/`fprintf`/`fclose`).
 *
 * Implementations must create the parent directory exactly as native `makeParentDir` does and
 * write the text with native's `"w"` (truncate) semantics; the monitor hands over the whole
 * file body in one call.
 */
export interface StatusTextStore {
  writeTextFile(path: string, text: string): void;
}

/** Native `sprintf( statusFileName, "run/stats/stat.%ld", timestep )`. */
export function statFilePath(timestep: number): string {
  return `run/stats/stat.${timestep}`;
}

/** The bytes native's per-line `fprintf( statusFile, "%s\n", line )` produces. */
export function statusFileBody(lines: readonly string[], storePerformance: boolean): string {
  let body = '';
  for (const line of lines) {
    if (storePerformance || line.slice(0, 4) !== 'Rate') body += `${line}\n`;
  }
  return body;
}

export class StatusTextMonitor extends Monitor {
  /** Native `util::Signal<> update` — emitted when the display copy is refreshed. */
  readonly update: Signal<[]> = new Signal<[]>();

  /** Native `sim::StatusText statusText` — the current lines (native holds `char *`s). */
  private statusText: string[] = [];

  private readonly frequencyDisplay: number;
  private readonly frequencyStore: number;
  private readonly storePerformance: boolean;
  private readonly store: StatusTextStore;

  constructor(
    sim: MonitorSim,
    frequencyDisplay: number,
    frequencyStore: number,
    storePerformance: boolean,
    store: StatusTextStore,
  ) {
    super(MonitorType.STATUS_TEXT, sim, 'textstatus', 'Text Status', 'Text Status');

    this.frequencyDisplay = frequencyDisplay;
    this.frequencyStore = frequencyStore;
    this.storePerformance = storePerformance;
    this.store = store;
  }

  /** Native `sim::StatusText &getStatusText()`. */
  getStatusText(): readonly string[] {
    return this.statusText;
  }

  /** Native `StatusTextMonitor::step( long timestep )`. */
  step(timestep: number): void {
    const doDisplay =
      (timestep === 1 || timestep % this.frequencyDisplay === 0) && this.update.receivers() > 0;
    const doStore = timestep === 1 || timestep % this.frequencyStore === 0;

    if (doDisplay || doStore) {
      // Native frees each `strdup`ed line here; the port's lines are plain strings.
      this.statusText = [];

      this.sim.getStatusText(this.statusText, this.frequencyStore);

      if (doDisplay) {
        this.update.emit();
      }

      if (doStore) {
        this.store.writeTextFile(
          statFilePath(timestep),
          statusFileBody(this.statusText, this.storePerformance),
        );
      }
    }
  }
}
