/**
 * Lane L14 — `MonitorManager` (`library/monitor/MonitorManager.{h,cc}`): **monitor selection**.
 *
 * Everything this class does is a function of two documents and the simulation's state:
 *
 * ```
 *   etc/monitors.mfs   schema (defaults for every monitor/scene/tracker option; applied by
 *                      the caller or by monitorDocument.ts, in native's order:
 *                      buildSchemaDocument -> buildDocument -> apply)
 *   <ui>.mf            the document, e.g. etc/term.mf = "@defaults term" only
 * ```
 *
 * The construction *sequence* is the observable contract of this lane (the order of the
 * monitor list, which monitor exists at all, and the camera/movie parameters each scene gets).
 * It is ported statement for statement, including the places native gives up:
 *
 * ```
 *   charts            BirthRate, Fitness, FoodEnergy, Population        (Enabled)
 *   agent trackers    AgentTrackers[] -> Fitness|Number x TrackMode     (in document order)
 *   brain             Brain.Enabled -> Frequency + AgentTracker lookup
 *   POV               POV.Enabled
 *   status text       StatusText.Enabled -> Frequency{Display,Store} + StorePerformance
 *   farm              isFarmEnv() && Farm.Enabled -> Frequency + Properties[]
 *   scenes            MainScene, OverheadScene, SinglePOVScene (fixed order, Enabled only)
 * ```
 *
 * PORT-NOTE(monitor/manager-takes-documents): native's constructor builds the two documents
 * itself (`builder.buildSchemaDocument("./etc/monitors.mfs")` + `buildDocument( monitorPath )`
 * + `pschema->apply( pdoc )`). The port takes the already-built, schema-applied document root
 * as a `PropertyNode` so that this file needs no file system and no proplib import;
 * `monitorDocument.ts` performs native's three document steps for a caller that has paths, and
 * that is what the tests drive.
 *
 * PORT-NOTE(monitor/fatal-errors-are-throws): native's failure paths are
 * `cerr << "Invalid CameraSettings Name: " << name; exit(1)` (and the twin for the camera
 * controller, `findAgentTracker`'s `"Invalid AgentTracker name: "`, and three `assert(false)`
 * for unknown enum values). The native build has assertions *enabled* (measured: `nm -u
 * lib/libpolyworld.dylib` lists `___assert_rtn`), so all four abort. The port throws an Error
 * carrying native's message text — never a default camera, never a skipped monitor.
 *
 * PORT-NOTE(monitor/scene-renderer-and-writer-seams): a scene needs a renderer
 * (`SceneRenderer::create( sim->getStage(), … )`) and, if it records, a movie writer
 * (`PwMovieWriter`). Both are implemented outside this lane (L15/L16/L18 and the utils lanes),
 * so both arrive as injected factories; the *selection* of which scene exists and with which
 * parameters is this lane's, and is unchanged by the injection.
 */

import { createConfig } from '../types';
import type { PropertyNode } from '../types';
import { AgentTracker, createFitnessParms, createNumberParms, TrackerMode } from './agentTracker';
import { BrainMonitor, PovMonitor } from './brainMonitor';
import {
  BirthRateMonitor,
  FitnessMonitor,
  FoodEnergyMonitor,
  PopulationMonitor,
} from './charts';
import {
  CameraController,
  Perspective,
  agentTrackingParms,
  rotationParms,
  staticParms,
} from './cameraController';
import { globals } from '../types';
import {
  FarmMonitor,
  farmProperty,
  processEnvironment,
  type CppPropertyMetadataProvider,
  type FarmEnvironment,
  type FarmRunner,
} from './farmMonitor';
import { Monitor, type MonitorDumpSink } from './monitor';
import { movieSettings } from './movieController';
import type { MovieWriterFactory } from './movieWriter';
import { SceneMonitor } from './sceneMonitor';
import {
  cameraProperties,
  DEFAULT_CAMERA_PROPERTIES,
  type CameraProperties,
  type SceneRendererFactory,
} from './sceneRenderer';
import { StatusTextMonitor, type StatusTextStore } from './statusTextMonitor';
import type { MonitorSim } from './simSurface';

/** Native `const char *scenes[] = { "MainScene", "OverheadScene", "SinglePOVScene" }`. */
export const SCENE_NAMES = ['MainScene', 'OverheadScene', 'SinglePOVScene'] as const;

