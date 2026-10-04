/**
 * Lane L14 — `SceneMonitor` (`Monitor.h:232-255`, `Monitor.cc:387-427`): one scene's worth of
 * monitor: a camera controller, a renderer, and (optionally) a movie recorder.
 *
 * The step order is load-bearing and is kept verbatim:
 *
 * ```
 *   movieController->step( timestep );   // connect/disconnect the recorder for this step
 *   cameraController->step();            // move the camera
 *   renderer->render();                  // draw (and fire renderComplete -> record a frame)
 * ```
 *
 * i.e. the recorder is connected *before* the render it wants, and the camera has already
 * advanced by the time the frame is drawn. Swapping any two of these changes which frame is
 * recorded at which timestep.
 *
 * PORT-NOTE(monitor/scene-monitor-title): native passes `_name` for **both** the monitor name
 * and its title (`Monitor( SCENE, _sim, _id, _name, _name )`), unlike every other monitor,
 * whose title is a separate string. Ported as-is; `MonitorManager` passes the scene document's
 * `Name` for both.
 *
 * PORT-NOTE(monitor/scene-movie-writer-injection): native constructs the `FILE*` +
 * `PwMovieWriter` inside `SceneMovieController`; the port injects a `MovieWriterFactory`
 * because a browser cannot `fopen` (see `movieWriter.ts`). The factory is called only when
 * `MovieSettings::shouldRecord()` is true, i.e. exactly when native would open the file.
 */

import { Monitor, MonitorType } from './monitor';
import { SceneMovieController, shouldRecord, type MovieSettings } from './movieController';
import type { MovieWriter, MovieWriterFactory } from './movieWriter';
import type { CameraController } from './cameraController';
import type { SceneRendererSurface } from './sceneRenderer';
import type { MonitorSim } from './simSurface';

export class SceneMonitor extends Monitor {
  private readonly renderer: SceneRendererSurface;
  private readonly cameraController: CameraController;
  private readonly movieController: SceneMovieController | null;

  constructor(
    sim: MonitorSim,
    id: string,
    name: string,
    renderer: SceneRendererSurface,
    cameraController: CameraController,
    movieSettings: MovieSettings,
    createMovieWriter: MovieWriterFactory,
  ) {
    super(MonitorType.SCENE, sim, id, name, name);

    this.renderer = renderer;
    this.cameraController = cameraController;

    if (shouldRecord(movieSettings)) {
      const writer: MovieWriter = createMovieWriter(movieSettings.moviePath);
      this.movieController = new SceneMovieController(renderer, writer, movieSettings);
    } else {
      this.movieController = null;
    }
  }

  getRenderer(): SceneRendererSurface {
    return this.renderer;
  }

  getCameraController(): CameraController {
    return this.cameraController;
  }

  /** The movie controller, for tests and for a UI that wants the frame state. */
  getMovieController(): SceneMovieController | null {
    return this.movieController;
  }

  step(timestep: number): void {
    if (this.movieController !== null) this.movieController.step(timestep);

    this.cameraController.step();
    this.renderer.render();
  }
}
