/**
 * Lane L11 (sim) — the per-step scheduler (native `sim/Scheduler.{h,cc}`, `utils/ThreadPool.*`).
 *
 * Native runs a step as:
 *
 *   execMasterTask( masterTask, forceAllSerial ):
 *       forceAllSerial = forceAllSerial
 *       if forceAllSerial: masterTask()                       # everything inline, FIFO
 *       else:
 *           state = Master;   masterTask()                    # inline, in the caller's thread
 *           state = Parallel; threadPool.join()               # the posted-parallel work
 *           state = Serial;   for task in serialTasks: task() # FIFO, push order
 *           state = Idle
 *   postParallel( t ): forceAllSerial ? t() : threadPool.schedule( t )
 *   postSerial( t ):   forceAllSerial ? t() : serialTasks.push_back( t )
 *
 * PORT-NOTE(sched-deferral): the port implements the *parallel-mode* (recorded) semantics
 * single-threaded. This is not a simplification — it is the measured behaviour of every oracle
 * scenario (docs/specs/sim-spec.md §3.3): the `ParallelInteract`/`ParallelInitAgents` paths
 * defer list mutation and energy accounting, and a port that ran `postSerial` work inline
 * diverges from the golden at step 37. The thread pool's *interleaving* is not observable in
 * the recorded configuration (per-agent RNG + per-agent log files, sim-spec §8.2), so the
 * posted-parallel batch can run in push order.
 *
 * PORT-NOTE(sched-flags): `ParallelBrains` / `ParallelCreateAgents` are treated as no-ops by
 * the port (measured byte-identical to the golden); `ParallelInitAgents=false` and
 * `ParallelInteract=false` are unsupported in v1 and the simulation refuses the worldfile
 * (see `Simulation.init`).
 *
 * PORT-NOTE(sched-asserts): native asserts `state == Master` in `postParallel`/`postSerial`.
 * The port throws the same way, because a task posted outside a master task would otherwise be
 * silently dropped (native aborts) — and a dropped `postSerial` means a missing energy
 * accumulation or a missing agent insertion.
 */

/** Native `Scheduler::State`. */
export const SchedulerState = {
  Idle: 0,
  Master: 1,
  Parallel: 2,
  Serial: 3,
} as const;

export type SchedulerState = (typeof SchedulerState)[keyof typeof SchedulerState];

/** Native `std::function<void()>`. */
export type Task = () => void;

/** Native `class Scheduler`. */
export class Scheduler {
  private state: SchedulerState = SchedulerState.Idle;
  private forceAllSerial = false;
  private serialTasks: Task[] = [];
  private parallelTasks: Task[] = [];

  /**
   * `get_thread_count()` (`Scheduler.cc:8-20`) is only used to size the native thread pool; the
   * port runs everything on one thread, so no worker count exists. Kept as a documented absence
   * rather than a field, so a reviewer does not look for the pool.
   */

  getState(): SchedulerState {
    return this.state;
  }

  /** Native `Scheduler::execMasterTask`. */
  execMasterTask(masterTask: Task, forceAllSerial: boolean): void {
    this.forceAllSerial = forceAllSerial;

    if (forceAllSerial) {
      masterTask();
      return;
    }

    if (this.state !== SchedulerState.Idle) {
      throw new Error(`scheduler: execMasterTask while state is ${this.state} (native asserts Idle)`);
    }
    this.state = SchedulerState.Master;
    this.parallelTasks = [];
    this.serialTasks = [];

    masterTask();

    this.state = SchedulerState.Parallel;
    // `threadPool.join()`: the posted-parallel work, in push order.
    for (const task of this.parallelTasks) task();

    this.state = SchedulerState.Serial;
    for (const task of this.serialTasks) task();

    this.parallelTasks = [];
    this.serialTasks = [];
    this.state = SchedulerState.Idle;
  }

  /** Native `Scheduler::postParallel`. */
  postParallel(task: Task): void {
    if (this.forceAllSerial) {
      task();
      return;
    }

    if (this.state !== SchedulerState.Master) {
      throw new Error(`scheduler: postParallel outside a master task (state ${this.state})`);
    }
    this.parallelTasks.push(task);
  }

  /**
   * Run (and clear) the posted-parallel tasks that are still pending, in push order.
   *
   * Native's thread pool drains *concurrently with the master thread*, so a posted task is
   * normally complete by the time the master loop reaches its next iteration. That is not
   * observable in the step loop (a posted task either only touches data the master does not read
   * until the join, or is followed by a `postSerial` that runs after the join), but it **is**
   * observable in `InitAgents` (see `PORT-NOTE(sim/sched-init-grow-boundary)` in `simulation.ts`):
   * the x-sorted list computes an agent's key as `x() - radius()`, and the posted `grow()` is what
   * sets the radius — so whether the *previous* agent has been grown by then changes the list
   * order, and the list order is what emits the step's collision events.
   *
   * A no-op under `forceAllSerial`, where `postParallel` already ran its task inline.
   */
  drainParallel(): void {
    if (this.forceAllSerial || this.parallelTasks.length === 0) return;
    const pending = this.parallelTasks;
    this.parallelTasks = [];
    for (const task of pending) task();
  }

  /** Native `Scheduler::postSerial`. */
  postSerial(task: Task): void {
    if (this.forceAllSerial) {
      task();
      return;
    }

    if (this.state !== SchedulerState.Master) {
      throw new Error(`scheduler: postSerial outside a master task (state ${this.state})`);
    }
    this.serialTasks.push(task);
  }
}
