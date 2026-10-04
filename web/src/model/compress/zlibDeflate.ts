/**
 * Dependency-free, browser-safe transcription of upstream zlib's raw DEFLATE.
 *
 * PORT-NOTE(zlib-deflate/upstream-transcription): the recorded `.gz` goldens are
 * *upstream* zlib level-6 raw deflate. Neither node's bundled zlib nor Chromium's
 * `CompressionStream` is upstream — both ship Google's patched "motley" fork, whose
 * LZ77 match selection differs and therefore emits a different (slightly smaller)
 * stream for identical content (the node builds measured here link a zlib that
 * reproduces 25/150 golden containers, Chrome 26/190 — a node linked against
 * upstream zlib 1.2.12 reproduces all 150, so the count is the linked zlib's, not
 * node's: t_16ac7810). `fflate` is not a zlib port at all (0/150). The only way
 * to write the golden container bytes *and* run in a browser is to transcribe the
 * algorithm, so this module is a line-by-line port of upstream zlib 1.3.1
 * (`deflate.c`, `trees.c`, `deflate.h`, `zutil.h`) at the exact configuration the
 * goldens use:
 *
 *     level 6, memLevel 8, windowBits -15, Z_DEFAULT_STRATEGY,
 *     one deflate(Z_FINISH) call, no mid-stream flush.
 *
 * That is what native's `gzopen`/`gzwrite` + `gzclose` produced for the goldens
 * (apple libz 1.2.12; vanilla 1.2.12 and 1.3.1 are byte-identical to it on this
 * content — measured in `docs/specs/gzip-containers.md`, task t_091ec5b8). Ported
 * pieces: `deflate_slow` (configuration_table[6] = {8, 16, 128, 128}) and with it
 * `fill_window` / `longest_match` / `lm_init` / `slide_hash` / `INSERT_STRING` /
 * `read_buf`, and `trees.c`'s `_tr_init` / `_tr_tally` / `_tr_flush_block` (incl.
 * its `opt_len` / `static_len` block-type decision) / `build_tree` / `gen_bitlen` /
 * `gen_codes` / `scan_tree` / `send_tree` / `build_bl_tree` / `send_all_trees` /
 * `compress_block` / bit I/O. `tr_static_init` is computed at load time rather than
 * tabulated by hand.
 *
 * PORT-NOTE(zlib-deflate/deviations): the transcription is faithful, not literal:
 *   * `deflate()`'s wrapper/state machinery is collapsed to the one call the port
 *     makes. `wrap == 0` with `Z_FINISH` means "no zlib/gzip header, no trailer"
 *     and the block loop runs once; every byte of the stream is produced by the
 *     ported `deflate_slow` + tree code. `deflate_stored`/`deflate_fast`/
 *     `deflate_rle`/`deflate_huff` are unreachable at level 6 / Z_DEFAULT_STRATEGY
 *     and are not ported.
 *   * `pending_buf` is a growable byte sink instead of a fixed 64 KiB buffer whose
 *     tail overlaps `sym_buf`. The overlapping layout is a memory optimisation, not
 *     an encoding decision: `flush_pending` only moves already-emitted bytes, and
 *     `_tr_flush_bits` (the `bi_flush` it performs) keeps at most 7 bits in the bit
 *     buffer exactly as native. Nothing about the emitted bytes depends on the
 *     capacity of `pending_buf` here because the port never runs out of output
 *     space (native's `avail_out` is unbounded in this port).
 *   * `strm->data_type` / `detect_data_type()` feed only a caller-visible byte of
 *     `z_stream` state; they never reach the compressed stream, so they are omitted.
 *   * `ulg` arithmetic that transiently wraps in C (`opt_len--` on an empty block)
 *     is done in JS `number`. The wrapped intermediates cancel before any decision
 *     is taken; `opt_len`/`static_len` are small and exact in f64.
 *   * `prev`/`head`/trees use typed arrays; `depth` is `uch`, `Pos` is `ush`, all
 *     as in `deflate.h`. `noUncheckedIndexedAccess` needs the `!` reads below but
 *     every index is provably in range (native indexes the same arrays the same
 *     way; `longest_match` may read up to `strstart + MAX_MATCH`, which the window
 *     is sized for).
 *
 * See also `gzipContainer`, the container writer the sinks use, whose 10-byte
 * header is the one the goldens carry: `1f 8b 08 00 00 00 00 00 00 13`
 * (mtime 0, XFL 0, OS 0x13) — identical in upstream zlib, node and Chrome; only
 * the deflate stream ever differed.
 */

//===========================================================================
// Constants (deflate.h / deflate.c / trees.c)
//===========================================================================

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1; // 262
const MAX_DIST = 32768 - MIN_LOOKAHEAD; // w_size - MIN_LOOKAHEAD == 32506
const TOO_FAR = 4096;

const W_BITS = 15;
const W_SIZE = 1 << W_BITS; // 32768
const W_MASK = W_SIZE - 1;
const WINDOW_SIZE = 2 * W_SIZE; // 65536

