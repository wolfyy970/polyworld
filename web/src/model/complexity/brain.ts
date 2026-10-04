/**
 * Lane L13 — `complexity/complexity_brain.cc`, transcribed.
 *
 * This is the half of the lane the *simulation* uses: `analyzeBrain` calls
 * `CalcComplexity_brainfunction( brainFunctionPath, fComplexityType, fEvents )` for every dead
 * agent (`Simulation.cc:3626-3632`), and `AgentFitness` calls it again when a complexity is
 * still unset (`Simulation.cc:3792-3806`). It reads the agent's recorded brain function file
 * back, reduces it to the neuron subset the `parts` string names, and hands the matrix to
 * `./algorithm.ts`.
 *
 * `parts` (`complexity_brain.cc:224-268`) is a small language, and every letter is
 * load-bearing:
 *
 *   `A`  all neurons (`CalcApproximateFullComplexityWithMatrix` on the whole matrix)
 *   `P`  the processing/output neurons — columns `numinputneurons .. numcols-1`
 *   `I`  the input neurons — columns `0 .. numinputneurons-1`
 *   `B`  the behaviour neurons — the `numoutputneurons` columns starting at
 *        `numinputneurons` (`complexity_brain.cc:216-217`; emitted only if `P` was *not*
 *        requested, `:305`). It is **not** the same column set as `P`: `P` is every column
 *        from `numinputneurons` to the last one (`:208-209`), so the two coincide only when
 *        the brain has no internal neurons — true of 79 of the 87 recorded fixtures. The 8
 *        that do have internals differ in column set, and 4 of those differ in the recorded
 *        `brain.txt` values too (`brainFunction_52`, `incomplete_brainFunction_62`, `_68`,
 *        `_74`); the remaining 4 return 0 for every `parts` string, so they cannot differ.
 *   `H`  the "head" neuron, column **1**
 *   lowercase letters accumulate into the event filter (`m` mate, `e` eat) and are otherwise
 *   ignored; a trailing digit run sets `num_points` (the number of subset sizes integrated)
 *   and stops the scan.
 *
 * The blocks are emitted in a fixed order — `I`, then `H`, then `P`, then `B` — *not* in the
 * order the letters appear in `parts`, and `matrix_subset_col` keeps that order.
 *
 * PORT-NOTE(l13/single-column-aborts): `H` alone selects one column, and native then reaches
 * `determinant()` on a 0x0 matrix and aborts inside GSL (measured: it kills the probe). The
 * port raises. `A`/`P`/`I`/`B` and their combinations are all exercised against native.
 */

import {
  MAX_NUM_TIMESTEPS_TO_COMPUTE_COMPLEXITY_OVER,
  Matrix,
  calcApproximateFullComplexityWithMatrix,
  matrixSubsetCol,
  setGaussianize,
} from './algorithm';

//===========================================================================
// compile-time options (`complexity_brain.cc:13-56`)
//===========================================================================

/**
 * `FLAG_useGSAMP 1` (the default branch). Widened to `number` so the native `!== 0` test on it
 * stays a real runtime test, exactly as native's preprocessor `#if` would leave it.
 */
const FLAG_USE_GSAMP: number = 1;
/** `FLAG_subtractBias 0`. */
const FLAG_SUBTRACT_BIAS = 0;
/** `IgnoreAgentsThatLivedLessThan_N_Timesteps 0`. */
const IGNORE_AGENTS_THAT_LIVED_LESS_THAN_N_TIMESTEPS = 0;
/** `MaxNumTimeStepsToComputeComplexityOver 500`. */
const MAX_NUM_TIMESTEPS = MAX_NUM_TIMESTEPS_TO_COMPUTE_COMPLEXITY_OVER;

/** The four `#define`s of `complexity_brain.cc:788-791`, named. */
const FILTER_SUM = 0;
const FILTER_MAX = 1;
const FILTER_BOX = 0;
const FILTER_BOX_ZERO = 0;

