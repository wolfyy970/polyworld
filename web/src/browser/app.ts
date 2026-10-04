/**
 * Lane L18 — the shell: wires the booted world, the scene, the camera, the renderer, the HUD
 * and the frame loop.
 *
 * The world it renders comes from `SimulationLike` (`sim/simSeam.ts`). Since L18b that is lane
 * L11's own simulation, behind one factory call (`createModelWorld`, `sim/modelWorld.ts`): the
 * agents on screen are the run's live roster, their positions/yaw/size/colour are the model's, and
 * the step loop is native's `TSimulation::Step`.
 *
 * PORT-NOTE (L18/loop): the sim runs on a fixed dt and the renderer runs on rAF. That is the
 * "deterministic by construction" requirement from PORT_SPEC.md applied to the shell: steps
 * happen on boundaries, so anything that samples per step (movies, logs) is reproducible.
 * PORT-NOTE (L18/perf): one allocation-free frame — no per-frame object/array churn, and the
 * HUD updates at 5 Hz rather than per frame.
 * PORT-NOTE (L18/notice): the shell never hides a gap. A blocked worldfile key (an expression the
 * interpreter cannot evaluate), the end of the run, and a lost WebGL context are all surfaced in
 * the status panel's notice line.
 * PORT-NOTE (L18/end-phase-is-the-destructor): native's end phase is `~TSimulation`, not `End()`:
 * the destructor is what writes `run/endStep.txt` and appends the `DR_SIMEND` rows to
 * `run/lifespans.txt`. `dispose()` therefore disposes the **world** first (the page's sink survives
 * the world, so the finished tree can still be exported) and only then tears the renderer down, so
 * a closed page leaves behind exactly the tree its run owed.
 */

import { createViewport, readViewportStats, type Viewport } from './render/viewport';
import { createCameraRig, type CameraRig } from './render/cameraRig';
import { createSceneRoot, type SceneRoot } from './scene/sceneRoot';
import { createModelWorld, type ModelWorld, type RunFileReport } from './sim/modelWorld';
import { createFixedStepAccumulator, type FixedStepAccumulator } from './sim/fixedStep';
import type { BootedWorld } from './sim/worldBoot';
import { createControlBar, type ControlBar } from './ui/controlBar';
import { createStatusPanel, formatRunFiles, type StatusPanel } from './ui/statusPanel';
import { createHud, createTitlePanel, titleNote, type TitlePanel } from './ui/hud';
import { bindKeyboard } from './ui/keyboard';
import { SHELL_SPEEDS, type ShellConfig } from './config';

/** How often the HUD is refreshed, ms. Faster than this is invisible and costs layout work. */
const UI_INTERVAL_MS = 200;
/** Rate-measurement window, ms. Long enough to be stable, short enough to feel live. */
const RATE_WINDOW_MS = 500;
/** Largest frame delta honoured, ms — a long stall must not fast-forward the world. */
const MAX_FRAME_MS = 250;

/**
 * One file of the run tree the *page* holds: the transport a driver uses so it can write the tree
 * to disk without the page knowing about node (`Runtime.evaluate` hands back strings, and the tree
 * carries gzipped binaries).
 */
export interface RunTreeEntry {
  /** The run-tree path (`run/original.wf`, `run/stats/stat.100`, …). */
  readonly path: string;
  readonly bytes: number;
}

export interface RunTreeFile extends RunTreeEntry {
  /** The file's bytes, base64 — a byte *range* when `runTreeFile` was asked for one. */
  readonly base64: string;
  /** The range this base64 covers (`[from, from + length)` of the file). */
  readonly from: number;
  readonly length: number;
}

/**
 * Base64 of a byte array, in chunks: a single `String.fromCharCode(...bytes)` would exceed the
 * engine's argument limit on a multi-hundred-kilobyte artifact.
 */
function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface ShellOptions {
  mount: HTMLElement;
  config: ShellConfig;
  /** The booted world: parameters, read report and the artifacts it reproduced. */
  boot: BootedWorld;
}