const MEM_LEVEL = 8;
const HASH_BITS = MEM_LEVEL + 7; // 15
const HASH_SIZE = 1 << HASH_BITS; // 32768
const HASH_MASK = HASH_SIZE - 1;
const HASH_SHIFT = ((HASH_BITS + MIN_MATCH - 1) / MIN_MATCH) | 0; // 5

const LIT_BUFSIZE = 1 << (MEM_LEVEL + 6); // 16384
const SYM_BUF_SIZE = LIT_BUFSIZE * 3;
const SYM_END = (LIT_BUFSIZE - 1) * 3; // 49149

const LENGTH_CODES = 29;
const LITERALS = 256;
const L_CODES = LITERALS + 1 + LENGTH_CODES; // 286
const D_CODES = 30;
const BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1; // 573
const MAX_BITS = 15;
const MAX_BL_BITS = 7;
const BUF_SIZE = 16;

const END_BLOCK = 256;
const REP_3_6 = 16;
const REPZ_3_10 = 17;
const REPZ_11_138 = 18;

const STORED_BLOCK = 0;
const STATIC_TREES = 1;
const DYN_TREES = 2;

// configuration_table[6] — level 6, the frozen configuration.
const GOOD_MATCH = 8;
const MAX_LAZY = 16;
const NICE_MATCH = 128;
const MAX_CHAIN = 128;

// trees.c extra-bit tables.
const EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

//===========================================================================
// tr_static_init(): length/distance code maps and the static trees
//===========================================================================

const LENGTH_CODE = new Uint8Array(MAX_MATCH - MIN_MATCH + 1); // 256
const DIST_CODE = new Uint8Array(512);
const BASE_LENGTH = new Int32Array(LENGTH_CODES);
const BASE_DIST = new Int32Array(D_CODES);

interface StaticTree {
  code: Uint16Array;
  len: Uint16Array;
}

const STATIC_LTREE: StaticTree = { code: new Uint16Array(L_CODES + 2), len: new Uint16Array(L_CODES + 2) };
const STATIC_DTREE: StaticTree = { code: new Uint16Array(D_CODES), len: new Uint16Array(D_CODES) };

/** trees.c `bi_reverse()` — reverse the low `len` bits of `code`. */
function biReverse(code: number, len: number): number {
  let res = 0;
  do {
    res |= code & 1;
    code >>>= 1;
    res <<= 1;
  } while (--len > 0);
  return res >>> 1;
}

/** trees.c `gen_codes()` — canonical Huffman codes from bit lengths. */
function genCodes(tree: StaticTree, maxCode: number, blCount: Uint16Array): void {
  const nextCode = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + blCount[bits - 1]!) << 1;
    nextCode[bits] = code & 0xffff;
  }
  for (let n = 0; n <= maxCode; n++) {
    const len = tree.len[n]!;
    if (len === 0) continue;
    tree.code[n] = biReverse(nextCode[len]!, len) & 0xffff;
    nextCode[len]!++;
  }
}

