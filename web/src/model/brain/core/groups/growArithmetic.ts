/**
 * Lane L6 (brain core) — the arithmetic of `GroupsBrain::grow`/`growSynapses`, isolated from the
 * walk so it can be differentially checked against the native compiler.
 *
 * PORT-NOTE(l6/groups-grow-arithmetic-extraction): `growSynapses` cannot be run end-to-end until
 * lane L5 (a native `GroupsGenome`) and lane L8 (`agent::config`) exist, so the *arithmetic* is
 * pulled into this module and each function is compared against a transcription of the C
 * expression it mirrors, compiled by the native toolchain (`native/brainprobe.cc`'s `growexpr`
 * mode) over an enumerated input grid. The point of the extraction is exactly the class of
 * defect it caught: C's operand types (`float + float` rounding *before* a `double` literal
 * promotes it, or a product/quotient evaluated in a different order) are invisible in
 * TypeScript, and a transcription that adds everything in `double` survives every test that does
 * not compare against the native compiler.
 *
 * PORT-NOTE(l6/float-discipline): every function here returns what the native *statement* stores.
 * Where the C expression is `float`-typed the return is `f32(...)`; where it is `double` (the
 * `1.e-5` literal, the `* 0.5`, the `nint` macro, `td_rng->range`) the value stays a plain
 * number and is narrowed only by the cast native applies (`short(...)`).
 *
 * The C sources, verbatim (`src/library/brain/groups/GroupsBrain.cc`):
 *
 *   687  float nsynjiperneur = float(synapseCount_fromto)/float(neuronCount_to);
 *   688  int synapseCount_new = short(nsynjiperneur + remainder[groupIndex_from] + 1.e-5);
 *   689  remainder[groupIndex_from] += nsynjiperneur - synapseCount_new;
 *   713  int neuronLocalIndex_fromBase = short((float(neuronLocalIndex_to) / float(neuronCount_to))
 *            * float(neuronCount_from) - float(synapseCount_new) * 0.5);
 *   714  neuronLocalIndex_fromBase = max<short>(0, min<short>(neuronCount_from - synapseCount_new,
 *            neuronLocalIndex_fromBase));
 *   764  td_fromto_abs = td_fromto * 2;          // mirrored, td_fromto <  0.5
 *   769  td_fromto_abs = (1 - td_fromto) * 2;    // mirrored, td_fromto >= 0.5
 *   775  td_fromto_abs = td_fromto;              // not mirrored
 *   778  short distortion = short(nint(td_rng->range(-0.5,0.5)*td_fromto_abs*neuronCount_from));
 *   822  float stdev = _genome->get(WEIGHT_STDEV, …) * Brain::config.gaussianInitMaxStdev;
 *
 * Line 778 is the one expression whose *draw count* the port has to reproduce and not just its
 * arithmetic: `nint` is a macro that mentions its argument **twice** (`utils/misc.h`), so the
 * `range()` call inside it is made **twice** per passing connection (four draws per connection
 * on a hit, two on a miss) — see `distortionIndex` below.
 *
 * (`remainder` is a `float` array — `ALLOC_STACK_BUFFER( eeremainder, float )`, GroupsBrain.cc:30;
 * `Brain::config.gaussianInitMaxStdev` is a `float` (Brain.h:102); `Scalar * float` returns
 * `scalar.fval * f`, a `float` (Scalar.cc:143).)
 */

import { f32, nintFused, toShort } from '../nativeMath';

/**
 * Native `GroupsBrain.cc:616-617` —
 * `_energyUse = Brain::config.maxneuron2energy * float(_dims.numNeurons) / float(config.maxneurons)
 *             + Brain::config.maxsynapse2energy * float(_dims.numSynapses) / float(config.maxsynapses);`
 *
 * Every operation is `float` (the two config factors are floats — Brain.h:112-113 — and the
 * counts convert to `float`), and the two terms are evaluated **left to right**: the product
 * first, *then* the division. The pre-review revision of this lane grouped them the other way
 * round (`a * (n / m)`), which is a different rounded value whenever the denominator is not a
 * power of two — the same class of defect as the `synapseCount_new` one, in the same file.
 *
 * `_energyUse` is a `float` member (Brain.h:158) initialised to 0 (Brain.cc:150); only
 * `GroupsBrain::grow` ever assigns it, so the `Sheets` architecture keeps 0.
 */