/**
 * `complexity_brain.cc:789` selects the filter modes with `#define FILTER_SUM 0 / FILTER_MAX 1
 * / FILTER_BOX 0 / FILTER_BOX_ZERO 0`; the port names the selected one.
 */
const FILTER_MODE: 'sum' | 'max' | 'box' | 'boxzero' = FILTER_MAX
  ? 'max'
  : FILTER_SUM
    ? 'sum'
    : FILTER_BOX
      ? 'box'
      : 'boxzero';

//===========================================================================
// file adapters (native's `AbstractFile`)
//===========================================================================

/**
 * Native `AbstractFile` as `readin_brainfunction` uses it: `gets( buf, size )` (`fgets`/`gzgets`
 * semantics — at most `size-1` characters, the newline kept, `null` at end of file) and
 * `seek( offset, SEEK_SET )` on the **decompressed** stream.
 *
 * The lane keeps this as a seam because the sim's brain-function files are produced by lane
 * L12's `BrainFunctionLog` and may be plain or gzipped (`CompressFiles`), and the browser has
 * no `node:zlib`: `nodeFile.ts`'s `readAbstractFileBytes` + a text decoder is the node
 * implementation, and a browser shell supplies its own.
 */
export interface BrainFunctionFile {
  /** Native `AbstractFile::gets( s, size )` — includes a trailing newline; `null` at EOF. */
  gets(maxChars: number): string | null;
  /** Native `AbstractFile::seek( offset, SEEK_SET )` — an absolute offset. */
  seek(offset: number): void;
}

/** Native `opendir`/`readdir` as `get_list_of_*_logfiles` uses it. */
export interface DirectoryLister {
  /** The directory's entries, in the order the platform returns them. */
  readdir(directory: string): string[];
}

/** Native `AbstractFile::open( path, "r" )` over a path the caller knows how to read. */
export type BrainFunctionFileOpener = (abstractPath: string) => BrainFunctionFile;

/**
 * `AbstractFile` over already-decompressed bytes — `fgets`/`gzgets` semantics (at most
 * `size-1` characters, the newline kept, `null` at end of file) and `seek( offset, SEEK_SET )`
 * as an absolute offset into the decompressed stream.
 *
 * The sim binds a reader that produces the bytes (`readAbstractFileBytes` in node, a fetch in a
 * browser); the lane keeps the bytes-to-lines step here so both use one implementation.
 */
export function openBrainFunctionFile(bytes: Uint8Array): BrainFunctionFile {
  let pos = 0;
  return {
    gets(maxChars: number): string | null {
      if (pos >= bytes.length) return null;
      const max = maxChars - 1; // fgets reserves the NUL
      const start = pos;
      let n = 0;
      while (pos < bytes.length && n < max) {
        const ch = bytes[pos]!;
        pos++;
        n++;
        if (ch === 0x0a) break;
      }
      let out = '';
      for (let i = start; i < pos; i++) out += String.fromCharCode(bytes[i]!);
      return out;
    },
    seek(offset: number): void {
      pos = offset;
    },
  };
}

//===========================================================================
// readin_brainfunction
//===========================================================================

/** Native `readin_brainfunction`'s outputs: the matrix and the shape it read. */
export interface BrainActivity {
  activity: Matrix | null;
  agentNumber: number;
  agentBirth: number;
  lifespan: number;
  numNeurons: number;
  numINeurons: number;
  numONeurons: number;
}

