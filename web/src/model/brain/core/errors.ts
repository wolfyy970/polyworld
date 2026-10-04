/**
 * Lane L6 (brain core) — error surface of the brain growth path.
 *
 * Native `utils/error.h`'s `error( level, … )` prints a `PolyWorld ERROR: …` line to stderr
 * and, for `level > 1`, calls `exit( level )` — so every architecture error in
 * `GroupsBrain::grow`/`growSynapses` *ends the run*. A browser tab cannot exit, and a caller
 * (the sim lane) must be able to tell "this brain is not reproducible" from "this brain is
 * illegal", so the port throws.
 *
 * PORT-NOTE(l6/brain-error-is-a-throw): the wording of every message is kept, including the
 * space-joined `%s %ld %s` shape native's overloads produce, so a lane that hits one
 * recognizes it. Native would also have printed it to stderr; the port's message is the same
 * text.
 */

export class BrainError extends Error {
  /** Native `errlevel` — the exit code, and the "is this fatal" flag (`> 1`). */
  readonly level: number;

  constructor(level: number, message: string) {
    super(`PolyWorld${level ? ' ERROR: ' : ' WARNING: '}${message}`);
    this.name = 'BrainError';
    this.level = level;
  }
}

/** Native `error( level, … )` with the variadic arguments already joined. */
export function brainError(level: number, message: string): never {
  throw new BrainError(level, message);
}