export interface ShellDiagnostics {
  running: boolean;
  speed: number;
  stepIndex: number;
  simSeconds: number;
  agentCount: number;
  agentCapacity: number;
  seed: number;
  digest: number;
  fps: number | null;
  stepsPerSecond: number | null;
  drawCalls: number;
  triangles: number;
  cameraDistance: number;
  cameraPosition: [number, number, number];
  canvasWidth: number;
  canvasHeight: number;
  pixelRatio: number;
  notice: string | null;
  /** The booted scenario and where its sources came from. */
  scenario: string;
  worldfile: string;
  worldSize: number;
  maxSteps: number;
  vision: boolean;
  /** Always `'model'` since L18b: the agents are lane L11's own simulation. */
  flavour: string;
  /** True once the run ended (native `End()`/`MaxSteps`); the shell pauses there. */
  ended: boolean;
  /** What the run wrote into the page's in-memory run tree (`run/**`), when it has one. */
  runFiles: RunFileReport | null;
  /** Food objects the model holds this step (`SimulationLike.food`). */
  foodCount: number;
  /** Brick objects the model holds this step (`SimulationLike.bricks`). */
  brickCount: number;
  /** Walls the worldfile declared, and how many of them are on screen (a degenerate segment is
   *  declared but cannot be drawn). */
  barrierCount: number;
  barriersDrawn: number;
  /** Brick patches the worldfile declared (0 → the world has no bricks to draw). */
  brickPatchesDeclared: number;
  /** Worldfile keys the boot could not read — never substituted. */
  blockedKeys: string[];
  /** Keys read *provisionally* (e.g. `InitAgents` → `MaxAgents` for the display count). */
  provisionalKeys: string[];
  /** Artifacts the boot reproduced, by run-tree path. */
  artifacts: string[];
  readOkCount: number;
}

/**
 * The one place the world implementation is chosen.
 *
 * PORT-NOTE (L18/sim-seam): this is lane L11's `Simulation` behind `SimulationFactory` — the
 * worldfile document and artifact texts the boot already produced and a step sink that is not
 * `node:fs` (the page's in-memory `MemoryRecordFileSystem`, `sim/browserFiles.ts`). The run's own
 * `InitSeed` arrives in the document, because the boot applied it as native's argv parameter.
 */
function bootedSimulation(boot: BootedWorld, stepSeconds: number): ModelWorld {
  return createModelWorld({ boot, stepSeconds });
}

export class PolyworldShell {
  private readonly mount: HTMLElement;
  private readonly config: ShellConfig;
  private readonly boot: BootedWorld;
  private readonly speeds: readonly number[] = SHELL_SPEEDS;

  private readonly viewport: Viewport;
  private readonly rig: CameraRig;
  private readonly sceneRoot: SceneRoot;
  private readonly statusPanel: StatusPanel;
  private readonly titlePanel: TitlePanel;
  private readonly controls: ControlBar;
  private readonly hud: HTMLElement;
  private readonly unbindKeyboard: () => void;
  private readonly detachVisibility: () => void;
  private readonly detachContextHandlers: () => void;

  private readonly world: ModelWorld;
  private readonly accumulator: FixedStepAccumulator;

  private rafId = 0;
  private lastFrameMs = 0;
  private running = true;
  private agentsDirty = true;

  private windowStartMs = 0;
  private framesInWindow = 0;
  private stepsInWindow = 0;
  private fps: number | null = null;
  private stepsPerSecond: number | null = null;

  private lastUiMs = 0;
  private contextNotice: string | null = null;
  private disposed = false;