/** C `atoi` over the leading integer of a string (`parseInt` already stops at the first junk). */
function atoi(s: string): number {
  const m = /^[ \t\n\r]*([+-]?\d+)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** C `atol` — the same parse, kept separate so the call sites read like native's. */
function atol(s: string): number {
  return atoi(s);
}

/** C `atof`, including `inf`/`nan` and the leading whitespace it skips. */
function atof(s: string): number {
  const t = s.replace(/^[ \t\n\r]+/, '');
  const m = /^[+-]?(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)/i.exec(t);
  if (!m) return 0;
  return Number(m[0]);
}

/**
 * Native `readin_brainfunction( fname, tile, num_timesteps, max_timesteps, ... )`
 * (`complexity_brain.cc:569`).
 *
 * Two version-dependent details: a `version <n>` first line switches `numoneurons` from the
 * hard-coded 7 (version 0) to a field in the params line, and only then does the params line
 * follow. `max_timesteps` keeps the **last** N rows (`FileContents_begin = end - N*numneur`),
 * while `num_timesteps` keeps the first N. Both are ignored when `tile` is set, where the file
 * is instead cycled from the start until the requested row count is reached.
 *
 * The `params` field is `substr(14)`: the "brainFunction " prefix is 14 characters, and the
 * remainder is `agentNum numneu numineu [numoneu] num_synapses birth_time …`.
 */
export function readinBrainfunction(
  file: BrainFunctionFile,
  tile: boolean,
  numTimesteps: number,
  maxTimesteps: number,
): BrainActivity {
  if (tile && maxTimesteps !== 0) throw new Error('readin_brainfunction: tile with max_timesteps (native asserts)');
  if (!(numTimesteps >= 0)) throw new Error('readin_brainfunction: negative num_timesteps (native asserts)');

  const out: BrainActivity = {
    activity: null,
    agentNumber: 0,
    agentBirth: -1,
    lifespan: 0,
    numNeurons: 0,
    numINeurons: 0,
    numONeurons: 0,
  };

  let tline = file.gets(100);
  if (tline === null) tline = '';

  let version: number;
  if (tline.slice(0, 8) !== 'version ') {
    version = 0;
  } else {
    version = atoi(tline.slice(8));

    // read the line after the version line
    const nlpos = tline.indexOf('\n');
    if (nlpos < 0) throw new Error('readin_brainfunction: version line without a newline (native would scribble)');
    file.seek(nlpos + 1);
    tline = file.gets(100) ?? '';
  }

  let params = tline.slice(14);

  let indexSpace = params.indexOf(' ');
  const agentNum = params.slice(0, indexSpace);
  params = params.slice(indexSpace + 1); // remove the agentNum
  out.agentNumber = atoi(agentNum);

  indexSpace = params.indexOf(' ');
  const numneu = params.slice(0, indexSpace);
  params = params.slice(indexSpace + 1); // remove the numneu
  const numneur = atoi(numneu);
  out.numNeurons = numneur;

  indexSpace = params.indexOf(' ');
  const numineu = params.slice(0, indexSpace);
  params = params.slice(indexSpace + 1); // remove the numineu
  const numineur = atoi(numineu);
  out.numINeurons = numineur;

  let numoneur: number;
  if (version === 0) {
    numoneur = 7;
  } else {
    indexSpace = params.indexOf(' ');
    const numoneu = params.slice(0, indexSpace);
    params = params.slice(indexSpace + 1); // remove the numoneu
    numoneur = atoi(numoneu);
  }
  out.numONeurons = numoneur;

  // read (and discard) the number of synapses
  indexSpace = params.indexOf(' ');
  params = params.slice(indexSpace + 1);

  // read the birth time
  indexSpace = params.indexOf(' ');
  const birthTime = params.slice(0, indexSpace);
  params = params.slice(indexSpace + 1);
  out.agentBirth = atol(birthTime);

  const fileContents: string[] = [];
  let nextl: string | null;
  while ((nextl = file.gets(200)) !== null) fileContents.push(nextl);

  const numcols = numneur;

  if (fileContents.length % numcols) {
    // true iff we are dealing with a complete brain-function file
    fileContents.pop(); // get rid of the last line (in complete files, it is `fitness`)
  }

  let numrows = Math.floor(fileContents.length / numcols);
  out.lifespan = numrows; // actual lifespan, not accounting for max_timesteps
  if (numrows === 0) return out;

  if (numTimesteps > 0) {
    if (tile) {
      numrows = numTimesteps;
    } else {
      numrows = Math.min(numrows, numTimesteps);
      numTimesteps = numrows; // if num_timesteps is too big, make it small
    }
  }

  if (maxTimesteps > 0) {
    numrows = Math.min(numrows, maxTimesteps);
    maxTimesteps = numrows;
  }

  if (numcols <= 0 || numrows <= 0) return out;

  const activity = new Matrix(numrows, numcols);

  let tcnt = 0;

  let begin = 0;
  let end: number;
  if (numTimesteps > 0) {
    const numLines = numTimesteps * numneur;
    if (tile && fileContents.length < numLines) {
      // native reserves `num_lines` and then appends from the beginning until it reaches it
      let it = 0;
      while (fileContents.length < numLines) fileContents.push(fileContents[it++]!);
    }
    end = begin + numTimesteps * numneur;
  } else {
    end = fileContents.length;
  }
  if (maxTimesteps > 0 && maxTimesteps < end - begin) begin = end - maxTimesteps * numneur;

  for (let i = begin; i < end; i++) {
    const line = fileContents[i]!;
    const thespace = line.indexOf(' ');
    const tstep1 = atoi(line.slice(0, thespace));
    const tstep2 = atof(line.slice(thespace, line.length));

    activity.set(Math.trunc(tcnt / numcols), tstep1, tstep2);
    tcnt++;
  }

  out.activity = activity;
  return out;
}

/**
 * Native `CalcComplexity_brainfunction( fnameAct, part, events, tile, num_timesteps, … )`
 * (`complexity_brain.cc:110`) — read the file, filter it if `parts` asks for events, then
 * compute.
 */
export function calcComplexityBrainfunction(args: {
  file: BrainFunctionFile;
  part: string;
  events?: AgentEventSource | null;
  tile?: boolean;
  numTimesteps?: number;
}): { complexity: number; agentNumber: number; lifespan: number; numNeurons: number } {
  const tile = args.tile ?? false;
  const numTimesteps = args.numTimesteps ?? 0;

  let complexity: number;

  const read = readinBrainfunction(
    args.file,
    tile,
    numTimesteps,
    tile ? 0 : MAX_NUM_TIMESTEPS,
  );

  // If the brain file was invalid or memory allocation failed, just return 0.0
  if (read.activity === null) {
    return { complexity: 0.0, agentNumber: read.agentNumber, lifespan: read.lifespan, numNeurons: read.numNeurons };
  }

  const activity = read.activity;

  // If the agent lived fewer timesteps than it has neurons, or it has not lived long enough,
  // return Complexity = 0.0.
  if (activity.size2 > activity.size1 || activity.size1 < IGNORE_AGENTS_THAT_LIVED_LESS_THAN_N_TIMESTEPS) {
    return { complexity: 0.0, agentNumber: read.agentNumber, lifespan: read.lifespan, numNeurons: read.numNeurons };
  }

  if (args.events) {
    const sizeFilterEvents = 8;
    const filterEvents: string[] = [];
    for (let i = 0; i < args.part.length; i++) {
      const ch = args.part[i]!;
      if (islower(ch)) {
        filterEvents.push(ch);
        if (filterEvents.length >= sizeFilterEvents) {
          throw new Error('Error: too many filter events specified (CalcComplexity_brainfunction)');
        }
      }
    }

    if (filterEvents.length > 0) {
      filterActivity(
        activity,
        filterEvents.join(''),
        read.agentNumber,
        read.agentBirth,
        read.lifespan,
        args.events,
        read.numINeurons,
      );
    }
  }

  complexity = calcComplexityWithMatrixBrainfunction(activity, args.part, read.numINeurons, read.numONeurons);

  return { complexity, agentNumber: read.agentNumber, lifespan: read.lifespan, numNeurons: read.numNeurons };
}

/** C `islower`. */
function islower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

/** C `isdigit`. */
function isdigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Native `CalcComplexityWithMatrix_brainfunction( activity, part, numinputneurons, numoutputneurons )`
 * (`complexity_brain.cc:191`).
 *
 * `-2` for an input-less brain is native's own sentinel (and the value
 * `analyzeBrain` would hand `SetComplexity`).
 */
