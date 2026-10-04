/**
 * Lane L8 — `LifeSpan` (native `agent/LifeSpan.{h,cc}`).
 *
 * The enum *values* and the reason *names* are frozen in `src/model/types/lifespan.ts`
 * (they are written to `run/lifespans.txt`), so this file is only the record: when an agent
 * was born and when it died, and why.
 *
 * Native detail worth keeping: the constructor sets both steps to `-1` and both reasons to
 * `INVALID`; `agent::Die()` early-returns (skipping the carry teardown) when the death
 * reason is already `DR_SIMEND`, so a lifespan that is never stamped keeps `-1`.
 *
 * PORT-NOTE(L8/lifespan-struct): the port keeps native's nested `birth` / `death` structs
 * as objects with the same three mutable fields, because L11/L12 write and read them in
 * place (`GetLifeSpan()->set_birth(...)`, `BR_NAMES[birth.reason]`).
 */

import { BirthReason, DeathReason, birthReasonName, deathReasonName } from '../types';

export class LifeSpan {
  /** Native `struct { BirthReason reason; long step; } birth;`. */
  readonly birth: { reason: BirthReason; step: number };

  /** Native `struct { DeathReason reason; long step; } death;`. */
  readonly death: { reason: DeathReason; step: number };

  constructor() {
    this.birth = { reason: BirthReason.INVALID, step: -1 };
    this.death = { reason: DeathReason.INVALID, step: -1 };
  }

  /** Native `set_birth( step, birthReason )`. */
  setBirth(step: number, reason: BirthReason): void {
    this.birth.step = step;
    this.birth.reason = reason;
  }

  /** Native `set_death( step, deathReason )`. */
  setDeath(step: number, reason: DeathReason): void {
    this.death.step = step;
    this.death.reason = reason;
  }

  /** Native `BR_NAMES[birth.reason]` — what L12 writes to `lifespans.txt`. */
  birthReasonName(): string {
    return birthReasonName(this.birth.reason);
  }

  /** Native `DR_NAMES[death.reason]`. */
  deathReasonName(): string {
    return deathReasonName(this.death.reason);
  }
}