(function trStaticInit(): void {
  // length (0..255) -> length code (0..28)
  let length = 0;
  let code = 0;
  for (code = 0; code < LENGTH_CODES - 1; code++) {
    BASE_LENGTH[code] = length;
    for (let n = 0; n < 1 << EXTRA_LBITS[code]!; n++) LENGTH_CODE[length++] = code;
  }
  // length 255 (match length 258) is code 285, overwriting the code-284 encoding.
  LENGTH_CODE[length - 1] = code;

  // dist (0..32K) -> dist code (0..29)
  let dist = 0;
  for (code = 0; code < 16; code++) {
    BASE_DIST[code] = dist;
    for (let n = 0; n < 1 << EXTRA_DBITS[code]!; n++) DIST_CODE[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    BASE_DIST[code] = dist << 7;
    for (let n = 0; n < 1 << (EXTRA_DBITS[code]! - 7); n++) DIST_CODE[256 + dist++] = code;
  }

  // static literal tree
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  while (n <= 143) ((STATIC_LTREE.len[n++] = 8), blCount[8]!++);
  while (n <= 255) ((STATIC_LTREE.len[n++] = 9), blCount[9]!++);
  while (n <= 279) ((STATIC_LTREE.len[n++] = 7), blCount[7]!++);
  while (n <= 287) ((STATIC_LTREE.len[n++] = 8), blCount[8]!++);
  genCodes(STATIC_LTREE, L_CODES + 1, blCount);

  // the static distance tree is trivial (5 bits each)
  for (n = 0; n < D_CODES; n++) {
    STATIC_DTREE.len[n] = 5;
    STATIC_DTREE.code[n] = biReverse(n, 5);
  }
})();

/** deflate.h `d_code(dist)` — `dist` is the distance - 1. */
function dCode(dist: number): number {
  return dist < 256 ? DIST_CODE[dist]! : DIST_CODE[256 + (dist >> 7)]!;
}

//===========================================================================
// Huffman tree
//===========================================================================

/**
 * deflate.h `ct_data` — `Freq`/`Code` overlay one field, `Dad`/`Len` another; the
 * port keeps the four arrays apart, which is observably identical (native never
 * reads a field after writing its overlay partner without an intervening write).
 */
class Tree {
  readonly freq: Uint16Array;
  readonly code: Uint16Array;
  readonly dad: Uint16Array;
  readonly len: Uint16Array;

  constructor(size: number) {
    this.freq = new Uint16Array(size);
    this.code = new Uint16Array(size);
    this.dad = new Uint16Array(size);
    this.len = new Uint16Array(size);
  }
}

interface TreeDesc {
  dynTree: Tree;
  maxCode: number;
  staticTree: StaticTree | null;
  extraBits: number[] | null;
  extraBase: number;
  elems: number;
  maxLength: number;
}

//===========================================================================
// DeflateState — deflate_state + the ported deflate_slow/trees.c machinery
//===========================================================================

class DeflateState {
  // --- output (native's pending_buf, grown as needed; see PORT-NOTE) ---
  private out = new Uint8Array(1 << 16);
  private outLen = 0;

  // --- bit I/O (trees.c) ---
  private biBuf = 0;
  private biValid = 0;

  // --- deflate.c ---
  private readonly window = new Uint8Array(WINDOW_SIZE);
  private readonly prev = new Uint16Array(W_SIZE);
  private readonly head = new Uint16Array(HASH_SIZE);
  private highWater = 0;
  private insH = 0;

  private strstart = 0;
  private blockStart = 0;
  private lookahead = 0;
  private insert = 0;
  private matchStart = 0;
  private matchLength = MIN_MATCH - 1;
  private prevLength = MIN_MATCH - 1;
  private prevMatch = 0;
  private matchAvailable = 0;
  private matches = 0;

  private readonly maxChainLength = MAX_CHAIN;
  private readonly maxLazyMatch = MAX_LAZY;
  private readonly goodMatch = GOOD_MATCH;
  private readonly niceMatch = NICE_MATCH;

  // --- input ---
  private readonly input: Uint8Array;
  private inPos = 0;
  private availIn: number;

  // --- trees.c ---
  private readonly dynLtree = new Tree(HEAP_SIZE);
  private readonly dynDtree = new Tree(2 * D_CODES + 1);
  private readonly blTree = new Tree(2 * BL_CODES + 1);
  private readonly blCount = new Uint16Array(MAX_BITS + 1);
  private readonly heap = new Int32Array(HEAP_SIZE);
  private readonly depth = new Uint8Array(HEAP_SIZE);
  private heapLen = 0;
  private heapMax = 0;
  private optLen = 0;
  private staticLen = 0;
  private symNext = 0;
  private readonly symBuf = new Uint8Array(SYM_BUF_SIZE);

  private readonly lDesc: TreeDesc = {
    dynTree: this.dynLtree,
    maxCode: 0,
    staticTree: STATIC_LTREE,
    extraBits: EXTRA_LBITS,
    extraBase: LITERALS + 1,
    elems: L_CODES,
    maxLength: MAX_BITS,
  };
  private readonly dDesc: TreeDesc = {
    dynTree: this.dynDtree,
    maxCode: 0,
    staticTree: STATIC_DTREE,
    extraBits: EXTRA_DBITS,
    extraBase: 0,
    elems: D_CODES,
    maxLength: MAX_BITS,
  };
  private readonly blDesc: TreeDesc = {
    dynTree: this.blTree,
    maxCode: 0,
    staticTree: null,
    extraBits: EXTRA_BLBITS,
    extraBase: 0,
    elems: BL_CODES,
    maxLength: MAX_BL_BITS,
  };

  private blDescMaxCode = 0;

  constructor(input: Uint8Array) {
    this.input = input;
    this.availIn = input.length;
    this.lmInit();
    this.initBlock();
  }

  /** trees.c `_tr_init()` (tr_static_init is done at module load). */
  private lmInit(): void {
    this.head.fill(0); // CLEAR_HASH
    this.strstart = 0;
    this.blockStart = 0;
    this.lookahead = 0;
    this.insert = 0;
    this.matchLength = MIN_MATCH - 1;
    this.prevLength = MIN_MATCH - 1;
    this.matchAvailable = 0;
    this.insH = 0;
    this.biBuf = 0;
    this.biValid = 0;
  }

  // -------------------------------------------------------------------------
  // output + bit I/O
  // -------------------------------------------------------------------------

  private putByte(c: number): void {
    if (this.outLen === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.outLen++] = c & 0xff;
  }

  private putShort(w: number): void {
    this.putByte(w & 0xff);
    this.putByte((w >>> 8) & 0xff);
  }

  /** trees.c `bi_flush()` — flush the bit buffer, keeping at most 7 bits. */
  private biFlush(): void {
    if (this.biValid === 16) {
      this.putShort(this.biBuf);
      this.biBuf = 0;
      this.biValid = 0;
    } else if (this.biValid >= 8) {
      this.putByte(this.biBuf & 0xff);
      this.biBuf = (this.biBuf >>> 8) & 0xffff;
      this.biValid -= 8;
    }
  }

  /** trees.c `bi_windup()` — flush and align on a byte boundary. */
  private biWindup(): void {
    if (this.biValid > 8) this.putShort(this.biBuf);
    else if (this.biValid > 0) this.putByte(this.biBuf & 0xff);
    this.biBuf = 0;
    this.biValid = 0;
  }

  /** trees.c `send_bits()`. */
  private sendBits(value: number, length: number): void {
    if (this.biValid > BUF_SIZE - length) {
      const val = value | 0;
      this.biBuf = (this.biBuf | (((val & 0xffff) << this.biValid) & 0xffff)) & 0xffff;
      this.putShort(this.biBuf);
      this.biBuf = ((val & 0xffff) >>> (BUF_SIZE - this.biValid)) & 0xffff;
      this.biValid += length - BUF_SIZE;
    } else {
      this.biBuf = (this.biBuf | (((value & 0xffff) << this.biValid) & 0xffff)) & 0xffff;
      this.biValid += length;
    }
  }

  /** trees.c `send_code()` — send one Huffman code. */
  private sendCode(c: number, tree: StaticTree | Tree): void {
    this.sendBits(tree.code[c]!, tree.len[c]!);
  }

  /** deflate.c `flush_pending()` — here only the `_tr_flush_bits` half matters. */
  private flushPending(): void {
    this.biFlush();
  }

  // -------------------------------------------------------------------------
  // trees.c
  // -------------------------------------------------------------------------

  /** trees.c `init_block()`. */
  private initBlock(): void {
    for (let n = 0; n < L_CODES; n++) this.dynLtree.freq[n] = 0;
    for (let n = 0; n < D_CODES; n++) this.dynDtree.freq[n] = 0;
    for (let n = 0; n < BL_CODES; n++) this.blTree.freq[n] = 0;
    this.dynLtree.freq[END_BLOCK] = 1;
    this.optLen = 0;
    this.staticLen = 0;
    this.symNext = 0;
    this.matches = 0;
  }

  /** deflate.h `_tr_tally_lit()`. Returns `bflush`. */
  private tallyLit(c: number): boolean {
    this.symBuf[this.symNext++] = 0;
    this.symBuf[this.symNext++] = 0;
    this.symBuf[this.symNext++] = c & 0xff;
    this.dynLtree.freq[c & 0xff]!++;
    return this.symNext === SYM_END;
  }

  /** deflate.h `_tr_tally_dist()`. Returns `bflush`. */
  private tallyDist(distance: number, length: number): boolean {
    const len = length & 0xff;
    const dist = distance & 0xffff;
    this.symBuf[this.symNext++] = dist & 0xff;
    this.symBuf[this.symNext++] = (dist >> 8) & 0xff;
    this.symBuf[this.symNext++] = len;
    this.dynLtree.freq[LENGTH_CODE[len]! + LITERALS + 1]!++;
    this.dynDtree.freq[dCode(dist - 1)]!++;
    return this.symNext === SYM_END;
  }

  /** trees.c `smaller()`. */
  private smaller(tree: Tree, n: number, m: number): boolean {
    const fn = tree.freq[n]!;
    const fm = tree.freq[m]!;
    return fn < fm || (fn === fm && this.depth[n]! <= this.depth[m]!);
  }

  /** trees.c `pqdownheap()`. */
  private pqdownheap(tree: Tree, k: number): void {
    const v = this.heap[k]!;
    let j = k << 1;
    while (j <= this.heapLen) {
      if (j < this.heapLen && this.smaller(tree, this.heap[j + 1]!, this.heap[j]!)) j++;
      if (this.smaller(tree, v, this.heap[j]!)) break;
      this.heap[k] = this.heap[j]!;
      k = j;
      j <<= 1;
    }
    this.heap[k] = v;
  }

  /** trees.c `gen_bitlen()`. */
  private genBitlen(tree: Tree, desc: TreeDesc): void {
    const maxCode = desc.maxCode;
    const stree = desc.staticTree;
    const extra = desc.extraBits;

    for (let bits = 0; bits <= MAX_BITS; bits++) this.blCount[bits] = 0;
    tree.len[this.heap[this.heapMax]!] = 0;

    let overflow = 0;
    let h: number;
    for (h = this.heapMax + 1; h < HEAP_SIZE; h++) {
      const n = this.heap[h]!;
      let bits = tree.len[tree.dad[n]!]! + 1;
      if (bits > desc.maxLength) {
        bits = desc.maxLength;
        overflow++;
      }
      tree.len[n] = bits;
      if (n > maxCode) continue;
      this.blCount[bits]!++;
      let xbits = 0;
      if (n >= desc.extraBase && extra) xbits = extra[n - desc.extraBase]!;
      const f = tree.freq[n]!;
      this.optLen += f * (bits + xbits);
      if (stree) this.staticLen += f * (stree.len[n]! + xbits);
    }
    if (overflow === 0) return;

    do {
      let bits = desc.maxLength - 1;
      while (this.blCount[bits]! === 0) bits--;
      this.blCount[bits]!--;
      this.blCount[bits + 1]! += 2;
      this.blCount[desc.maxLength]!--;
      overflow -= 2;
    } while (overflow > 0);

    for (let bits = desc.maxLength; bits !== 0; bits--) {
      let n = this.blCount[bits]!;
      while (n !== 0) {
        const m = this.heap[--h]!;
        if (m > maxCode) continue;
        if (tree.len[m]! !== bits) {
          this.optLen += (bits - tree.len[m]!) * tree.freq[m]!;
          tree.len[m] = bits;
        }
        n--;
      }
    }
  }

  /** trees.c `build_tree()`. */
  private buildTree(tree: Tree, desc: TreeDesc): void {
    const stree = desc.staticTree;
    const elems = desc.elems;
    let maxCode = -1;

    this.heapLen = 0;
    this.heapMax = HEAP_SIZE;

    for (let n = 0; n < elems; n++) {
      if (tree.freq[n]! !== 0) {
        this.heap[++this.heapLen] = n;
        maxCode = n;
        this.depth[n] = 0;
      } else {
        tree.len[n] = 0;
      }
    }

    while (this.heapLen < 2) {
      const node = (this.heap[++this.heapLen] = maxCode < 2 ? ++maxCode : 0);
      tree.freq[node] = 1;
      this.depth[node] = 0;
      this.optLen--;
      if (stree) this.staticLen -= stree.len[node]!;
    }
    desc.maxCode = maxCode;

    for (let n = this.heapLen >> 1; n >= 1; n--) this.pqdownheap(tree, n);

    let node = elems;
    do {
      // pqremove(tree, top)
      const n = this.heap[1]!;
      this.heap[1] = this.heap[this.heapLen--]!;
      this.pqdownheap(tree, 1);
      const m = this.heap[1]!;

      this.heap[--this.heapMax] = n;
      this.heap[--this.heapMax] = m;

      tree.freq[node] = tree.freq[n]! + tree.freq[m]!;
      this.depth[node] = ((this.depth[n]! >= this.depth[m]! ? this.depth[n]! : this.depth[m]!) + 1) & 0xff;
      tree.dad[n] = node;
      tree.dad[m] = node;
      this.heap[1] = node++;
      this.pqdownheap(tree, 1);
    } while (this.heapLen >= 2);

    this.heap[--this.heapMax] = this.heap[1]!;

    this.genBitlen(tree, desc);
    genCodesTree(tree, maxCode, this.blCount);
  }

  /** trees.c `scan_tree()`. */
  private scanTree(tree: Tree, maxCode: number): void {
    let prevlen = -1;
    let curlen: number;
    let nextlen = tree.len[0]!;
    let count = 0;
    let maxCount = 7;
    let minCount = 4;

    if (nextlen === 0) {
      maxCount = 138;
      minCount = 3;
    }
    tree.len[maxCode + 1] = 0xffff;

    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen;
      nextlen = tree.len[n + 1]!;
      if (++count < maxCount && curlen === nextlen) {
        continue;
      } else if (count < minCount) {
        this.blTree.freq[curlen]! += count;
      } else if (curlen !== 0) {
        if (curlen !== prevlen) this.blTree.freq[curlen]!++;
        this.blTree.freq[REP_3_6]!++;
      } else if (count <= 10) {
        this.blTree.freq[REPZ_3_10]!++;
      } else {
        this.blTree.freq[REPZ_11_138]!++;
      }
      count = 0;
      prevlen = curlen;
      if (nextlen === 0) {
        maxCount = 138;
        minCount = 3;
      } else if (curlen === nextlen) {
        maxCount = 6;
        minCount = 3;
      } else {
        maxCount = 7;
        minCount = 4;
      }
    }
  }

  /** trees.c `send_tree()`. */
  private sendTree(tree: Tree, maxCode: number): void {
    let prevlen = -1;
    let curlen: number;
    let nextlen = tree.len[0]!;
    let count = 0;
    let maxCount = 7;
    let minCount = 4;

    if (nextlen === 0) {
      maxCount = 138;
      minCount = 3;
    }

    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen;
      nextlen = tree.len[n + 1]!;
      if (++count < maxCount && curlen === nextlen) {
        continue;
      } else if (count < minCount) {
        do {
          this.sendCode(curlen, this.blTree);
        } while (--count !== 0);
      } else if (curlen !== 0) {
        if (curlen !== prevlen) {
          this.sendCode(curlen, this.blTree);
          count--;
        }
        this.sendCode(REP_3_6, this.blTree);
        this.sendBits(count - 3, 2);
      } else if (count <= 10) {
        this.sendCode(REPZ_3_10, this.blTree);
        this.sendBits(count - 3, 3);
      } else {
        this.sendCode(REPZ_11_138, this.blTree);
        this.sendBits(count - 11, 7);
      }
      count = 0;
      prevlen = curlen;
      if (nextlen === 0) {
        maxCount = 138;
        minCount = 3;
      } else if (curlen === nextlen) {
        maxCount = 6;
        minCount = 3;
      } else {
        maxCount = 7;
        minCount = 4;
      }
    }
  }

  /** trees.c `build_bl_tree()`. */
  private buildBlTree(): number {
    this.scanTree(this.dynLtree, this.lDesc.maxCode);
    this.scanTree(this.dynDtree, this.dDesc.maxCode);
    this.blDescMaxCode = this.blDesc.maxCode;
    this.buildTree(this.blTree, this.blDesc);

    let maxBlindex: number;
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) {
      if (this.blTree.len[BL_ORDER[maxBlindex]!]! !== 0) break;
    }
    this.optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  }

  /** trees.c `send_all_trees()`. */
  private sendAllTrees(lcodes: number, dcodes: number, blcodes: number): void {
    this.sendBits(lcodes - 257, 5);
    this.sendBits(dcodes - 1, 5);
    this.sendBits(blcodes - 4, 4);
    for (let rank = 0; rank < blcodes; rank++) {
      this.sendBits(this.blTree.len[BL_ORDER[rank]!]!, 3);
    }
    this.sendTree(this.dynLtree, lcodes - 1);
    this.sendTree(this.dynDtree, dcodes - 1);
  }

  /** trees.c `compress_block()`. */
  private compressBlock(ltree: StaticTree | Tree, dtree: StaticTree | Tree): void {
    let sx = 0;
    if (this.symNext !== 0) {
      do {
        let dist = this.symBuf[sx++]! & 0xff;
        dist += (this.symBuf[sx++]! & 0xff) << 8;
        let lc = this.symBuf[sx++]!;
        if (dist === 0) {
          this.sendCode(lc, ltree);
        } else {
          let code = LENGTH_CODE[lc]!;
          this.sendCode(code + LITERALS + 1, ltree);
          let extra = EXTRA_LBITS[code]!;
          if (extra !== 0) {
            lc -= BASE_LENGTH[code]!;
            this.sendBits(lc, extra);
          }
          dist--;
          code = dCode(dist);
          this.sendCode(code, dtree);
          extra = EXTRA_DBITS[code]!;
          if (extra !== 0) {
            dist -= BASE_DIST[code]!;
            this.sendBits(dist, extra);
          }
        }
      } while (sx < this.symNext);
    }
    this.sendCode(END_BLOCK, ltree);
  }

  /** trees.c `_tr_stored_block()`. */
  private trStoredBlock(buf: Uint8Array | null, storedLen: number, last: number): void {
    this.sendBits((STORED_BLOCK << 1) + last, 3);
    this.biWindup();
    this.putShort(storedLen & 0xffff);
    this.putShort(~storedLen & 0xffff);
    if (storedLen && buf) {
      for (let i = 0; i < storedLen; i++) this.putByte(buf[i]!);
    }
  }

  /** trees.c `_tr_flush_block()`. */
  private flushBlock(buf: Uint8Array | null, storedLen: number, last: number): void {
    let optLenb: number;
    let staticLenb: number;
    let maxBlindex = 0;

    if (LIT_MEM_LEVEL_GT_ZERO) {
      this.buildTree(this.dynLtree, this.lDesc);
      this.buildTree(this.dynDtree, this.dDesc);
      maxBlindex = this.buildBlTree();

      optLenb = Math.floor((this.optLen + 3 + 7) / 8);
      staticLenb = Math.floor((this.staticLen + 3 + 7) / 8);
      if (staticLenb <= optLenb) optLenb = staticLenb;
    } else {
      optLenb = staticLenb = storedLen + 5;
    }

    if (storedLen + 4 <= optLenb && buf !== null) {
      this.trStoredBlock(buf, storedLen, last);
    } else if (staticLenb === optLenb) {
      this.sendBits((STATIC_TREES << 1) + last, 3);
      this.compressBlock(STATIC_LTREE, STATIC_DTREE);
    } else {
      this.sendBits((DYN_TREES << 1) + last, 3);
      this.sendAllTrees(this.lDesc.maxCode + 1, this.dDesc.maxCode + 1, maxBlindex + 1);
      this.compressBlock(this.dynLtree, this.dynDtree);
    }

    this.initBlock();
    if (last) this.biWindup();
  }

  // -------------------------------------------------------------------------
  // deflate.c
  // -------------------------------------------------------------------------

  /** deflate.c `read_buf()` — copy input into the window; no adler/crc for raw. */
  private readBuf(size: number): number {
    let len = this.availIn;
    if (len > size) len = size;
    if (len === 0) return 0;
    this.availIn -= len;
    const target = this.strstart + this.lookahead;
    this.window.set(this.input.subarray(this.inPos, this.inPos + len), target);
    this.inPos += len;
    return len;
  }

  /** deflate.c `slide_hash()`. */
  private slideHash(): void {
    const wsize = W_SIZE;
    for (let n = HASH_SIZE; n > 0; n--) {
      const i = n - 1;
      const m = this.head[i]!;
      this.head[i] = m >= wsize ? m - wsize : 0;
    }
    for (let n = wsize; n > 0; n--) {
      const i = n - 1;
      const m = this.prev[i]!;
      this.prev[i] = m >= wsize ? m - wsize : 0;
    }
  }

  /** deflate.c `fill_window()`. */
  private fillWindow(): void {
    const wsize = W_SIZE;
    do {
      let more = WINDOW_SIZE - this.lookahead - this.strstart;

      if (this.strstart >= wsize + MAX_DIST) {
        this.window.copyWithin(0, wsize, wsize + (wsize - more));
        this.matchStart -= wsize;
        this.strstart -= wsize;
        this.blockStart -= wsize;
        if (this.insert > this.strstart) this.insert = this.strstart;
        this.slideHash();
        more += wsize;
      }
      if (this.availIn === 0) break;

      const n = this.readBuf(more);
      this.lookahead += n;

      if (this.lookahead + this.insert >= MIN_MATCH) {
        let str = this.strstart - this.insert;
        this.insH = this.window[str]!;
        this.insH = ((this.insH << HASH_SHIFT) ^ this.window[str + 1]!) & HASH_MASK;
        while (this.insert) {
          this.insH = ((this.insH << HASH_SHIFT) ^ this.window[str + MIN_MATCH - 1]!) & HASH_MASK;
          this.prev[str & W_MASK] = this.head[this.insH]!;
          this.head[this.insH] = str;
          str++;
          this.insert--;
          if (this.lookahead + this.insert < MIN_MATCH) break;
        }
      }
    } while (this.lookahead < MIN_LOOKAHEAD && this.availIn !== 0);

    // Zero WIN_INIT bytes past the data (native's high-water logic); the port's
    // window is zero-initialised, but a slide can leave stale tail bytes.
    if (this.highWater < WINDOW_SIZE) {
      const curr = this.strstart + this.lookahead;
      if (this.highWater < curr) {
        let init = WINDOW_SIZE - curr;
        if (init > MAX_MATCH) init = MAX_MATCH;
        this.window.fill(0, curr, curr + init);
        this.highWater = curr + init;
      } else if (this.highWater < curr + MAX_MATCH) {
        let init = curr + MAX_MATCH - this.highWater;
        if (init > WINDOW_SIZE - this.highWater) init = WINDOW_SIZE - this.highWater;
        this.window.fill(0, this.highWater, this.highWater + init);
        this.highWater += init;
      }
    }
  }

  /** deflate.c `INSERT_STRING()` — returns the previous chain head. */
  private insertString(str: number): number {
    this.insH = ((this.insH << HASH_SHIFT) ^ this.window[str + MIN_MATCH - 1]!) & HASH_MASK;
    const matchHead = this.head[this.insH]!;
    this.prev[str & W_MASK] = matchHead;
    this.head[this.insH] = str;
    return matchHead;
  }

  /** deflate.c `longest_match()` (the portable, non-UNALIGNED_OK body). */
  private longestMatch(curMatch: number): number {
    let chainLength = this.maxChainLength;
    const scanBase = this.strstart;
    let scan = scanBase;
    let match = 0;
    let len: number;
    let bestLen = this.prevLength;
    let niceMatch = this.niceMatch;
    const limit = this.strstart > MAX_DIST ? this.strstart - MAX_DIST : 0;
    const wmask = W_MASK;
    const strend = scanBase + MAX_MATCH;
    let scanEnd1 = this.window[scanBase + bestLen - 1]!;
    let scanEnd = this.window[scanBase + bestLen]!;

    if (this.prevLength >= this.goodMatch) chainLength >>= 2;
    if (niceMatch > this.lookahead) niceMatch = this.lookahead;

    do {
      match = curMatch;

      if (
        this.window[match + bestLen] !== scanEnd ||
        this.window[match + bestLen - 1] !== scanEnd1 ||
        this.window[match] !== this.window[scan] ||
        this.window[match + 1] !== this.window[scan + 1]
      ) {
        // `continue` in C: fall through to the chain-walk update below.
      } else {
        // The filter above ends with `*++match`, so `match` is already `curMatch+1`;
        // `scan += 2, match++` then leaves both at +2, matching C exactly.
        scan += 2;
        match += 2;

        let failed = false;
        do {
          for (let k = 0; k < 8; k++) {
            scan++;
            match++;
            if (this.window[scan] !== this.window[match]) {
              failed = true;
              break;
            }
          }
        } while (!failed && scan < strend);

        // Non-UNALIGNED_OK path: no `if (*scan == *match) scan++` (that line is
        // UNALIGNED_OK-only); `len` is exactly `MAX_MATCH - (strend - scan)`.
        len = MAX_MATCH - (strend - scan);
        scan = strend - MAX_MATCH;

        if (len > bestLen) {
          this.matchStart = curMatch;
          bestLen = len;
          if (len >= niceMatch) break;
          scanEnd1 = this.window[scan + bestLen - 1]!;
          scanEnd = this.window[scan + bestLen]!;
        }
      }

      curMatch = this.prev[curMatch & wmask]!;
      if (!(curMatch > limit)) break;
      if (--chainLength === 0) break;
    } while (true);

    if (bestLen <= this.lookahead) return bestLen;
    return this.lookahead;
  }

  /** deflate.c `deflate_slow()` with `flush == Z_FINISH`. */
  private deflateSlow(): void {
    for (;;) {
      if (this.lookahead < MIN_LOOKAHEAD) {
        this.fillWindow();
        if (this.lookahead === 0) break;
      }

      let hashHead = 0;
      if (this.lookahead >= MIN_MATCH) hashHead = this.insertString(this.strstart);

      this.prevLength = this.matchLength;
      this.prevMatch = this.matchStart;
      this.matchLength = MIN_MATCH - 1;

      if (hashHead !== 0 && this.prevLength < this.maxLazyMatch && this.strstart - hashHead <= MAX_DIST) {
        this.matchLength = this.longestMatch(hashHead);

        if (this.matchLength <= 5 && this.matchLength === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR) {
          this.matchLength = MIN_MATCH - 1;
        }
      }

      if (this.prevLength >= MIN_MATCH && this.matchLength <= this.prevLength) {
        const maxInsert = this.strstart + this.lookahead - MIN_MATCH;

        const bflush = this.tallyDist(this.strstart - 1 - this.prevMatch, this.prevLength - MIN_MATCH);

        this.lookahead -= this.prevLength - 1;
        this.prevLength -= 2;
        do {
          if (++this.strstart <= maxInsert) hashHead = this.insertString(this.strstart);
        } while (--this.prevLength !== 0);
        this.matchAvailable = 0;
        this.matchLength = MIN_MATCH - 1;
        this.strstart++;

        if (bflush) this.flushBlockOnly(0);
      } else if (this.matchAvailable) {
        const bflush = this.tallyLit(this.window[this.strstart - 1]!);
        if (bflush) this.flushBlockOnly(0);
        this.strstart++;
        this.lookahead--;
      } else {
        this.matchAvailable = 1;
        this.strstart++;
        this.lookahead--;
      }
    }

    if (this.matchAvailable) {
      this.tallyLit(this.window[this.strstart - 1]!);
      this.matchAvailable = 0;
    }
    this.insert = this.strstart < MIN_MATCH - 1 ? this.strstart : MIN_MATCH - 1;

    // flush == Z_FINISH
    this.flushBlockBlock(1);
  }

  /** deflate.c `FLUSH_BLOCK_ONLY(s, last)`. */
  private flushBlockOnly(last: number): void {
    const buf =
      this.blockStart >= 0 ? this.window.subarray(this.blockStart, this.blockStart + (this.strstart - this.blockStart)) : null;
    this.flushBlock(buf, this.strstart - this.blockStart, last);
    this.blockStart = this.strstart;
    this.flushPending();
  }

  /** deflate.c `FLUSH_BLOCK(s, last)` — `avail_out` is unbounded here. */
  private flushBlockBlock(last: number): void {
    this.flushBlockOnly(last);
  }

  /** Run the whole stream and return the raw deflate bytes. */
  run(): Uint8Array {
    this.deflateSlow();
    return this.out.slice(0, this.outLen);
  }
}

