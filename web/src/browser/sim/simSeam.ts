/**
 * Lane L18 (browser wiring) — the seam between the shell and the simulation.
 *
 * The shell renders one thing: a list of creatures in native world coordinates. Lane L11
 * (`src/model/sim/**`, `TSimulation`) owns what that list *is*; this module states the shape
 * it must hand over, so the shell was wired before the simulation existed and binding the real
 * one was a single factory call in `app.ts` (`createModelWorld`, `sim/modelWorld.ts`).
 *
 * What the model supplies (`src/browser/sim/modelWorld.ts` is the implementation):
 *   - `step()`        — native `TSimulation::Step()`, one fixed step, called once per
 *                       accumulator step by the shell (never once per rendered frame).
 *   - `agents`        — the live agents in native iteration order (`gXSortedObjects`), each with
 *                       position, yaw, radius and the model's own body colour. That order is part
 *                       of the model (PORT_SPEC rule 4), so the port must not re-sort it for the
 *                       renderer.
 *   - `stepIndex` / `simSeconds` / `maxSteps` — the run's own clock and budget
 *                       (`MaxSteps`, `endStep.txt`).
 *   - `stateDigest()` — presentation-grade only (it exists so a human can see "same seed,
 *                       same state"), never compared against a native artifact.
 *
 * PORT-NOTE (L18/coordinates): native coordinates are *not* origin-centred. The world spans
 * x ∈ [0, worldSize] and z ∈ [-worldSize, 0] (`agent.cc:1354-1402`, `food.cc:151-152`,
 * `Simulation.cc:4167-4171`), and yaw is in **degrees** with 0 pointing along -z
 * (`agent.cc:1150-1151`, `setyaw( ... * 360.0 )` at 1159). The seam keeps the native
 * convention verbatim and the conversions to three.js space live here, so L11's numbers can
 * be handed over with no massaging and no lane-boundary arithmetic.
 *
 * PORT-NOTE (L18/sim-seam-is-a-gift): this interface is the browser lane's gift to lane L11, not
 * a constraint on it. Where the model's own construction differs (an injected `RecordFileSystem`,
 * the boot's document and artifact texts — L11's `SimulationOptions`), the *factory options* below
 * follow the model and the seam wraps it; nothing in `src/model/**` was bent to fit this file.
 */

import type { RecordFileSystem } from '../../model/logs/seams';
import type { BootedWorld } from './worldBoot';

/** Native `DEGTORAD` (`utils/misc.h`). */
export const DEGTORAD = Math.PI / 180;

export interface SimulationAgent {
  /** Native `fPosition[0]`, in `[0, worldSize]`. */
  readonly x: number;
  /** Native `fPosition[2]`, in `[-worldSize, 0]`. */
  readonly z: number;
  /** Native yaw, **degrees** (0 = -z, counter-clockwise seen from above; `agent.cc:1150`). */
  readonly yaw: number;
  /** Native agent radius — the `Size` gene (`agent.cc:574`, `setRadius`). */
  readonly size: number;
  /** The model's own body colour, `agent::color()` (`agent.cc:1901`), native 0..1 floats. */
  readonly color: readonly [number, number, number];
  readonly alive: boolean;
}

/**
 * A world object the renderer draws as a box — native `gboxf`: `food` and `brick` are both
 * `gboxf`s (`environment/object.ts`), so one shape carries both. The position is the box's
 * *centre* (native stores `fPosition`, and `food::initFoodAt` puts `y` at half the height) and the
 * lengths are `fLength[3]`, so a renderer needs no arithmetic of its own. The colour is the
 * object's own (`gobject::setcolor` — `FoodColor`/the food type's override for food, the patch's
 * or the global `BrickColor` for brick), native 0..1 floats.
 */
export interface SimulationBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly color: readonly [number, number, number];
}

/**
 * A barrier wall: native `barrier::absolutePosition()` (the ratio-scaled endpoints) and
 * `barrier::gBarrierHeight`. Barriers can be `dyn` (their `Z2` moves with the population), which is
 * why the renderer reads them from the model per step rather than only from the worldfile.
 */
