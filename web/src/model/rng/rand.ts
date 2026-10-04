/**
 * Lane W1d — the two `rand()`-family generators, bit-exact against the oracle's libc.
 *
 * PORT-NOTE(W1d/rand-is-not-random): the port must reproduce the *oracle*, and the oracle
 * is this machine's libc (macOS 26.5.2 / Apple Libc), where the two functions are
 * **different generators** that `PORT_SPEC.md` rule 2 and `src/model/types/rng.ts`
 * describe as one ("glibc rand(), TYPE_3 additive feedback"):
 *
 *   rand()/srand()      — Apple/FreeBSD `rand.c`: Park–Miller `x <- 16807*x mod (2^31-1)`
 *                         (hi/lo form, seed 0 remapped to 123459876). Measured: srand(42)
 *                         then rand() = 705894, 1126542223, 1579310009, ... — *not* the
 *                         TYPE_3 sequence below.
 *   random()/srandom()  — Apple/FreeBSD `random.c`: TYPE_3 additive feedback
 *                         (`x[i] += x[i-3]`, degree 31, separation 3, 310 warm-up draws).
 *                         Measured: srandom(42) then random() = 71876166, 708592740, ...
 *
 * On glibc `rand()` is an alias of `random()` (TYPE_3), which is where the W1a note comes
 * from; on the oracle they are two streams and `bin/rancheck` prints them side by side in
 * separate columns. The port follows the oracle — implementing glibc's alias for `rand()`
 * would move every frozen artifact that calls `rand()` (`graphics/gobject.cc`,
 * `complexity/complexity_motion.cc`, `sim/Simulation.cc`'s `srand(1)`).
 *
 * Verified: `tests/rng.test.ts` reproduces all ten lines of `../polyworld/bin/rancheck`
 * byte-for-byte (columns srand / drand48 / random / gsl) plus the captured seed vectors.
 */

/** C `RAND_MAX` on this platform. */
export const RAND_MAX = 2147483647;

/** Native `do_rand()` — Apple Libc `stdlib/FreeBSD/rand.c`. */
function libcDoRand(ctx: number): number {
  let x = ctx;
  // "Can't be initialized with 0, so use another value."
  if (x === 0) x = 123459876;
  const hi = Math.floor(x / 127773);
  const lo = x % 127773;
  let v = 16807 * lo - 2836 * hi;
  if (v < 0) v += 0x7fffffff;
  return v % (RAND_MAX + 1);
}

/** C `rand()`/`srand()` — Park–Miller, one process-wide state (`static u_long next`). */
export class LibcRand {
  private next = 1;

  /** C `srand(seed)` (the parameter is `u_int`, so the seed is truncated to 32 bits). */
  srand(seed: number): void {
    this.next = seed >>> 0;
  }

  /** C `rand()` -> [0, RAND_MAX]. */
  rand(): number {
    this.next = libcDoRand(this.next);
    return this.next;
  }
}

/**
 * `good_rand()` from Apple Libc `stdlib/FreeBSD/random.c` (Park–Miller, 0 remapped).
 *
 * PORT-NOTE(W1d/good-rand-is-int32): the C signature is `uint32_t good_rand(int32_t x)` —
 * the state word is passed as a *signed* 32-bit value, so integer division and `%` truncate
 * toward zero (a `Math.floor` port diverges for state words with the top bit set, e.g.
 * `srandom(0xffffffff)`). `| 0` in JS gives exactly that int32 view.
 */
function goodRand(xIn: number): number {
  let x = xIn | 0;
  if (x === 0) x = 123459876;
  const hi = (x / 127773) | 0; // C truncates toward zero
  const lo = x % 127773; // JS % matches C % (sign of the dividend)
  let r = 16807 * lo - 2836 * hi;
  if (r < 0) r += 0x7fffffff;
  return r;
}

const DEG_3 = 31;
const SEP_3 = 3;

/** `randtbl[1..31]`: the C library's initial TYPE_3 state (`initstate(1, randtbl, 128)`). */
const INIT_TABLE = Uint32Array.from([
  0x991539b1, 0x16a5bce3, 0x6774a4cd, 0x3e01511e, 0x4e508aaa, 0x61048c05, 0xf5500617,
  0x846b7115, 0x6a19892c, 0x896a97af, 0xdb48f936, 0x14898454, 0x37ffd106, 0xb58bff9c,
  0x59e17104, 0xcf918a49, 0x09378c83, 0x52c7a471, 0x8d293ea9, 0x1f4fc301, 0xc3db71be,
  0x39b44e1c, 0xf8a44ef9, 0x4c8b80b1, 0x19edc328, 0x87bf4bdd, 0xc9b240e5, 0xe9ee4b1b,
  0x4382aee7, 0x535b6b41, 0xf3bec5da,
]);

/**
 * C `random()`/`srandom()` — the TYPE_3 additive-feedback generator (`random.c`).
 *
 * `random()` is not called by the model; it is here because it is the algorithm
 * `PORT_SPEC.md`'s rule 2 names, because `bin/rancheck` prints it, and because its
 * sequence is the one to compare against if a lane ever needs a glibc-shaped `rand()`.
 */
export class BsdRandom {
  private readonly state = new Uint32Array(DEG_3);
  private fptr = SEP_3;
  private rptr = 0;

  constructor() {
    this.state.set(INIT_TABLE);
  }

  /** C `srandom(seed)`. */
  srandom(seed: number): void {
    this.state[0] = seed >>> 0;
    for (let i = 1; i < DEG_3; i++) this.state[i] = goodRand(this.state[i - 1]!);
    this.fptr = SEP_3;
    this.rptr = 0;
    // "cycles the state information a given number of times": 10 * rand_deg draws
    for (let i = 0; i < 10 * DEG_3; i++) this.random();
  }

  /** C `random()` -> [0, 2^31). */
  random(): number {
    let f = this.fptr;
    let r = this.rptr;
    const sum = (this.state[f]! + this.state[r]!) >>> 0;
    this.state[f] = sum;
    const result = (sum >>> 1) & 0x7fffffff;
    f += 1;
    if (f >= DEG_3) {
      f = 0;
      r += 1;
    } else {
      r += 1;
      if (r >= DEG_3) r = 0;
    }
    this.fptr = f;
    this.rptr = r;
    return result;
  }
}
