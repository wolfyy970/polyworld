/**
 * Lane L12 (logs) — the two recorders that are neither datalib nor model-state tables
 * (`logs/Logs.cc`):
 *
 *   Logs::AdamiComplexityLog   run/genome/AdamiComplexity-{1bit,2bit,4bit,summary}.txt (append)
 *   Logs::GitRevisionLog       run/gitrevision.txt
 *
 * Both are off in every recorded scenario (`RecordAdamiComplexity False`, `RecordGitRevision
 * False`) and both are *subsystem* recorders rather than recorders of a value the sim owns:
 * `AdamiComplexityLog` shells out to lane L13's `computeAdamiComplexity( … , FILE*, … )`, and
 * `GitRevisionLog` shells out to `git` through the native `SYSTEM` macro.
 *
 * PORT-NOTE(l12/system-call): native `SYSTEM( cmd )` (`utils/misc.h:135`) runs the command and
 * `exit(1)`s on a non-zero status. The port routes it through the file seam's `system`, so the
 * node adapter runs it and a browser adapter can refuse (there is no shell in a browser; the
 * only two call sites — `git rev-parse HEAD` and the `sort -n` pass, which the port does not
 * need — are both disabled in the recorded scenarios). A failure still has to be loud: the
 * node adapter throws where native exits.
 *
 * PORT-NOTE(l12/adami-max-open-files): `AdamiComplexityLog::getMaxOpenFiles()` returns a
 * *constant* 4 (it opens four files per record), unlike the base class' scope-derived count.
 * The port keeps the override.
 */

import { Event_SimInited, Event_StepEnd } from '../types';
import type { Config, SimEvent } from '../types';
import { FileLogger, Logger, StateScope } from './logger';
import type { LogContext, LogSimulation } from './seams';

/** The four `AdamiComplexity` files, in native's creation order. */
export const ADAMI_COMPLEXITY_PATHS: readonly string[] = [
  'run/genome/AdamiComplexity-1bit.txt',
  'run/genome/AdamiComplexity-2bit.txt',
  'run/genome/AdamiComplexity-4bit.txt',
  'run/genome/AdamiComplexity-summary.txt',
];

/** Native `Logs::AdamiComplexityLog`. */
export class AdamiComplexityLog extends FileLogger {
  private _frequency = 0;

  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordAdamiComplexity')) {
      this._frequency = doc.getInt('AdamiComplexityRecordFrequency');

      this.initRecording(sim, StateScope.NULL, Event_StepEnd);
    }
  }

  /** Native `AdamiComplexityLog::getMaxOpenFiles()` — a constant, not the scope's count. */
  override getMaxOpenFiles(): number {
    return 4;
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_StepEnd: {
        if (this.getStep() % this._frequency !== 0) return;

        const [oneBit, twoBit, fourBit, summary] = ADAMI_COMPLEXITY_PATHS.map((path) =>
          this.createFile(path, 'a'),
        );

        this.env.computeAdamiComplexity(this.getStep(), oneBit!, twoBit!, fourBit!, summary!);

        // "Done computing AdamiComplexity. Close our log files."
        oneBit!.close();
        twoBit!.close();
        fourBit!.close();
        summary!.close();
        return;
      }
      default:
        return super.processEvent(event);
    }
  }
}

/** Native `Logs::GitRevisionLog` — holds no state at all (`NullStateScope`). */
export class GitRevisionLog extends Logger {
  constructor(env: LogContext) {
    super(env);
  }

  override init(sim: LogSimulation, doc: Config): void {
    if (doc.getBool('RecordGitRevision')) {
      this.initRecording(sim, StateScope.NULL, Event_SimInited);
    }
  }

  override processEvent(event: SimEvent): void {
    switch (event.type as number) {
      case Event_SimInited:
        // Native: `SYSTEM( "git rev-parse HEAD > run/gitrevision.txt" )`.
        this.env.fs.system('git rev-parse HEAD > run/gitrevision.txt');
        return;
      default:
        return super.processEvent(event);
    }
  }
}