export interface MonitorManagerDeps {
  /** Native `SceneRenderer::create( stage, cameraProps, width, height )` (L15/L16/L18). */
  createSceneRenderer: SceneRendererFactory;
  /** Native `new PwMovieWriter( fopen( path, "wb" ) )` (utils lanes — see movieWriter.ts). */
  createMovieWriter: MovieWriterFactory;
  /** Native `fopen( run/stats/stat.N, "w" )` (no `fopen` in a browser). */
  statusTextStore: StatusTextStore;
  /** Native `proplib::CppProperties::getMetadata()` (lane W1h — docs/specs/cppprops.md). */
  cppProperties: CppPropertyMetadataProvider;
  /** Native `system()` for the farm monitor. */
  farmRunner: FarmRunner;
  /** Native `getenv()` for `FarmMonitor::isFarmEnv()`. */
  farmEnvironment?: FarmEnvironment;
}

export class MonitorManager {
  private readonly simulation: MonitorSim;
  private readonly monitors: Monitor[] = [];
  private readonly agentTrackers: AgentTracker[] = [];
  private readonly deps: MonitorManagerDeps;

  /**
   * Native `MonitorManager( TSimulation *simulation, std::string monitorPath )` — with the
   * documents supplied instead of built here (see `PORT-NOTE(monitor/manager-takes-documents)`).
   */
  constructor(simulation: MonitorSim, doc: PropertyNode, deps: MonitorManagerDeps) {
    this.simulation = simulation;
    this.deps = deps;

    const root = createConfig(doc);

    // --- Charts ---------------------------------------------------------- #
    if (root.at('BirthRate').getBool('Enabled')) this.addMonitor(new BirthRateMonitor(simulation));
    if (root.at('Fitness').getBool('Enabled')) this.addMonitor(new FitnessMonitor(simulation));
    if (root.at('FoodEnergy').getBool('Enabled')) this.addMonitor(new FoodEnergyMonitor(simulation));
    if (root.at('Population').getBool('Enabled'))
      this.addMonitor(new PopulationMonitor(simulation));

    // --- Agent Trackers -------------------------------------------------- #
    //
    // PORT-NOTE(monitor/number-tracker-ignores-trackmode): native computes
    // `bool trackTilDeath = trackMode == "Agent"` in *both* tracker arms
    // (`MonitorManager.cc:69` and `:76`) but only the Fitness arm uses it. The Number arm
    // throws its local away — `parms = AgentTracker::Parms::createNumber( number )`
    // (`MonitorManager.cc:78`) takes the factory default (`AgentTracker.h:24`,
    // `trackTilDeath = true`). So the local at `:76` is dead code and a
    // `SelectionMode Number` tracker holds its agent until death whatever the document's
    // `TrackMode` says (`TrackMode Slot` included — `etc/monitors.mfs`'s enum is
    // `Agent | Slot`). The port reproduces the dead local by *not* forwarding it: calling
    // `createNumberParms( number, trackTilDeath )` here would be a silent fix of C++ that
    // looks wrong (PORT_SPEC rule 1). Pinned in `tests/monitor.test.ts` band 2 with the
    // in-memory document double: `Number` + `TrackMode Slot` ⇒ `parms.trackTilDeath === true`,
    // while the Fitness arm *does* forward its local.
    for (const element of root.getArray('AgentTrackers')) {
      const trackerCfg = createConfig(element);
      const name = trackerCfg.getString('Name');
      const trackMode = trackerCfg.getString('TrackMode');
      const selectionMode = trackerCfg.getString('SelectionMode');

      if (selectionMode === 'Fitness') {
        const rank = trackerCfg.at('Fitness').getInt('Rank');
        // Native forwards the local here (`MonitorManager.cc:69,71`) …
        const trackTilDeath = trackMode === 'Agent';
        this.addAgentTracker(new AgentTracker(name, createFitnessParms(rank, trackTilDeath)));
      } else if (selectionMode === 'Number') {
        const number = trackerCfg.getInt('Number');
        // … and here it is computed and dropped (`MonitorManager.cc:76,78`) — see the
        // PORT-NOTE above. Do not "fix" this call.
        this.addAgentTracker(new AgentTracker(name, createNumberParms(number)));
      } else {
        // Native `assert( false )` (assertions enabled).
        throw new Error(`MonitorManager: invalid AgentTrackers SelectionMode '${selectionMode}'`);
      }
    }

    // --- Brain ----------------------------------------------------------- #
    if (root.at('Brain').getBool('Enabled')) {
      const brain = root.at('Brain');
      const frequency = brain.getInt('Frequency');
      const trackerName = brain.getString('AgentTracker');
      const tracker = this.findAgentTracker(trackerName);

      this.addMonitor(new BrainMonitor(simulation, frequency, tracker));
    }

    // --- POV ------------------------------------------------------------- #
    if (root.at('POV').getBool('Enabled')) this.addMonitor(new PovMonitor(simulation));

    // --- Status Text ----------------------------------------------------- #
    if (root.at('StatusText').getBool('Enabled')) {
      const statusText = root.at('StatusText');

      this.addMonitor(
        new StatusTextMonitor(
          simulation,
          statusText.getInt('FrequencyDisplay'),
          statusText.getInt('FrequencyStore'),
          statusText.getBool('StorePerformance'),
          deps.statusTextStore,
        ),
      );
    }

    // --- Farm ------------------------------------------------------------ #
    const env = deps.farmEnvironment ?? processEnvironment;
    if (FarmMonitor.isFarmEnv(env) && root.at('Farm').getBool('Enabled')) {
      const farm = root.at('Farm');
      const properties = farm.getArray('Properties').map((element) => {
        const cfg = createConfig(element);
        return farmProperty(cfg.getString('Name'), cfg.getString('Title'));
      });

      this.addMonitor(
        new FarmMonitor(
          simulation,
          farm.getInt('Frequency'),
          properties,
          deps.cppProperties,
          deps.farmRunner,
        ),
      );
    }

    // --- Scenes ---------------------------------------------------------- #
    for (const sceneName of SCENE_NAMES) {
      const scene = createConfig(root.node(sceneName));

      if (!scene.getBool('Enabled')) continue;

      // Camera settings: find the entry whose Name matches, else native exits.
      const cameraSettingsName = scene.getString('CameraSettings');
      let cameraPropertiesValue: CameraProperties = DEFAULT_CAMERA_PROPERTIES;
      let foundSettings = false;
      for (const element of root.getArray('CameraSettings')) {
        const settings = createConfig(element);
        if (settings.getString('Name') === cameraSettingsName) {
          foundSettings = true;
          cameraPropertiesValue = cameraProperties(
            readColor(settings.node('Color')),
            settings.getFloat('FieldOfView'),
          );
          break;
        }
      }
      if (!foundSettings) {
        throw new Error(`Invalid CameraSettings Name: ${cameraSettingsName}`);
      }

      // Buffer
      const bufferWidth = scene.at('Buffer').getInt('Width');
      const bufferHeight = scene.at('Buffer').getInt('Height');

      // Renderer
      const renderer = this.deps.createSceneRenderer(
        simulation.getStage(),
        cameraPropertiesValue,
        bufferWidth,
        bufferHeight,
      );

      // Camera controller
      const cameraControllerSettingsName = scene.getString('CameraControllerSettings');
      let cameraController: CameraController | null = null;
      for (const element of root.getArray('CameraControllerSettings')) {
        if (cameraController !== null) break;

        const settings = createConfig(element);
        if (settings.getString('Name') !== cameraControllerSettingsName) continue;

        const mode = settings.getString('Mode');

        if (mode === 'Rotate') {
          const rotate = createConfig(settings.node('Rotate'));
          const radius = rotate.getFloat('Radius');
          const height = rotate.getFloat('Height');
          const rate = rotate.getFloat('Rate');
          const angleStart = rotate.getFloat('AngleStart');
          const fixation = createConfig(rotate.node('Fixation'));
          const fixX = fixation.getFloat('X');
          const fixY = fixation.getFloat('Y');
          const fixZ = fixation.getFloat('Z');

          cameraController = new CameraController(renderer.getCamera());
          cameraController.initRotation(
            rotationParms(
              radius,
              height,
              rate,
              angleStart,
              fixX * globals.worldsize,
              fixY,
              -1 * fixZ * globals.worldsize,
            ),
          );
        } else if (mode === 'AgentTracking') {
          const tracking = createConfig(settings.node('AgentTracking'));
          const tracker = this.findAgentTracker(tracking.getString('AgentTracker'));

          const perspectiveName = tracking.getString('Perspective');
          let perspective: Perspective;
          if (perspectiveName === 'Overhead') perspective = Perspective.OVERHEAD;
          else if (perspectiveName === 'POV') perspective = Perspective.POV;
          else {
            // Native `assert(false)` (assertions enabled).
            throw new Error(`MonitorManager: invalid AgentTracking Perspective '${perspectiveName}'`);
          }

          cameraController = new CameraController(renderer.getCamera());
          cameraController.initAgentTracking(agentTrackingParms(tracker, perspective));
        } else if (mode === 'Static') {
          const staticCfg = createConfig(settings.node('Static'));
          const height = staticCfg.getFloat('Height');

          cameraController = new CameraController(renderer.getCamera());
          cameraController.initStatic(staticParms(height));
        }
      }

      if (cameraController === null) {
        throw new Error(`Invalid CameraControllerSettings Name: ${cameraControllerSettingsName}`);
      }

      // Movie settings
      const movie = createConfig(scene.node('Movie'));
      const recordMovie = movie.getBool('Record');
      const moviePath = `run/${movie.getString('Path')}`;
      const sampleFrequency = movie.getInt('SampleFrequency');
      const sampleDuration = movie.getInt('SampleDuration');

      const settings = movieSettings(recordMovie, moviePath, sampleFrequency, sampleDuration);

      // Scene monitor (native: `Monitor( SCENE, sim, name, title, title )` -- see
      // sceneMonitor.ts for the id/title-order note).
      const name = scene.getString('Name');
      const title = scene.getString('Title');

      this.addMonitor(
        new SceneMonitor(
          simulation,
          name,
          title,
          renderer,
          cameraController,
          settings,
          this.deps.createMovieWriter,
        ),
      );
    }
  }