export function calcComplexityWithMatrixBrainfunction(
  activity: Matrix,
  part: string,
  numinputneurons: number,
  numoutputneurons: number,
): number {
  if (numinputneurons === 0) return -2;

  setGaussianize(FLAG_USE_GSAMP !== 0);

  let flagAll = 0;
  let flagPro = 0;
  let flagInp = 0;
  let flagBeh = 0;
  let flagHea = 0;

  const startPro = numinputneurons;
  const numPro = activity.size2 - numinputneurons; // size2 is the number of columns == neurons
  const indexPro: number[] = [];
  for (let i = 0; i < numPro; i++) indexPro.push(startPro + i);

  const startInp = 0;
  const numInp = numinputneurons;
  const indexInp: number[] = [];
  for (let i = 0; i < numInp; i++) indexInp.push(startInp + i);

  const startBeh = numinputneurons;
  const numBeh = numoutputneurons;
  const indexBeh: number[] = [];
  for (let i = 0; i < numBeh; i++) indexBeh.push(startBeh + i);

  const indexHea = 1;

  let numPoints = 1;

  for (let j = 0; j < part.length; j++) {
    const ch = part[j]!;

    // lowercase characters indicate event filtering; ignore them here
    if (islower(ch)) continue;

    // trailing digits define num_points used for integrating the area between the curves
    if (isdigit(ch)) {
      numPoints = atoi(part.slice(j));
      break;
    }

    switch (ch) {
      case 'A':
        flagAll = 1;
        break;
      case 'P':
        flagPro = 1;
        break;
      case 'I':
        flagInp = 1;
        break;
      case 'B':
        flagBeh = 1;
        break;
      case 'H':
        flagHea = 1;
        break;
      default:
        throw new Error(`CalcComplexityWithMatrix_brainfunction: Invalid complexity type (${ch})`);
    }
  }

  if (flagAll === 1) return calcApproximateFullComplexityWithMatrix(activity, numPoints);

  // Accumulate the indexes of neurons related to the requested complexity type.
  // The blocks are emitted in native's fixed order, not in `part` order.
  const columns: number[] = [];
  let numColumns = 0;

  if (flagInp === 1) {
    let j = 0;
    for (let i = numColumns; i < numInp; i++) columns[i] = indexInp[j++]!;
    numColumns += numInp;
  }

  if (flagHea === 1 && flagInp === 0) {
    columns[0] = indexHea;
    numColumns = 1;
  }

  if (flagPro === 1) {
    let j = 0;
    for (let i = numColumns; i < numPro + numColumns; i++) columns[i] = indexPro[j++]!;
    numColumns += numPro;
  }

  if (flagBeh === 1 && flagPro === 0) {
    let j = 0;
    for (let i = numColumns; i < numBeh + numColumns; i++) columns[i] = indexBeh[j++]!;
    numColumns += numBeh;
  }

  const subset = matrixSubsetCol(activity, columns, numColumns);

  return calcApproximateFullComplexityWithMatrix(subset, numPoints);
}

