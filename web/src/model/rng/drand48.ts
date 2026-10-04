/**
 * Lane W1d — `srand48` / `drand48` / `lrand48` (the 48-bit LCG), bit-exact.
 *
 * PORT-NOTE(W1d/drand48-limb-lcg): the native model reaches this generator through the
 * `randpw()` macro (`utils/misc.h`), so *every* `randpw()`/`rrand()`/`nrand()` call in the
 * model draws from it. The algorithm is the C library's: `X <- (0x5DEECE66D * X + 0xB) mod
 * 2^48`, seeded with `X = (seed << 16) | 0x330E`; `drand48()` returns `X / 2^48` and
 * `lrand48()` the top 31 bits of `X`, both after the iteration.
 *
 * The state is kept as the three 16-bit words the C library uses (`unsigned short
 * xseed[3]`), and the modular product is formed with 16-bit limbs and explicit carries.
 * This is deliberate: `a * X` needs 83 bits, and a plain double multiply (or a
 * `Math.imul`-based 32-bit trick) silently loses the low bits that decide the next 48-bit
 * state. 16-bit limbs keep every intermediate below 2^34, exact in a double.
 *
 * Verified bit-identical to the oracle for every captured vector and, over 20,000
 * consecutive draws, against a BigInt reference (tests/rng.test.ts).
 */

/** `a = 0x5DEECE66D` split into 16-bit limbs: `a = A1 * 2^16 + A0`. */
const A0 = 0xe66d;
const A1 = 0x5deec;
/** `c = 0xB`. */
const C = 0xb;
const TWO16 = 65536;
const TWO48 = 281474976710656;

/**
 * The C library's `drand48` family: one 48-bit LCG, shared by every caller in the process.
 */
export class Drand48 {
  private x0 = 0x330e;
  private x1 = 0;
  private x2 = 0;

  /** C `srand48(seed)`. The seed is truncated to 32 bits, as the C prototypes do. */
  srand48(seed: number): void {
    const s = seed >>> 0;
    this.x0 = 0x330e;
    this.x1 = s & 0xffff;
    this.x2 = (s >>> 16) & 0xffff;
  }

  /** C `drand48()` -> [0,1). Native `randpw()`. */
  drand48(): number {
    this.iterate();
    return ((this.x2 * TWO16 + this.x1) * TWO16 + this.x0) / TWO48;
  }

  /** C `lrand48()` -> [0, 2^31): top 31 bits of the state after the iteration. */
  lrand48(): number {
    this.iterate();
    return Math.floor((this.x2 * TWO16 + this.x1) / 2);
  }

  private iterate(): void {
    const x0 = this.x0;
    const x1 = this.x1;
    const x2 = this.x2;
    // X * a, split over 16-bit limbs; terms at 2^48 and above are dropped (mod 2^48).
    const t0 = x0 * A0;
    const t1 = x0 * A1 + x1 * A0;
    const t2 = x1 * A1 + x2 * A0;
    const r0 = t0 % TWO16;
    const q0 = (t0 - r0) / TWO16;
    const r1 = t1 % TWO16;
    const q1 = (t1 - r1) / TWO16;
    const r2 = t2 % TWO16;
    // fold in c and propagate the carries
    let m0 = r0 + C;
    const c0 = m0 >= TWO16 ? 1 : 0;
    m0 -= c0 * TWO16;
    let m1 = q0 + r1 + c0;
    const c1 = Math.floor(m1 / TWO16);
    m1 -= c1 * TWO16;
    let m2 = q1 + r2 + c1;
    const c2 = Math.floor(m2 / TWO16);
    m2 -= c2 * TWO16;
    this.x0 = m0;
    this.x1 = m1;
    this.x2 = m2;
  }
}