  getMonitors(): readonly Monitor[] {
    return this.monitors;
  }

  getAgentTrackers(): readonly AgentTracker[] {
    return this.agentTrackers;
  }

  /**
   * Native `MonitorManager::findAgentTracker( name )` — `cerr << "Invalid AgentTracker name: "
   * << name; exit(1)` when the name is unknown, never a null tracker.
   */
  findAgentTracker(name: string): AgentTracker {
    for (const tracker of this.agentTrackers) {
      if (tracker.getName() === name) return tracker;
    }

    throw new Error(`Invalid AgentTracker name: ${name}`);
  }

  /**
   * Native `MonitorManager::step()` — re-select every tracker's target first (unless it is
   * holding one until death), then step every monitor with `simulation->getStep()`.
   */
  step(): void {
    for (const tracker of this.agentTrackers) {
      const parms = tracker.getParms();
      const target = tracker.getTarget();

      if (target === null || !parms.trackTilDeath) {
        switch (parms.mode) {
          case TrackerMode.FITNESS:
            tracker.setTarget(this.simulation.getCurrentFittest(parms.rank));
            break;
          case TrackerMode.NUMBER:
            tracker.setTarget(this.simulation.getAgentByNumber(parms.number));
            break;
        }
      }
    }

    for (const monitor of this.monitors) {
      monitor.step(this.simulation.getStep());
    }
  }

  dump(out: MonitorDumpSink): void {
    for (const monitor of this.monitors) monitor.dump(out);
  }

  private addMonitor(monitor: Monitor): void {
    this.monitors.push(monitor);
  }

  private addAgentTracker(tracker: AgentTracker): void {
    this.agentTrackers.push(tracker);
  }
}

/**
 * Native `Color( proplib::Property &prop )` — `graphics/graphics.cc:17-20`:
 * `set( (float)prop.get("R"), (float)prop.get("G"), (float)prop.get("B") )`, which leaves the
 * alpha at `1.0` (`Color::set(r,g,b)`). The monitor document's `CameraSettings[].Color` is
 * exactly this shape.
 */
function readColor(node: PropertyNode): { r: number; g: number; b: number; a: number } {
  const cfg = createConfig(node);
  return { r: cfg.getFloat('R'), g: cfg.getFloat('G'), b: cfg.getFloat('B'), a: 1.0 };
}
