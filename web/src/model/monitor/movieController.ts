/**
 * Lane L14 — `MovieSettings` + `SceneMovieController` (`library/monitor/MovieController.{h,cc}`,
 * `MovieRecorder.h`): which steps a scene is recorded at, and the connect/disconnect dance that
 * drives the recorder from the renderer's `renderComplete` signal.
 *
 * **This is the one part of the monitor lane with an oracle-anchored, byte-level consequence.**
 * `run/movie.pmv` is written from this schedule, and although the movie's *bytes* are Tier C
 * (not frozen — `PORT_SPEC.md`), the *frame schedule* is observable in every recorded golden:
 * each `movie.pmv` carries the frame count and the timestep metadata entries that this rule
 * produced. Measured (read from the goldens, not recomputed):
 *
 * ```
 *   minitest_voff   frameCount 301   MaxSteps 301   sampleFrequency 1, sampleDuration 1
 *   minitest_von    frameCount 301   MaxSteps 301   sampleFrequency 1, sampleDuration 1
 *   microtest_voff  frameCount   1   MaxSteps   1   sampleFrequency 1, sampleDuration 1
 *   microtest_von   frameCount   1   MaxSteps   1   sampleFrequency 1, sampleDuration 1
 * ```
 * i.e. with the term defaults one frame per step, so `frameCount === MaxSteps`; a
 * `sampleFrequency > 1` run would instead show `frameCount < MaxSteps` *and* an extra
 * `TIMESTEP` meta entry per gap (the writer emits one whenever `timestep != previous + 1`).
 * `tests/monitor.test.ts` asserts both facts against the goldens.
 *
 * PORT-NOTE(monitor/movie-should-record): `shouldRecord( timestep )` is
 * `record && ((timestep - 1) % sampleFrequency < sampleDuration)` — an **integer** modulo on a
 * possibly non-positive `timestep`, compared against the duration. C++ `%` truncates toward
 * zero and JavaScript's `%` has the same sign-of-dividend semantics, so the port keeps the
 * expression verbatim (the grid in `native/vectors/moviesettings.json` includes `timestep 0`,
 * where the native result is `true` for every valid duration — precisely the kind of edge a
 * "cleaned up" `>= 0` guard would silently change).
 *
 * PORT-NOTE(monitor/movie-big-endian-guard): native `MovieSettings`' constructor disables
 * recording at *compile* time on big-endian hosts (`#if __BIG_ENDIAN__`, with a one-shot
 * stderr warning). No browser target is big-endian and the guard is a constant-false branch on
 * every supported one, so the port drops it; recorded in PARITY.md → Deviations.
 */

import type { Signal, SlotHandle } from './signal';
import type { MovieRecorder, MovieWriter } from './movieWriter';
import type { SceneRendererSurface } from './sceneRenderer';

/** Native `class MovieSettings`. */
export interface MovieSettings {
  readonly record: boolean;
  readonly moviePath: string;
  readonly sampleFrequency: number;
  readonly sampleDuration: number;
}

/** Native `MovieSettings( record, moviePath, sampleFrequency, sampleDuration )`. */
export function movieSettings(
  record: boolean,
  moviePath: string,
  sampleFrequency: number,
  sampleDuration: number,
): MovieSettings {
  return { record, moviePath, sampleFrequency, sampleDuration };
}

/** Native `MovieSettings::shouldRecord()` — the `record` flag alone. */
export function shouldRecord(settings: MovieSettings): boolean {
  return settings.record;
}

/** Native `MovieSettings::shouldRecord( long timestep )`. */
export function shouldRecordAt(settings: MovieSettings, timestep: number): boolean {
  return settings.record && (timestep - 1) % settings.sampleFrequency < settings.sampleDuration;
}

/**
 * Native `class SceneMovieController` — the recorder's driver.
 *
 * Native opens the movie file in the *constructor* (`fopen( ..., "wb" )`, exiting on failure),
 * then on each sampled step connects a slot to the renderer's `renderComplete` and disconnects
 * when the step is not sampled. The first sampled step creates the recorder lazily, from the
 * renderer (`renderer->createMovieRecorder( writer )`). Ported step for step.
 *
 * PORT-NOTE(monitor/movie-file-open): the port does not open a file itself — the browser has no
 * `fopen`. The `MovieWriter` is injected (unlike native, which constructs a `PwMovieWriter`
 * around the `FILE*`). The **pmv encoder itself is not this lane's** (`utils/PwMovieUtils.cc`
 * belongs to the utils lanes and the per-renderer `MovieRecorder` to the graphics lanes); see
 * PARITY.md → Gaps. Everything this file decides — when a frame is recorded, at which
 * timestep, and how many frames the file ends up with — is lane L14's and is what the goldens
 * pin.
 */
export class SceneMovieController {
  private readonly renderer: SceneRendererSurface;
  private readonly settings: MovieSettings;

  private recorder: MovieRecorder | null = null;
  private renderCompleteHandle: SlotHandle | null = null;
  private connectedToRenderer = false;
  private timestep = 0;

  /** Native `SceneMovieController( SceneRenderer *renderer, const MovieSettings &settings )`. */
  constructor(renderer: SceneRendererSurface, writer: MovieWriter, settings: MovieSettings) {
    if (!shouldRecord(settings)) {
      // Native `assert( settings.shouldRecord() )` (assertions enabled).
      throw new Error('SceneMovieController: movie settings say not to record');
    }

    this.renderer = renderer;
    this.settings = settings;
    this.writer = writer;
  }

  /** Native's `PwMovieWriter *writer`, created from the `FILE*` the constructor opened. */
  private readonly writer: MovieWriter;

  /** Native `SceneMovieController::step( long timestep )`. */
  step(timestep: number): void {
    this.timestep = timestep;

    if (shouldRecordAt(this.settings, timestep)) {
      if (!this.connectedToRenderer) {
        this.renderCompleteHandle = this.renderer.renderComplete.connect(() => this.renderComplete());
        this.connectedToRenderer = true;
      }
    } else if (this.connectedToRenderer) {
      this.renderer.renderComplete.disconnect(this.renderCompleteHandle!);
      this.renderCompleteHandle = null;
      this.connectedToRenderer = false;
    }
  }

  /** Native `SceneMovieController::renderComplete()`. */
  private renderComplete(): void {
    if (this.recorder === null) {
      this.recorder = this.renderer.createMovieRecorder(this.writer);
    }

    // Native casts to `uint32_t`; the port keeps the numeric value and leaves the encoder to
    // truncate exactly as the native does.
    this.recorder.recordFrame(this.timestep);
  }

  /** Test/introspection helper: has a slot been connected to the renderer right now? */
  isConnectedToRenderer(): boolean {
    return this.connectedToRenderer;
  }

  /** The signal the controller is listening to (native's private `renderer->renderComplete`). */
  getRenderCompleteSignal(): Signal<[]> {
    return this.renderer.renderComplete;
  }
}
