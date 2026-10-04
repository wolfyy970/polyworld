/**
 * Lane L18 (browser wiring) — status panel.
 *
 * "Readable" is the requirement, so: one column of micro-cased labels, right-aligned tabular
 * numerals, grouped by subject (world / run / cost / identity), no abbreviations that need a
 * legend except the two obvious ones (fps, draw calls).
 *
 * Since the wiring landed, the panel shows the *world* too: which recorded scenario is booted,
 * what the worldfile says the world is (`WorldSize`, agent count, `Vision`, the run budget),
 * that the agents on screen come from lane L11's simulation (`world data` reads `model`), how many
 * files that run has written into the page's run tree, and how many worldfile keys the boot could
 * not read (the expression evaluator's — see `sim/worldParams.ts`).
 * It consumes `StatusModel` and nothing else.
 */

import { el, setText } from './dom';
import type { RunFileReport } from '../sim/modelWorld';

export interface StatusModel {
  /** One line describing what is on screen (scenario + world flavour). */
  subtitle: string;
  scenario: string;
  worldSize: number;
  agentCount: number;
  agentCapacity: number;
  vision: boolean;
  /** Native `MaxSteps` — the run's step budget. */
  maxSteps: number;
  /** Where the agents come from — `'model'` (lane L11's simulation) since L18b. */
  flavour: string;
  /** The run tree the page's simulation wrote (`count · size`), or `—` without a sink. */
  runFiles: string;
  /** Food objects the model holds this step (drawn boxes). */
  foodCount: number;
  /** Brick objects the model holds this step (drawn boxes). */
  brickCount: number;
  /** Walls the worldfile declared, and how many of them are drawn. */
  barrierCount: number;
  barriersDrawn: number;
  /** Brick patches the worldfile declared (0 → the worldfile has no bricks). */
  brickPatchesDeclared: number;
  /** True once the run ended (native `End()`); the shell pauses and the notice says why. */
  ended: boolean;
  /** How many worldfile keys the boot could not read (an expression it could not evaluate). */
  blockedKeys: number;
  running: boolean;
  speed: number;
  stepIndex: number;
  simSeconds: number;
  /** null until enough frames have been sampled. */
  fps: number | null;
  stepsPerSecond: number | null;
  seed: number;
  digest: number;
  drawCalls: number;
  triangles: number;
  cameraDistance: number;
  /** Non-null when the shell wants to surface a problem without throwing. */
  notice: string | null;
}

export interface StatusPanel {
  element: HTMLElement;
  update(model: StatusModel): void;
}

export function createStatusPanel(): StatusPanel {
  const rows = {
    scenario: row('scenario'),
    world: row('world'),
    agents: row('agents'),
    vision: row('vision'),
    budget: row('run budget'),
    worldData: row('world data'),
    runFiles: row('run files'),
    reads: row('worldfile reads'),
    scene: row('scene objects'),
    state: row('state'),
    speed: row('speed'),
    step: row('step'),
    simTime: row('sim time'),
    fps: row('fps'),
    stepsPerSecond: row('steps/s'),
    draws: row('draw calls'),
    triangles: row('triangles'),
    cameraDistance: row('view dist'),
    seed: row('seed'),
    digest: row('state digest'),
  };

  const subtitle = el('p', { className: 'panel__subtitle' });
  const notice = el('p', { className: 'panel__note status__val--warn' });
  notice.hidden = true;

  const element = el('section', { className: 'panel status', attrs: { 'aria-label': 'Status' } }, [
    el('h2', { className: 'panel__title', text: 'Status' }),
    subtitle,
    el('div', { className: 'status__grid' }, [
      ...rows.scenario.nodes,
      ...rows.world.nodes,
      ...rows.agents.nodes,
      ...rows.vision.nodes,
      ...rows.budget.nodes,
      separator(),
      ...rows.worldData.nodes,
      ...rows.runFiles.nodes,
      ...rows.reads.nodes,
      ...rows.scene.nodes,
      separator(),
      ...rows.state.nodes,
      ...rows.speed.nodes,
      separator(),
      ...rows.step.nodes,
      ...rows.simTime.nodes,
      ...rows.fps.nodes,
      ...rows.stepsPerSecond.nodes,
      separator(),
      ...rows.draws.nodes,
      ...rows.triangles.nodes,
      ...rows.cameraDistance.nodes,
      separator(),
      ...rows.seed.nodes,
      ...rows.digest.nodes,
    ]),
    notice,
  ]);

  return {
    element,
    update(model: StatusModel): void {
      setText(subtitle, model.subtitle);
      setValue(rows.scenario, model.scenario);
      setValue(rows.world, `${model.worldSize} × ${model.worldSize}`);
      setValue(
        rows.agents,
        model.agentCount === model.agentCapacity
          ? String(model.agentCount)
          : `${model.agentCount} / ${model.agentCapacity}`,
      );
      setValue(rows.vision, model.vision ? 'on' : 'off');
      setValue(rows.budget, `${model.maxSteps.toLocaleString('en-US')} steps`);
      setValue(rows.worldData, model.flavour, model.flavour === 'model' ? 'status__val--accent' : '');
      setValue(rows.runFiles, model.runFiles);
      setValue(
        rows.reads,
        model.blockedKeys === 0 ? 'all read' : `${model.blockedKeys} blocked`,
        model.blockedKeys === 0 ? '' : 'status__val--warn',
      );
      setValue(
        rows.scene,
        formatScene(model),
        model.barriersDrawn < model.barrierCount ? 'status__val--warn' : '',
      );
      setValue(rows.state, formatState(model), model.running ? 'status__val--accent' : '');
      setValue(rows.speed, formatSpeed(model.speed));
      setValue(rows.step, model.stepIndex.toLocaleString('en-US'));
      setValue(rows.simTime, `${model.simSeconds.toFixed(1)} s`);
      setValue(rows.fps, model.fps === null ? '—' : model.fps.toFixed(0));
      setValue(rows.stepsPerSecond, model.stepsPerSecond === null ? '—' : model.stepsPerSecond.toFixed(1));
      setValue(rows.draws, String(model.drawCalls));
      setValue(rows.triangles, formatCount(model.triangles));
      setValue(rows.cameraDistance, model.cameraDistance.toFixed(1));
      setValue(rows.seed, String(model.seed));
      setValue(rows.digest, model.digest.toString(16).padStart(8, '0'));

      if (model.notice) {
        notice.hidden = false;
        setText(notice, model.notice);
      } else {
        notice.hidden = true;
      }
    },
  };
}