//===========================================================================
// event filtering
//===========================================================================

/** The shape `FilterActivity` needs from lane L11's `Events`. */
export interface AgentEventSource {
  getAgentEvent(step: number, agentNumber: number): { eat: boolean; mate: boolean };
}

/**
 * Native `FilterActivity( activity, filter_events, agent_number, agent_birth, lifespan, events,
 * numinputneurons )` (`complexity_brain.cc:785`).
 *
 * The active filter mode is `FILTER_MAX` (`complexity_brain.cc:789`): around every step on
 * which the agent ate or mated, a triangular weight window (`m19.19e19.19m1.0e1.0`, the last
 * uncommented table in the file) is OR-merged into a per-step filter, and each neuron's
 * activation is then pulled toward 0.5 by the filter: `a*f + 0.5*(1-f)`.
 *
 * The window's start step is `agent_birth + lifespan - duration + 1` where `duration` is the
 * number of rows the reader kept, so a `MaxNumTimeStepsToComputeComplexityOver` truncation
 * analyzes the *end* of the agent's life.
 */
export function filterActivity(
  activity: Matrix,
  filterEvents: string,
  agentNumber: number,
  agentBirth: number,
  lifespan: number,
  events: AgentEventSource,
  numinputneurons: number,
): void {
  // m19.19e19.19m1.0e1.0 (aka m19e19m1.0e1.0)
  const mateFilterPre = 19;
  const mateFilterPost = 19;
  const eatFilterPre = 19;
  const eatFilterPost = 19;
  const mateFilter = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0,
    0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05,
  ];
  const eatFilter = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0,
    0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05,
  ];

  const duration = activity.size1; // may be less than lifespan due to MaxNumTimeSteps…
  const agentDeath = agentBirth + lifespan; // "seems like this should be -1, but this agrees with BirthsDeaths.log"
  const agentStart = agentDeath - duration + 1;
  const mateFiltering = filterEvents.indexOf('m') >= 0;
  const eatFiltering = filterEvents.indexOf('e') >= 0;

  const filter = new Float64Array(duration); // 0.0 => mean, 1.0 => original signal

  for (let step = agentStart; step <= agentDeath; step++) {
    const agentEvent = events.getAgentEvent(step, agentNumber);
    const activityStep = step - agentStart;

    if (mateFiltering && agentEvent.mate) {
      const left = activityStep - mateFilterPre;
      const right = activityStep + mateFilterPost;
      const lo = left < 0 ? 0 : left;
      const hi = right >= duration ? duration - 1 : right;
      const offset = lo - left;
      for (let i = lo; i <= hi; i++) {
        if (FILTER_MODE === 'max') filter[i] = Math.max(filter[i]!, mateFilter[i - lo + offset]!);
        else if (FILTER_MODE === 'sum') filter[i] = Math.min(1.0, filter[i]! + mateFilter[i - lo + offset]!);
        else filter[i] = 1.0;
      }
    }
    if (eatFiltering && agentEvent.eat) {
      const left = activityStep - eatFilterPre;
      const right = activityStep + eatFilterPost;
      const lo = left < 0 ? 0 : left;
      const hi = right >= duration ? duration - 1 : right;
      const offset = lo - left;
      for (let i = lo; i <= hi; i++) {
        if (FILTER_MODE === 'max') filter[i] = Math.max(filter[i]!, eatFilter[i - lo + offset]!);
        else if (FILTER_MODE === 'sum') filter[i] = Math.min(1.0, filter[i]! + eatFilter[i - lo + offset]!);
        else filter[i] = 1.0;
      }
    }
  }

  for (let j = 0; j < activity.size2; j++) {
    for (let i = 0; i < activity.size1; i++) {
      if (FILTER_MODE === 'boxzero') {
        if (filter[i] === 0.0) activity.set(i, j, 0.0);
      } else {
        activity.set(i, j, activity.get(i, j) * filter[i]! + 0.5 * (1.0 - filter[i]!));
      }
    }
  }

  void numinputneurons; // native passes it only for its debug printf
  void FLAG_SUBTRACT_BIAS;
}