  constructor(options: ShellOptions) {
    this.mount = options.mount;
    this.config = options.config;
    this.boot = options.boot;

    const params = this.boot.params;
    const stepSeconds = 1 / this.config.stepHz;

    // Viewport first: if WebGL is unavailable this throws before any DOM is built, and the
    // caller (main.ts) turns that into a readable panel instead of a half-built page.
    this.viewport = createViewport(this.mount);
    this.sceneRoot = createSceneRoot({
      params,
      // The world's own agent count wins; `?agents=` is only a capacity *floor*.
      agentCapacity: Math.max(this.config.agents, params.displayAgents),
    });
    this.rig = createCameraRig(
      this.viewport.canvas,
      this.viewport.width() / Math.max(1, this.viewport.height()),
      this.sceneRoot.worldSize,
    );

    this.world = bootedSimulation(this.boot, stepSeconds);
    this.accumulator = createFixedStepAccumulator({
      stepSeconds,
      speed: this.config.speed,
      // 8x speed at 30 Hz needs 4 steps per 60 Hz frame; 16 leaves headroom for 120 Hz
      // displays plus a little jitter without ever queueing a backlog.
      maxStepsPerFrame: 16,
    });

    this.statusPanel = createStatusPanel();
    this.controls = createControlBar(
      {
        toggleRun: () => this.toggleRun(),
        stepOnce: () => this.stepOnce(),
        setSpeed: (speed) => this.setSpeed(speed),
        resetRun: () => this.resetRun(),
        resetView: () => this.resetView(),
      },
      { speeds: this.speeds, initialSpeed: this.config.speed },
    );

    this.titlePanel = createTitlePanel({
      title: 'Polyworld',
      subtitle: `browser port · ${this.boot.scenario.name}`,
      // PORT-NOTE (L20/live-note): the note prints the run tree as the page has it *now*; `updateUi`
      // refreshes it every tick from the same snapshot the status panel's `run files` row takes
      // (`ui/hud.ts`). PORT-NOTE (L20/worldfile-in-the-note): the booted worldfile sentence is part
      // of that builder, not a prefix glued on here — the first tick's `setNote` is the note, so a
      // prefix that only this call site knew would be gone from the page for the rest of the run.
      note: this.headerNote(this.world.runFiles()),
    });
    this.hud = createHud({
      title: this.titlePanel.element,
      status: this.statusPanel.element,
      controls: this.controls.element,
    });
    this.mount.appendChild(this.hud);

    this.unbindKeyboard = bindKeyboard(
      {
        toggleRun: () => this.toggleRun(),
        stepOnce: () => this.stepOnce(),
        resetRun: () => this.resetRun(),
        resetView: () => this.resetView(),
        setSpeedByIndex: (index) => {
          const speed = this.speeds[index];
          if (speed !== undefined) this.setSpeed(speed);
        },
      },
      this.speeds,
    );

    const onVisibility = (): void => {
      // Coming back from a hidden tab, the accumulator would otherwise owe seconds of
      // simulation; drop it and resume from "now".
      this.accumulator.reset();
      this.lastFrameMs = performance.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.detachVisibility = () => document.removeEventListener('visibilitychange', onVisibility);

    const onContextLost = (event: Event): void => {
      // Without preventDefault the browser never fires `webglcontextrestored`; without this
      // handler the loss surfaces as an uncaught error, which the acceptance criteria for
      // this lane forbid.
      event.preventDefault();
      this.contextNotice = 'WebGL context lost — waiting for the browser to restore it.';
      this.updateUi(performance.now(), true);
    };
    const onContextRestored = (): void => {
      this.contextNotice = null;
      this.agentsDirty = true;
      this.updateUi(performance.now(), true);
    };
    const canvas = this.viewport.canvas;
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    this.detachContextHandlers = () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    };

    this.controls.update({ running: this.running, speed: this.config.speed });
    this.updateUi(performance.now(), true);
  }

  /** Begin the rAF loop (and simulated time). */
  start(): void {
    if (this.disposed || this.rafId !== 0) return;
    this.lastFrameMs = performance.now();
    this.windowStartMs = this.lastFrameMs;
    this.rafId = requestAnimationFrame(this.frame);
  }

  play(): void {
    this.setRunning(true);
  }

  pause(): void {
    this.setRunning(false);
  }

  toggleRun(): void {
    this.setRunning(!this.running);
  }

  /** Advance exactly one step; stepping implies pausing (debugger semantics). */
  stepOnce(): void {
    this.setRunning(false);
    this.world.step();
    this.agentsDirty = true;
    this.updateUi(performance.now(), true);
  }

  setSpeed(speed: number): void {
    this.accumulator.setSpeed(speed);
    this.controls.update({ running: this.running, speed });
    this.updateUi(performance.now(), true);
  }