export function energyUseOf(
  maxneuron2energy: number,
  numNeurons: number,
  maxneurons: number,
  maxsynapse2energy: number,
  numSynapses: number,
  maxsynapses: number,
): number {
  const neurons = maxneuron2energy * f32(numNeurons); // a * float(n)   (float)
  const synapses = maxsynapse2energy * f32(numSynapses); // b * float(s)   (float)
  return f32(f32(f32(neurons) / maxneurons) + f32(f32(synapses) / maxsynapses));
}

/**
 * Native `GroupsBrain.cc:687` — `float(synapseCount_fromto) / float(neuronCount_to)`.
 *
 * The division is a float division. The port computes it in double and rounds once: for a
 * quotient of two exactly-representable operands, rounding to `double` first and then to `float`
 * is the same value as rounding the exact quotient straight to `float` (the intermediate has
 * more than the 2p+2 bits the double-rounding argument needs), so no intermediate `f32` on the
 * operands is required.
 */
export function nsynjiPerNeuron(synapseCountFromTo: number, neuronCountTo: number): number {
  return f32(synapseCountFromTo / neuronCountTo);
}

/**
 * Native `GroupsBrain.cc:688` — `int synapseCount_new = short( nsynjiperneur + remainder[groupIndex_from] + 1.e-5 );`
 *
 * **Both operands are `float`**, so the first `+` is a float addition that rounds to `float`
 * before the `double` literal `1.e-5` promotes the result; only then does `short(...)` truncate
 * a `double`. Adding all three terms in `double` (the reading this note corrects) differs from
 * native whenever `f32(nsynjiperneur + remainder)` crosses the integer the `double` sum sits
 * just below/above — one connection per group pair, and therefore every downstream
 * `anatomy`/`function`/`synapses` byte.
 */
export function synapseCountNew(nsynjiperneur: number, remainderFrom: number): number {
  return toShort(f32(nsynjiperneur + remainderFrom) + 1.e-5);
}

/** Native `GroupsBrain.cc:689` — `remainder[groupIndex_from] += nsynjiperneur - synapseCount_new;` */
export function remainderUpdate(remainderFrom: number, nsynjiperneur: number, synapseCountNew_: number): number {
  return f32(remainderFrom + f32(nsynjiperneur - synapseCountNew_));
}

/**
 * Native `GroupsBrain.cc:713` + `:714` — the base local index and its `max<short>/min<short>`
 * clamp.
 *
 * The subtrahend `float(synapseCount_new) * 0.5` is a `double` (the `0.5` literal promotes the
 * float product), so the difference is a `double` and `short(...)` truncates *that*: there is no
 * float store between the subtraction and the cast. The clamp then narrows
 * `neuronCount_from - synapseCount_new` to `short` exactly as `min<short>` does.
 */
export function neuronLocalIndexFromBase(
  neuronLocalIndexTo: number,
  neuronCountTo: number,
  neuronCountFrom: number,
  synapseCountNew_: number,
): number {
  const raw = toShort(f32(f32(neuronLocalIndexTo / neuronCountTo) * f32(neuronCountFrom)) - f32(synapseCountNew_) * 0.5);
  return Math.max(toShort(0), Math.min(toShort(neuronCountFrom - synapseCountNew_), raw));
}

/**
 * Which native branch of `growSynapses` produced `td_fromto_abs`
 * (`GroupsBrain.cc:764` / `:769` / `:775`).
 */
export const TdAbsBranch = {
  /** not mirrored — `td_fromto_abs = td_fromto;` */
  UNMIRRORED: 0,
  /** mirrored, `td_fromto < 0.5` — `td_fromto_abs = td_fromto * 2;` */
  MIRRORED_LOW: 1,
  /** mirrored, `td_fromto >= 0.5` — `td_fromto_abs = (1 - td_fromto) * 2;` */
  MIRRORED_HIGH: 2,
} as const;

export type TdAbsBranchValue = (typeof TdAbsBranch)[keyof typeof TdAbsBranch];

/**
 * Native `GroupsBrain.cc:764/769/775` — `td_fromto_abs` is a **float**.
 *
 * The `1 - td_fromto` subtraction is float arithmetic (the `1` is converted to `float`), and a
 * "not mirrored" branch stores the gene value unchanged. The port keeps the double product for
 * the high branch unless it rounds: for a `td_fromto` above 1 the exact `1 - td`/`* 2` need not
 * be representable in `float`, and the value feeds `distortion` below.
 */
export function tdFromToAbs(tdFromTo: number, branch: TdAbsBranchValue): number {
  switch (branch) {
    case TdAbsBranch.MIRRORED_LOW:
      return f32(tdFromTo * 2);
    case TdAbsBranch.MIRRORED_HIGH:
      return f32(f32(1 - tdFromTo) * 2);
    default:
      return f32(tdFromTo);
  }
}