//===========================================================================
// directory listings
//===========================================================================

/**
 * Native `get_list_of_brainfunction_logfiles( directory_name )` (`complexity_brain.cc:337`).
 *
 * Native appends `directory_name + entry->d_name` with no separator (the callers pass a
 * trailing slash) and filters on the substring `_brainFunction_`, excluding `.txt.mat`. It does
 * **not** sort: the order is `readdir`'s. The port keeps whatever order the seam returns —
 * PORT-NOTE(l13/logfile-listing-order).
 */
export function getListOfBrainfunctionLogfiles(directory: string, fs: DirectoryLister): string[] {
  const functionString = '_brainFunction_';
  const z: string[] = [];
  for (const name of fs.readdir(directory)) {
    if (name.indexOf(functionString) >= 0 && name.indexOf('.txt.mat') < 0) z.push(directory + name);
  }
  return z;
}

/** Native `get_list_of_brainanatomy_logfiles( directory_name )` (`complexity_brain.cc:376`). */
export function getListOfBrainanatomyLogfiles(directory: string, fs: DirectoryLister): string[] {
  const functionString = '_brainAnatomy_';
  const z: string[] = [];
  for (const name of fs.readdir(directory)) {
    if (name.indexOf(functionString) >= 0 && name.indexOf('.txt.mat') < 0) z.push(directory + name);
  }
  return z;
}

