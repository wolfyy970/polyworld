/**
 * Lane L12 (logs) — the `TextSink` that really formats.
 *
 * Native's recorders hold an `AbstractFile *` (or a `FILE *`) and use **two** write shapes on it:
 *
 *   fprintf( f, "%s", line )          — the recorder formats the line itself
 *                                       (`AgentEnergyLog`, `PopulationLog`, …)
 *   fprintf( f, format, ...args )     — the *writer* supplies the values
 *                                       (`complexity/adami.cc`, and every `Brain::dump*`, which
 *                                       goes through `AbstractFile::printf`)
 *
 * The port's `TextSink.printf(text)` froze only the first shape. A caller using the second had its
 * arguments **silently dropped** — TypeScript accepts a one-parameter method where a rest-parameter
 * signature is expected — so the file received the format string itself. Measured 2026-09-28 on
 * `microtest_voff` (task t_e76d9e7a): `run/brain/anatomy/brainAnatomy_10_birth.txt.gz` line 1 read
 *
 *   brain %ld fitness=%g numneurons+1=%d maxWeight=%g maxBias=%g %s=%d-%d …
 *
 * where the golden reads
 *
 *   brain 10 fitness=0 numneurons+1=38 maxWeight=8 maxBias=8 redinput=2-10 greeninput=11-19 …
 *
 * PORT-NOTE(l12/text-sink-format): one sink now serves both shapes, which is what native's
 * `AbstractFile` did. **No extra arguments** means "this text is the line" — `%` stays literal,
 * because `'% Timestep Event Agent# Parent1 Parent2\n'` (`BirthsDeathsLog`) is a real recorder line
 * written with `fprintf( f, "%s", line )`. **One or more** means native's format plus its values,
 * and the sink applies the format with lane L6's pinned `sprintfC` (`brain/core/cformat.ts`) — the
 * port's only C-format implementation, and the one that has `%g` (W1c's `datalib/printf.ts`
 * deliberately rejects it). The brain lane is imported for it exactly as `brainLogs.ts` already
 * imports `brainConfig`/`LearningMode`; nothing here is a second implementation of the model.
 *
 * PORT-NOTE(l12/text-sink-format-not-a-model-decision): formatting cannot change model state — the
 * recorders write *after* the step that produced the values — so this seam is free to be the place
 * that fixes the shape. It is also the only place that can: the sink a recorder hands out is
 * produced by the run's `RecordFileSystem` (another lane's object, node or browser), and the
 * consumers that write C formats (`Brain` here, lane L13's `computeAdamiComplexity`, whose
 * `adami.cc` is nothing but `fprintf( file, "%.4f %.4f", a, b )`) receive it as an opaque
 * `TextSink`.
 *
 * The lane's two logger bases therefore wrap every sink they hand out, so a recorder's file is
 * formatting-capable whatever backend opened it. A caller that opens a sink directly through
 * `RecordFileSystem.openPlain/openAbstract` (as `BrainComplexityLog.writeBestRecent` does) still
 * gets the raw backend sink and must pre-format its line, exactly like the native `fprintf(f,
 * "%s", …)` call site it is transcribed from.
 */

import { sprintfC } from '../brain/core/cformat';
import type { PrintfArg, TextSink } from './seams';

/** Native `AbstractFile`'s two write shapes, over any `TextSink`. */
class CFormatTextSink implements TextSink {
  constructor(private readonly sink: TextSink) {}

  /** Native `fprintf( f, "%s", text )` with no values, `fprintf( f, format, ... )` with them. */
  printf(text: string, ...args: readonly PrintfArg[]): void {
    this.sink.printf(args.length === 0 ? text : sprintfC(text, ...args));
  }

  flush(full?: boolean): void {
    this.sink.flush(full);
  }

  close(): void {
    this.sink.close();
  }
}

/**
 * Wrap `sink` so it accepts native's format-plus-values shape (see the module note). Idempotent:
 * wrapping an already-wrapped sink returns it unchanged, so a logger and its caller cannot stack
 * two format passes onto the same file.
 */
export function cFormatTextSink(sink: TextSink): TextSink {
  return sink instanceof CFormatTextSink ? sink : new CFormatTextSink(sink);
}