export interface SimulationBarrier {
  readonly xa: number;
  readonly za: number;
  readonly xb: number;
  readonly zb: number;
  readonly height: number;
}

export interface SimulationLike {
  readonly agents: readonly SimulationAgent[];
  /** Native `food::gAllFood` members, in the model's own `gXSortedObjects` walk order. */
  readonly food: readonly SimulationBox[];
  /** Native `brick::gAllBricks`/`gXSortedObjects` members, same walk order. */
  readonly bricks: readonly SimulationBox[];
  /** Native `barrier::gBarriers`, in creation order. */
  readonly barriers: readonly SimulationBarrier[];
  /** Instance capacity the renderer allocates for (native `MaxAgents`). */
  readonly agentCapacity: number;
  readonly stepIndex: number;
  readonly simSeconds: number;
  /** The run's own seed — native `InitSeed` (`Simulation.cc:3899`), the value `srand48` starts from. */
  readonly seed: number;
  /** Native `MaxSteps` — the run's budget. The shell displays it; the simulation enforces it. */
  readonly maxSteps: number;
  /** Where the agents come from. The shell has exactly one world now: lane L11's simulation. */
  readonly flavour: 'model';
  /** True once the run has ended (`MaxSteps`, a population crash, …). Stepping is then a no-op. */
  readonly ended: boolean;
  /** A non-null shell-facing notice (e.g. the end of the run); surfaces in the status panel. */
  readonly notice: string | null;
  step(): void;
  /** Stop the run: native `~TSimulation`, whose `DR_SIMEND` kills are the run's last log rows. */
  dispose(): void;
  /** Order-sensitive, millimetre-quantised digest of the agent state. Presentation only. */
  stateDigest(): number;
}

/**
 * What the shell calls to build the world (`app.ts::bootedSimulation`).
 *
 * PORT-NOTE (L18/no-rewind): there is deliberately no `reset`/`reseed` here. The model's state is
 * *process-wide* — `FoodType`'s definition table, the RNG surfaces, `gXSortedObjects` — exactly as
 * native's is, so a second `TSimulation` cannot be constructed in the same process (measured:
 * `sim: duplicate FoodType name 'Standard' (native errs)`, `worldfile.ts:256`), and native's own
 * binary runs one simulation per process too. A "new run" therefore belongs to the host: the shell
 * reloads the page with native's `--InitSeed` (`app.ts::resetRun`). Pretending to rewind inside the
 * page would be a lie the model cannot keep.
 */
export interface SimulationOptions {
  /** The booted worldfile: the applied document, the four artifact texts and the scenario. */
  readonly boot: BootedWorld;
  /** Fixed simulated seconds per step (the shell's accumulator owns the clock). */
  readonly stepSeconds: number;
  /** Lane L12's file seam. Defaults to the browser's in-memory `MemoryRecordFileSystem`. */
  readonly fs?: RecordFileSystem;
}

/** What `app.ts` calls to build the world — lane L18's `createModelWorld`. */
export type SimulationFactory = (options: SimulationOptions) => SimulationLike;

// --------------------------------------------------------------------------------------- //
// native <-> scene space
// --------------------------------------------------------------------------------------- //

/** Native x → scene X (origin-centred, -W/2 … +W/2). */
export function nativeXToScene(x: number, worldSize: number): number {
  return x - worldSize / 2;
}

/** Native z → scene Z (origin-centred, -W/2 … +W/2). */
export function nativeZToScene(z: number, worldSize: number): number {
  return z + worldSize / 2;
}

/** The native yaw's unit direction in native (x, z) space. */
export function nativeHeading(yawDegrees: number): { readonly dx: number; readonly dz: number } {
  const yaw = yawDegrees * DEGTORAD;
  return { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
}

/**
 * Native yaw → three.js rotation about +Y. A rotation by φ maps local +x to
 * (cos φ, 0, -sin φ); the native heading is (-sin θ, -cos θ), so φ = θ + π/2.
 */
export function yawToSceneRotation(yawDegrees: number): number {
  return yawDegrees * DEGTORAD + Math.PI / 2;
}