// `s->level > 0` in `_tr_flush_block` — always true at level 6.
const LIT_MEM_LEVEL_GT_ZERO = true;

/**
 * trees.c `gen_codes()` over a `Tree` (the static-tree overload takes `StaticTree`;
 * both have `code`/`len`).
 */
function genCodesTree(tree: Tree, maxCode: number, blCount: Uint16Array): void {
  const nextCode = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + blCount[bits - 1]!) << 1;
    nextCode[bits] = code & 0xffff;
  }
  for (let n = 0; n <= maxCode; n++) {
    const len = tree.len[n]!;
    if (len === 0) continue;
    tree.code[n] = biReverse(nextCode[len]!, len) & 0xffff;
    nextCode[len]!++;
  }
}

//===========================================================================
// Container writer
//===========================================================================

/** The gzip header the recorded goldens carry (mtime 0, XFL 0, OS 0x13). */
export const GZIP_HEADER = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13]);

/** CRC-32 (IEEE 802.3) table, generated (never tabulated by hand). */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib `crc32(0, payload, len)`. */
export function crc32(payload: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < payload.length; i++) {
    c = CRC_TABLE[(c ^ payload[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Raw DEFLATE (no wrapper), the frozen goldens' configuration:
 * level 6, memLevel 8, windowBits -15, Z_DEFAULT_STRATEGY, single Z_FINISH shot.
 */
export function deflateRaw(payload: Uint8Array): Uint8Array {
  return new DeflateState(payload).run();
}

/**
 * gzip container: the fixed 10-byte header + the raw deflate stream + CRC-32 and
 * ISIZE (both little-endian, ISIZE mod 2^32). Byte-identical to the recorded
 * goldens for the frozen configuration.
 */
export function gzipContainer(payload: Uint8Array): Uint8Array {
  const deflated = deflateRaw(payload);
  const out = new Uint8Array(10 + deflated.length + 8);
  out.set(GZIP_HEADER, 0);
  out.set(deflated, 10);
  const crc = crc32(payload);
  const isize = payload.length >>> 0;
  const trailer = 10 + deflated.length;
  out[trailer] = crc & 0xff;
  out[trailer + 1] = (crc >>> 8) & 0xff;
  out[trailer + 2] = (crc >>> 16) & 0xff;
  out[trailer + 3] = (crc >>> 24) & 0xff;
  out[trailer + 4] = isize & 0xff;
  out[trailer + 5] = (isize >>> 8) & 0xff;
  out[trailer + 6] = (isize >>> 16) & 0xff;
  out[trailer + 7] = (isize >>> 24) & 0xff;
  return out;
}