  /**
   * A new run. The model's tables are process-wide (`FoodType`, the RNG surfaces, the object list),
   * exactly as native's are — a second `TSimulation` cannot be constructed in one process, and
   * native's binary runs one simulation per process too. So this is what native does when it wants
   * another run: it starts a new one, with a new `InitSeed` (native `--InitSeed`). The page reloads
   * with that seed on the URL; nothing in this tab pretends the run can be rewound in place.
   */
  resetRun(seed?: number): void {
    const next = seed ?? this.world.seed + 1;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(next));
    window.location.assign(url.toString());
  }

  resetView(): void {
    this.rig.reset();
    this.updateUi(performance.now(), true);
  }

  /**
   * The run tree the **page** wrote, as base64 — the same bytes the run's own sink holds, so a
   * driver can dump them to disk and hand the result to `tools/check_parity.py` as a candidate
   * tree. Read-only: it reports what the run wrote, and never invents a file the run did not
   * (`run/movie.pmv` is absent here exactly as it is absent from a native run's page-side
   * equivalent — the shell mounts the null movie writer, PORT-NOTE (L18/monitors-in-the-page)).
   *
   * The four boot artifacts come first because they exist *before* lane L11's `Simulation` writes
   * its own copy of them (`Simulation.cc:450-451` does the same `cp`); where the run wrote the same
   * path, the run's bytes win, so what a caller compares is the run's output, not the boot's.
   *
   * The tree is served as a manifest plus per-file (or per-file-range) reads because a driver pulls
   * it over single CDP messages: `minitest_voff`'s 1368 files are 16 MB, one of them 7.7 MB, and one
   * message cannot carry that (measured: a single-shot `runTree()` left the driver's await
   * unsettled). `runTreeFile`'s `from`/`length` are **byte** offsets, so a caller can page a large
   * artifact without asking the page for bytes it will not use.
   */
  runTreeManifest(): readonly RunTreeEntry[] {
    const entries = new Map<string, number>();
    for (const [relative, text] of this.boot.artifacts) {
      entries.set(relative, new TextEncoder().encode(text).byteLength);
    }
    const fs = this.world.runFileSystem;
    if (fs !== null) {
      for (const relative of fs.paths()) {
        const bytes = fs.bytes(relative);
        if (bytes !== undefined) entries.set(relative, bytes.byteLength);
      }
    }
    return [...entries].map(([path, bytes]) => ({ path, bytes }));
  }

  /** One file's bytes, base64 (`from`/`length` in bytes; the whole file by default). */
  runTreeFile(path: string, from = 0, length = Number.MAX_SAFE_INTEGER): RunTreeFile | null {
    const bytes = this.fileBytes(path);
    if (bytes === null) return null;
    const start = Math.min(Math.max(from, 0), bytes.byteLength);
    const end = Math.min(bytes.byteLength, start + length);
    return {
      path,
      bytes: bytes.byteLength,
      base64: base64Of(bytes.subarray(start, end)),
      from: start,
      length: end - start,
    };
  }

  /** Several files in one message. Callers batch small files themselves (see `runTreeFile`). */
  runTreeFiles(paths: readonly string[]): readonly RunTreeFile[] {
    const out: RunTreeFile[] = [];
    for (const path of paths) {
      const file = this.runTreeFile(path);
      if (file !== null) out.push(file);
    }
    return out;
  }

  /** A run-tree path's bytes: the run's own copy if it wrote one, else the boot's artifact. */
  private fileBytes(path: string): Uint8Array | null {
    const fs = this.world.runFileSystem;
    if (fs !== null) {
      const bytes = fs.bytes(path);
      if (bytes !== undefined) return bytes;
    }
    const text = this.boot.artifacts.get(path);
    return text === undefined ? null : new TextEncoder().encode(text);
  }

  diagnostics(): ShellDiagnostics {
    const stats = readViewportStats(this.viewport);
    return {
      running: this.running,
      speed: this.accumulator.speed(),
      stepIndex: this.world.stepIndex,
      simSeconds: this.world.simSeconds,
      agentCount: this.world.agents.length,
      agentCapacity: this.sceneRoot.agents.capacity,
      seed: this.world.seed,
      digest: this.world.stateDigest(),
      fps: this.fps,
      stepsPerSecond: this.stepsPerSecond,
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      cameraDistance: this.rig.distance(),
      cameraPosition: [
        this.rig.camera.position.x,
        this.rig.camera.position.y,
        this.rig.camera.position.z,
      ],
      canvasWidth: this.viewport.width(),
      canvasHeight: this.viewport.height(),
      pixelRatio: this.viewport.devicePixelRatio(),
      notice: this.noticeText(),
      scenario: this.boot.scenario.name,
      worldfile: this.boot.sources.worldfilePath,
      worldSize: this.boot.params.worldSize,
      maxSteps: this.boot.params.maxSteps,
      vision: this.boot.params.vision,
      flavour: this.world.flavour,
      ended: this.world.ended,
      runFiles: this.world.runFiles(),
      foodCount: this.world.food.length,
      brickCount: this.world.bricks.length,
      barrierCount: this.boot.params.declaredBarriers,
      barriersDrawn: this.sceneRoot.barriers.drawn,
      brickPatchesDeclared: this.boot.params.declaredBrickPatches,
      blockedKeys: this.boot.report.blocked.map((entry) => entry.key),
      provisionalKeys: this.boot.report.provisional.map((entry) => entry.key),
      artifacts: [...this.boot.artifacts.keys()],
      readOkCount: this.boot.report.ok.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    // Native's end phase lives in `~TSimulation`: it writes `run/endStep.txt` and appends the
    // `DR_SIMEND` kills to `run/lifespans.txt`. A shell that tore down the page without disposing
    // the world would therefore leave the run tree *incomplete* while looking finished — measured
    // (L20): the page's tree was missing `run/endStep.txt` and 111 `lifespans.txt` rows the node
    // path's `world.dispose()` writes. Disposing the world first is what makes the page's tree the
    // same tree (`PORT-NOTE (L18/end-phase-is-the-destructor)`).
    this.world.dispose();
    this.unbindKeyboard();
    this.detachVisibility();
    this.detachContextHandlers();
    this.hud.remove();
    this.rig.dispose();
    this.sceneRoot.dispose();
    this.viewport.dispose();
  }

  private setRunning(running: boolean): void {
    this.running = running;
    if (!running) this.accumulator.reset();
    else this.lastFrameMs = performance.now();
    this.controls.update({ running, speed: this.accumulator.speed() });
    this.updateUi(performance.now(), true);
  }

  /** What the shell wants the viewer to know about the gaps behind what they are looking at. */
  private noticeText(): string | null {
    if (this.contextNotice) return this.contextNotice;
    const parts: string[] = [];
    if (this.world.notice) parts.push(this.world.notice);
    const blocked = this.boot.report.blocked;
    if (blocked.length > 0) {
      parts.push(
        `${blocked.length} worldfile key${blocked.length === 1 ? '' : 's'} not readable yet ` +
          `(worldfile expressions): ${blocked.map((entry) => entry.key).join(', ')}. ` +
          'No value was substituted; the world shown uses only what the file states.',
      );
    }
    // PORT-NOTE (L18/draw-gaps): the scene draws what the worldfile declares — a `Barriers` or
    // `BrickPatches` element whose geometry could not be resolved is dropped by `worldParams.ts`
    // (a note, not a substitution) and this is where the viewer is told, rather than being left
    // with a silently shorter wall or fewer bricks.
    const unattached: string[] = [];
    const declaredBarriers = this.boot.params.declaredBarriers;
    const resolvedBarriers = this.boot.params.barriers.length;
    if (declaredBarriers > resolvedBarriers) {
      unattached.push(`${declaredBarriers - resolvedBarriers} of ${declaredBarriers} barriers`);
    }
    const declaredPatches = this.boot.params.declaredBrickPatches;
    const resolvedPatches = this.boot.params.brickPatches.length;
    if (declaredPatches > resolvedPatches) {
      unattached.push(
        `${declaredPatches - resolvedPatches} of ${declaredPatches} brick patches`,
      );
    }
    if (unattached.length > 0) {
      parts.push(
        `${unattached.join(' and ')} could not be read from the worldfile and are not drawn; ` +
          'the boot report’s notes name the expression that failed.',
      );
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * The note under the title, built from `files` — the caller's snapshot, never a fresh read.
   *
   * PORT-NOTE (L20/live-note): this used to take no argument and sample `this.world.runFiles()`
   * itself, so the boot-time call at construction froze the count while the status panel re-read it
   * every tick. Taking the snapshot as a parameter is what makes that impossible: the only way to
   * build the note is with a reading the caller is already holding.
   *
   * PORT-NOTE (L20/worldfile-in-the-note): the boot facts in this note (the worldfile sentence,
   * the reproduced artifacts, the blocked/provisional key counts) live here and not at the call
   * sites, so the construction call and every `updateUi` tick render the same text — the boot
   * sentence cannot be dropped by the tick the way it was (`t_c824de39`).
   */
  private headerNote(files: RunFileReport | null): string {
    return titleNote({
      worldfile: {
        path: this.boot.sources.worldfilePath,
        worldSize: this.boot.params.worldSize,
        agents: this.boot.params.displayAgents,
        vision: this.boot.params.vision,
        maxSteps: this.boot.params.maxSteps,
      },
      artifacts: [...this.boot.artifacts.keys()],
      recorded: this.boot.scenario.tier !== 'demo',
      blocked: this.boot.report.blocked.length,
      provisional: this.boot.report.provisional.length,
      files,
    });
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    const elapsed = Math.min(Math.max(now - this.lastFrameMs, 0), MAX_FRAME_MS);
    this.lastFrameMs = now;

    // A finished run stays finished: native's own `Step()` is inert once `End()` has run, so the
    // shell stops asking rather than spinning on a no-op (and says so in the notice line).
    if (this.running && this.world.ended) {
      this.setRunning(false);
      this.agentsDirty = true;
    }

    let steps = 0;
    if (this.running) {
      steps = this.accumulator.advance(elapsed);
      for (let i = 0; i < steps; i++) this.world.step();
      if (steps > 0) this.agentsDirty = true;
    }

    this.rig.update();
    this.syncCameraAspect();
    this.draw();
    this.measureRates(now, steps);
    this.updateUi(now, false);
  };

  private draw(): void {
    // The scene is drawn once per frame regardless of how much simulated time passed, so
    // 8x speed costs the same as 1x; only the world's own step cost scales with speed.
    if (this.agentsDirty) {
      // One model step, read once: the four projections share the memo (`modelWorld.ts::refresh`),
      // so the walls, boxes and creatures in a frame are all from the same `fStep`.
      this.sceneRoot.agents.sync(this.world.agents, this.sceneRoot.worldSize);
      this.sceneRoot.barriers.sync(this.world.barriers, this.sceneRoot.worldSize);
      this.sceneRoot.bricks.sync(this.world.bricks, this.sceneRoot.worldSize);
      this.sceneRoot.food.sync(this.world.food, this.sceneRoot.worldSize);
      this.agentsDirty = false;
    }
    this.viewport.renderer.render(this.sceneRoot.scene, this.rig.camera);
  }

  private syncCameraAspect(): void {
    const width = Math.max(1, this.viewport.width());
    const height = Math.max(1, this.viewport.height());
    const aspect = width / height;
    if (Math.abs(this.rig.camera.aspect - aspect) > 1e-6) {
      this.rig.camera.aspect = aspect;
      this.rig.camera.updateProjectionMatrix();
    }
  }

  private measureRates(now: number, steps: number): void {
    this.framesInWindow += 1;
    this.stepsInWindow += steps;
    const span = now - this.windowStartMs;
    if (span < RATE_WINDOW_MS) return;
    this.fps = (this.framesInWindow * 1000) / span;
    // Steps per *wall* second, which is what the number is for: it shows the speed
    // multiplier having an effect, and shows the accumulator clamping if the machine
    // cannot keep up with the requested rate.
    this.stepsPerSecond = (this.stepsInWindow * 1000) / span;
    this.windowStartMs = now;
    this.framesInWindow = 0;
    this.stepsInWindow = 0;
  }

  private updateUi(now: number, force: boolean): void {
    if (!force && now - this.lastUiMs < UI_INTERVAL_MS) return;
    this.lastUiMs = now;

    const stats = readViewportStats(this.viewport);
    // One read of the run tree per tick: the note and the panel's `run files` row are built from
    // this snapshot, so the two numbers on screen cannot disagree (PORT-NOTE (L20/live-note)).
    const files = this.world.runFiles();
    this.titlePanel.setNote(this.headerNote(files));
    this.statusPanel.update({
      subtitle: `${this.boot.scenario.name} · ${this.world.flavour}`,
      scenario: this.boot.scenario.name,
      worldSize: this.boot.params.worldSize,
      agentCount: this.world.agents.length,
      agentCapacity: this.sceneRoot.agents.capacity,
      vision: this.boot.params.vision,
      maxSteps: this.boot.params.maxSteps,
      flavour: this.world.flavour,
      runFiles: formatRunFiles(files),
      ended: this.world.ended,
      blockedKeys: this.boot.report.blocked.length,
      foodCount: this.world.food.length,
      brickCount: this.world.bricks.length,
      barriersDrawn: this.sceneRoot.barriers.drawn,
      barrierCount: this.boot.params.declaredBarriers,
      brickPatchesDeclared: this.boot.params.declaredBrickPatches,
      running: this.running,
      speed: this.accumulator.speed(),
      stepIndex: this.world.stepIndex,
      simSeconds: this.world.simSeconds,
      fps: this.fps,
      stepsPerSecond: this.stepsPerSecond,
      seed: this.world.seed,
      digest: this.world.stateDigest(),
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      cameraDistance: this.rig.distance(),
      notice: this.noticeText(),
    });
  }
}