interface Row {
  nodes: [HTMLElement, HTMLElement];
  value: HTMLElement;
}

function row(label: string): Row {
  const key = el('div', { className: 'status__key', text: label });
  const value = el('p', { className: 'status__val', text: '—' });
  return { nodes: [key, value], value };
}

function setValue(row: Row, text: string, extraClass = ''): void {
  setText(row.value, text);
  const base = 'status__val';
  const next = extraClass ? `${base} ${extraClass}` : base;
  if (row.value.className !== next) row.value.className = next;
}

function separator(): HTMLElement {
  return el('div', { className: 'status__sep' });
}

function formatSpeed(speed: number): string {
  return `${Number.isInteger(speed) ? speed : speed.toString().replace(/^0\./, '.')}×`;
}

/** The status fields the `scene objects` row reads. */
export type SceneRow = Pick<
  StatusModel,
  'foodCount' | 'brickCount' | 'barrierCount' | 'barriersDrawn' | 'brickPatchesDeclared'
>;

/**
 * The `scene objects` row: how many walls, bricks and food boxes the scene is drawing, plus what
 * the worldfile declared but could not be drawn.
 *
 * PORT-NOTE (L18/draw): what is on screen is stated, and so is what is *not*. A worldfile with no
 * `BrickPatches` says so (`no BrickPatches`) rather than reading as "this world has no bricks" —
 * the same honesty rule the `worldfile reads` row and the notice line follow. A wall that is
 * declared but degenerate (`Z1 == Z2` before a `dyn` barrier grows) reads `N/M barriers`.
 */
export function formatScene(model: SceneRow): string {
  const barriers =
    model.barriersDrawn === model.barrierCount
      ? `${model.barrierCount} barriers`
      : `${model.barriersDrawn}/${model.barrierCount} barriers`;
  const bricks =
    model.brickPatchesDeclared === 0 && model.brickCount === 0
      ? '0 bricks (no BrickPatches)'
      : `${model.brickCount} bricks`;
  return `${barriers} · ${bricks} · ${model.foodCount} food`;
}

/** Bytes as a short human string, for the panel's `run files` row (`formatRunFiles` uses it). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The `run files` row's value for a run-tree reading: `count · size`, or `—` without a sink.
 *
 * PORT-NOTE (L20/live-note): the title panel's note prints the same count, so this is the one place
 * the row's spelling lives — `app.ts::updateUi` hands both it and the note the tick's own snapshot
 * (`hud.ts::titleNote`).
 */
export function formatRunFiles(files: RunFileReport | null): string {
  return files === null ? '—' : `${files.count} · ${formatBytes(files.bytes)}`;
}

/** `running` / `paused` / `ended` — the last one is a state of the run, not of the loop. */
function formatState(model: StatusModel): string {
  if (model.ended) return 'ended';
  return model.running ? 'running' : 'paused';
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
