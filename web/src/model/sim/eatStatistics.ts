/**
 * Lane L11 (sim) — `EatStatistics` (native `sim/EatStatistics.{h,cc}`): the eat-attempt ratios the
 * status text shows.
 *
 * The class keeps a per-step tally and a 100-step rolling average, and exposes three ratios
 * (`ratioFailed`, `ratioFailedYaw`, `ratioFailedVel`) as *pointers* to the run-time properties
 * `EatFailed`, `EatFailedYaw`, `EatFailedVel` (`proplib::CppProperties`). It consumes no RNG and
 * writes no file, so it is only observable through those properties (and the status text).
 *
 * PORT-NOTE(sim/eatstats-accumulate-order): `AgentEatAttempt` counts an attempt, then — for a
 * failed attempt — `numFailed` plus the failed-yaw / failed-vel sub-counts. The `failedMinAge`
 * argument is accepted and ignored, exactly as native does (it is passed but never read).
 */

/** Native `EAT_STATS_AVERAGE_STEPS`. */
export const EAT_STATS_AVERAGE_STEPS = 100;
/** Native `EAT_STATS_AVERAGE_MIN_ATTEMPTS`. */
export const EAT_STATS_AVERAGE_MIN_ATTEMPTS = 1;

/** Native `EatStatistics::GetProperty`'s property names. */
export const EAT_FAILED = 'EatFailed';
export const EAT_FAILED_YAW = 'EatFailedYaw';
export const EAT_FAILED_VEL = 'EatFailedVel';

/** Native `struct Step` (the per-step tally). */
interface StepTally {
  numAttempts: number;
  numFailed: number;
  numFailedYaw: number;
  numFailedVel: number;
}

/** Native `EatStatistics`. */
export class EatStatistics {
  private step: StepTally = { numAttempts: 0, numFailed: 0, numFailedYaw: 0, numFailedVel: 0 };

  private numAttemptsList: number[] = [];
  private numFailedList: number[] = [];
  private numFailedYawList: number[] = [];
  private numFailedVelList: number[] = [];
  private numAttempts = 0;
  private numFailed = 0;
  private numFailedYaw = 0;
  private numFailedVel = 0;
  private ratioFailed = Number.NaN;
  private ratioFailedYaw = Number.NaN;
  private ratioFailedVel = Number.NaN;

  /** Native `EatStatistics::Init()` — `numeric_limits<float>::quiet_NaN()`. */
  init(): void {
    this.step = { numAttempts: 0, numFailed: 0, numFailedYaw: 0, numFailedVel: 0 };
    this.numAttemptsList = [];
    this.numFailedList = [];
    this.numFailedYawList = [];
    this.numFailedVelList = [];
    this.numAttempts = 0;
    this.numFailed = 0;
    this.numFailedYaw = 0;
    this.numFailedVel = 0;
    this.ratioFailed = Number.NaN;
    this.ratioFailedYaw = Number.NaN;
    this.ratioFailedVel = Number.NaN;
  }

  /** Native `EatStatistics::StepBegin()`. */
  stepBegin(): void {
    this.step.numAttempts = 0;
    this.step.numFailed = 0;
    this.step.numFailedYaw = 0;
    this.step.numFailedVel = 0;
  }

  /** Native `EatStatistics::StepEnd()` — the rolling 100-step average. */
  stepEnd(): void {
    if (this.step.numAttempts < EAT_STATS_AVERAGE_MIN_ATTEMPTS) return;

    if (this.numAttemptsList.length >= EAT_STATS_AVERAGE_STEPS) {
      this.numAttempts -= this.numAttemptsList[0]!;
      this.numFailed -= this.numFailedList[0]!;
      this.numFailedYaw -= this.numFailedYawList[0]!;
      this.numFailedVel -= this.numFailedVelList[0]!;

      this.numAttemptsList.shift();
      this.numFailedList.shift();
      this.numFailedYawList.shift();
      this.numFailedVelList.shift();
    }

    this.numAttemptsList.push(this.step.numAttempts);
    this.numFailedList.push(this.step.numFailed);
    this.numFailedYawList.push(this.step.numFailedYaw);
    this.numFailedVelList.push(this.step.numFailedVel);

    this.numAttempts += this.step.numAttempts;
    this.numFailed += this.step.numFailed;
    this.numFailedYaw += this.step.numFailedYaw;
    this.numFailedVel += this.step.numFailedVel;

    this.ratioFailed = this.numFailed / this.numAttempts;
    this.ratioFailedYaw = this.numFailedYaw / this.numAttempts;
    this.ratioFailedVel = this.numFailedVel / this.numAttempts;
  }

  /**
   * Native `EatStatistics::AgentEatAttempt( success, failedYaw, failedVel, failedMinAge )`.
   * `failedMinAge` is unused in native.
   */
  agentEatAttempt(success: boolean, failedYaw: boolean, failedVel: boolean, failedMinAge: boolean): void {
    void failedMinAge;
    this.step.numAttempts++;
    if (!success) {
      this.step.numFailed++;
      if (failedYaw) this.step.numFailedYaw++;
      if (failedVel) this.step.numFailedVel++;
    }
  }

  /**
   * Native `EatStatistics::GetProperty( name )` — the value behind the property name, or null for
   * an unknown name (native asserts false and returns NULL, which the property layer dereferences;
   * the port throws in `requireProperty` and keeps `getProperty` returning null for parity).
   */
  getProperty(name: string): number | null {
    if (name === EAT_FAILED) return this.ratioFailed;
    if (name === EAT_FAILED_YAW) return this.ratioFailedYaw;
    if (name === EAT_FAILED_VEL) return this.ratioFailedVel;
    return null;
  }

  /** The port's loud form of `assert( false )` in `GetProperty`. */
  requireProperty(name: string): number {
    const value = this.getProperty(name);
    if (value === null) {
      throw new Error(`EatStatistics::GetProperty( '${name}' ): no such property`);
    }
    return value;
  }
}