//===========================================================================
// readin_brainanatomy
//===========================================================================

/**
 * Native `readin_brainanatomy( fname )` (`complexity_brain.cc:425`) — the connection matrix out
 * of a `run/brain/anatomy/**` file, by the same scrolling-string parse the MATLAB original
 * used. Only lane L17's `tools/CalcComplexity` reads it today; ported for completeness (the
 * probe does not exercise it, and no recorded artifact does either).
 */
export function readinBrainanatomy(file: BrainFunctionFile): Matrix {
  const tline = file.gets(200) ?? '';

  // `str_tline.erase(0,6)` -- "brain " -- then the filenum, then `fitness=`, then `numneurons=`
  let strTline = tline.slice(6);
  strTline = strTline.slice(strTline.indexOf(' ') + 1);
  strTline = strTline.slice(strTline.indexOf(' ') + 1);
  strTline = strTline.slice(strTline.indexOf('=') + 1);
  const numneu = atoi(strTline.slice(0, strTline.indexOf(' ')));

  const cij = new Matrix(numneu, numneu);

  for (let i = 0; i < numneu; i++) {
    const cijline = file.gets(5000) ?? '';
    for (let j = 0; j < numneu; j++) {
      // Native: `str_cijline.substr( j*8, (j+1)*8 )` -- the length is a native quirk (it takes
      // up to (j+1)*8 characters, not 8); `atof` stops at the first non-number, so it reads the
      // j-th 8-character field either way.
      cij.set(i, j, atof(cijline.slice(j * 8, (j + 1) * 8)));
    }
  }

  return cij;
}

//===========================================================================
// the two-argument entry point
//===========================================================================

/**
 * Native `CalcComplexity_brainfunction_result * CalcComplexity_brainfunction( parms, nparms,
 * callback )` (`complexity_brain.cc:71`) — the OpenMP batch form.
 *
 * PORT-NOTE(l13/batch-is-sequential): `#pragma omp parallel for` computes one independent
 * complexity per parameter set; nothing is shared between iterations except the RNG, which each
 * iteration re-creates from `DEFAULT_SEED`. The port runs them in order, which is the
 * sequential equivalent of the same work (and the only order a browser has).
 */
export function calcComplexityBrainfunctionBatch<T>(
  parms: { file: BrainFunctionFile; part: string; events?: AgentEventSource | null; tile?: boolean; numTimesteps?: number }[],
  callback?: {
    begin?(nparms: number): void;
    parmsResult?(result: T, parmsIndex: number): void;
    end?(results: T[]): void;
  },
): T[] {
  if (callback?.begin) callback.begin(parms.length);
  const results: T[] = [];
  for (let i = 0; i < parms.length; i++) {
    const r = calcComplexityBrainfunction(parms[i]!) as unknown as T;
    results.push(r);
    if (callback?.parmsResult) callback.parmsResult(r, i);
  }
  if (callback?.end) callback.end(results);
  return results;
}