/**
 * Native `GroupsBrain.cc:778` —
 *
 *   `short distortion = short( nint( td_rng->range(-0.5,0.5) * td_fromto_abs * neuronCount_from ) );`
 *
 * `range` returns a `double`, `td_fromto_abs` widens from `float`, `neuronCount_from` from
 * `int` — the product and the `nint` macro are all `double`, and only the `short(...)` narrows.
 *
 * **`nint` mentions its argument twice** (`utils/misc.h`:
 * `((long)((a)+(((a)<0.0)?-0.499999999:0.499999999)))`), so the `range()` *call* inside it is
 * made **twice**: a connection whose topological-distortion test passes consumes **four** draws
 * on the stream (the `drand()` test, `range()` for the sum, `range()` again for the sign test,
 * then the efficacy `range()`), while a failed test consumes two. That is model state, not an
 * implementation detail: this walk and the prebirth sensor draws share one per-agent
 * `NERVOUS_SYSTEM` MT19937 (`NervousSystem`'s rng, seeded with the agent's 1-based
 * `agentsEver`), so one extra or missing draw here desynchronises every later draw of that
 * agent's brain — measured 2026-09-28 (`t_e970f22a`): a single-draw reading left
 * `run/brain/**` byte-exact through output neuron 31 and wrong from 32 on (the first targets
 * whose connections all take the distortion branch) *and* every post-prebirth activation
 * wrong, because the prebirth retinal noise (`4 * retinaWidth` draws per cycle) was shifted.
 *
 * The compiler's evaluation order is the one transcribed here: the **first** draw feeds the sum
 * and the **second** only its sign (`native/brainprobe.cc`'s `distort` grid drives the macro
 * through a queued `range()` call and pins it, 29,808/29,808).
 *
 * PORT-NOTE(l6/groups-nint-contraction): and the sum is *contracted* into the last multiply of
 * that first evaluation — the shipped `libpolyworld.dylib`'s
 * `0x66dc0 fmadd d0, d9, d11, d0` with `d9 = RN(range1 * td_fromto_abs)` (`66d7c fmul`) and
 * `d11 = (double)neuronCount_from` (`66ce4 scvtf d11, w8`), so the binary computes
 * `RN( p * count + ±0.499999999 )` with **one** rounding, while the sign test at `66d98 fcmp`
 * reads the *other* evaluation's unfused product (`66d90`/`66d94 fmul`). Writing the argument as
 * a value (`nint( p * count )`) therefore transcribes one rounding too many. The two forms differ
 * only where the product lands within ~1 ulp of the truncation boundary; `nativeMath.ts`'s
 * `nintFused` carries the instruction, and `brainprobe growexpr`'s constructed *boundary* family
 * makes the difference observable rather than argued (522 rows, 141 `(td_abs, count)` shapes —
 * exact here, wrong in the round-then-add form; `t_7d391d0f`).
 *
 * The sibling site in the same function, `0x66b70 fmadd d0, d1, d2, d0` (line 713's
 * `neuronLocalIndex_fromBase`), is the **other** `double`-class contraction and is *provably*
 * bit-identical to `neuronLocalIndexFromBase` below: its fused product is
 * `synapseCount_new * -0.5`, exact in binary64 for every integer count, and its addend is a
 * binary32 widened exactly, so no input can separate the fused and two-step sums (`t_7d391d0f`).
 */
export function distortionIndex(
  termA: number,
  termB: number,
  tdFromToAbs_: number,
  neuronCountFrom: number,
): number {
  const product = termA * tdFromToAbs_; // fmul  d9, d0, d10   — the rounded intermediate
  const test = termB * tdFromToAbs_ * neuronCountFrom; // the sign test's own (unfused) product
  return toShort(nintFused(product, neuronCountFrom, test < 0.0));
}

/**
 * Native `GroupsBrain.cc:822` — `float stdev = _genome->get( WEIGHT_STDEV, … ) * Brain::config.gaussianInitMaxStdev;`
 *
 * The gene value arrives as a `float` (`Scalar::fval`), the config field is a `float`
 * (Brain.h:102) and `operator * ( Scalar &, float )` returns a `float` (Scalar.cc:143), so the
 * product is a float product stored in a float.
 */
export function stdevOf(weightStdevGene: number, gaussianInitMaxStdev: number): number {
  return f32(weightStdevGene * gaussianInitMaxStdev);
}
