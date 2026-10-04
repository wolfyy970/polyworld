/**
 * Lane L18 (browser wiring) — shell configuration, parsed from the URL query string.
 *
 * Pure and DOM-free on purpose (`parseShellConfig(search)` takes the search string), so it
 * is unit-testable under vitest's node environment and so the boot parameters can be pinned
 * from a headless check. Example:
 *
 *   /?scenario=minitest_voff&seed=7&speed=4&stepHz=30
 *
 * PORT-NOTE (L18/config-vs-worldfile): the shell's own knobs are *presentation and loop*
 * knobs only (`speed`, `stepHz`, the renderer's instance capacity). Everything that describes
 * the world — extent, agent count, agent size/speed ranges — comes from the worldfile through
 * `sim/worldParams.ts`, never from the URL: a query parameter must not be able to describe a
 * world the file does not.
 *
 * PORT-NOTE (L18/seed-is-native-argv): the one exception is `seed`, and it is not an exception in
 * spirit: it is native's **own** `--InitSeed` argv parameter (the value `Simulation.cc:3899` hands
 * `srand48`), applied through lane W1b's converter before `apply()` — the same path the scenario's
 * `--Vision False` takes. It cannot describe a world the file does not; it selects *which run* of
 * that world (and the resulting `run/converted.wf` says so, exactly as native's does). Absent, the
 * page runs the recorded scenario untouched.
 */

import { DEFAULT_SCENARIO, isScenarioName, type ScenarioName } from './sim/scenarios';

/** Speed multipliers offered by the control bar (index order = keyboard 1..6). */
export const SHELL_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];

/** Fixed simulation rate. The native demo worldfiles run a step per frame (`StepsPerSecond 0`
 *  means "as fast as possible"); 30 Hz is the shell's stand-in and is also the accumulator's
 *  step size (1/30 s). */
export const DEFAULT_STEP_HZ = 30;

/**
 * Renderer instance capacity floor. The world's own agent count wins when it is larger; this
 * only exists so `?agents=` can pre-allocate for a world that grows.
 */
export const DEFAULT_AGENT_CAPACITY = 32;

export interface ShellConfig {
  /** Which recorded scenario to boot (`sim/scenarios.ts`). */
  readonly scenario: ScenarioName;
  /** The run's `InitSeed` override (native `--InitSeed`); `null` = the worldfile's own value. */
  readonly seed: number | null;
  /** Instance capacity floor (see `DEFAULT_AGENT_CAPACITY`). */
  readonly agents: number;
  readonly stepHz: number;
  readonly speed: number;
}

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  scenario: DEFAULT_SCENARIO,
  seed: null,
  agents: DEFAULT_AGENT_CAPACITY,
  stepHz: DEFAULT_STEP_HZ,
  speed: 1,
};

export function parseShellConfig(search: string): ShellConfig {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const scenario = params.get('scenario');
  return {
    scenario: isScenarioName(scenario) ? scenario : DEFAULT_SHELL_CONFIG.scenario,
    seed: nullableIntParam(params, 'seed', 0, 0xffffffff),
    agents: intParam(params, 'agents', DEFAULT_SHELL_CONFIG.agents, 1, 4096),
    stepHz: intParam(params, 'stepHz', DEFAULT_SHELL_CONFIG.stepHz, 1, 240),
    speed: speedParam(params, DEFAULT_SHELL_CONFIG.speed),
  };
}

function intParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** An optional integer: absent or unparseable stays `null`, so the caller's default wins. */
function nullableIntParam(params: URLSearchParams, key: string, min: number, max: number): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function speedParam(params: URLSearchParams, fallback: number): number {
  const raw = params.get('speed');
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // Snap to an offered speed when close, so the pressed-state in the bar always matches
  // what the loop is actually doing.
  const nearest = SHELL_SPEEDS.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
  return nearest;
}
