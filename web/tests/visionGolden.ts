/**
 * Lane W1j/L16 — test-side helpers for reading the recorded vision goldens.
 *
 * Two things the lane's acceptance test needs and the model does not (yet) ship:
 *
 * 1. `%g` formatting of a `double`, with clang/glibc's default precision of 6 significant
 *    digits. `run/brain/function/brainFunction_*.txt.gz` is written by
 *    `BaseNeuronModel::writeFunctional` as `file->printf("%d %g\n", i, activation[i])`
 *    (`BaseNeuronModel.h:242-248`) — it is *not* a datalib file, and
 *    `src/model/datalib/printf.ts` deliberately refuses `%g` because no datalib column uses
 *    it (PORT-NOTE `w1c/printf-float`). The shipping `%g` therefore belongs to whichever lane
 *    writes the functional logs (L7 brain-recording / L12 logs); the vision lane carries this
 *    test-side formatter so its acceptance numbers can be quoted in the golden's own units.
 *    It is built on the port's exact decimal machinery (`formatFixed`, round-half-to-even on
 *    the exact binary value — the glibc rule) rather than `toFixed`/`toPrecision`, which round
 *    differently on ties.
 *
 * 2. A parser for the recorded functional log, plus the golden fingerprint the lane must
 *    reproduce (`docs/specs/vision-spec.md` §11.4).
 *
 * Nothing here writes to `oracle/**`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { formatFixed } from '../src/model/datalib/printf';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
export const oracleRoot = process.env.POLYWORLD_ORACLE_ROOT ?? path.join(repoRoot, 'oracle');

/** Strip the trailing zeros (and a bare `.`) that `%g` removes. */
function stripTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  let out = text.replace(/0+$/, '');
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/**
 * C `printf("%g", value)` with the default (or given) precision.
 *
 * glibc's rule: let `P` be the precision (6) and `X` the decimal exponent of the rounded
 * value; use `%f` with precision `P-1-X` when `-4 <= X < P`, otherwise `%e` with precision
 * `P-1`; then remove trailing zeros and a trailing decimal point.
 */
export function formatG(value: number, precision = 6): string {
  if (value === 0) return '0';
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  // The decimal exponent the *rounded* value would take (round first: 9.999999e-1 prints `1`).
  const exponent = Math.floor(Math.log10(magnitude));
  const useFixed = exponent >= -4 && exponent < precision;
  if (useFixed) {
    const body = formatFixed(magnitude, Math.max(0, precision - 1 - exponent));
    return (negative ? '-' : '') + stripTrailingZeros(body);
  }
  // The `%e` branch: not exercised by any recorded vision value (asserted in the test); it is
  // implemented so a future value cannot silently print something else.
  const decimals = precision - 1;
  const scaled = magnitude / 10 ** exponent;
  const mantissa = formatFixed(scaled, decimals);
  return `${negative ? '-' : ''}${stripTrailingZeros(mantissa)}e${exponent >= 0 ? '+' : '-'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/** One recorded step of a functional log: `numNeurons` values, decoded from `%g` text. */
export interface GoldenFunctionalStep {
  /** 0-based step index in the file. */
  readonly step: number;
  /** Raw printed text, exactly as the golden has it (this is what L16 must reproduce). */
  readonly printed: readonly string[];
  /** The same values parsed back to doubles (`%g` is 6 significant digits, i.e. lossy). */
  readonly values: readonly number[];
}

export interface GoldenFunctionalLog {
  readonly file: string;
  readonly header: string;
  readonly agentId: number;
  readonly numNeurons: number;
  readonly numInputNeurons: number;
  readonly numOutputNeurons: number;
  /** `stepBorn` from the header — the step whose block is `steps[0]`. */
  readonly stepBorn: number;
  /** Sensor index ranges, e.g. `2-10 11-19 20-28` — the tail of the header. */
  readonly sensorRanges: readonly string[];
  readonly steps: readonly GoldenFunctionalStep[];
}

/**
 * Where a scenario's functional logs live (`oracle/<scenario>/run/brain/function/`).
 *
 * A run that ends by exhausting `MaxSteps` leaves the still-open brains as
 * `incomplete_brainFunction_<agent>.txt.gz` and finalizes nothing (that is what `Logs.cc:781-817`
 * does at agent death/at the end of an epoch), so both spellings are accepted — the line format
 * inside is the same.
 */
export function functionalLogPath(scenario: string, agentId: number): string | null {
  const dir = path.join(oracleRoot, scenario, 'run', 'brain', 'function');
  for (const name of [`brainFunction_${agentId}.txt.gz`, `incomplete_brainFunction_${agentId}.txt.gz`]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the run recorded a functional log for this agent (not every agent gets one). */
export function hasFunctionalLog(scenario: string, agentId: number): boolean {
  return functionalLogPath(scenario, agentId) !== null;
}

/**
 * Read `oracle/<scenario>/run/brain/function/{incomplete_,}brainFunction_<agent>.txt.gz`.
 *
 * Header line (`NervousSystem.cc:147-157`): `version 1`, then
 * `brainFunction <agent> <numNeurons> <numInputNeurons> <numOutputNeurons> <numSynapses> <stepBorn> <sensor ranges…>`;
 * every following line is `<nerveIndex> <%g value>`, `numNeurons` lines per step. The file ends
 * with a non-value line (`end fitness = …`), which the value filter drops.
 *
 * `stepBorn` matters: a log written from birth onward starts at the agent's birth step, so block
 * `i` of an agent born at step `b` is step `b + i + 1` (the oracle's own step numbering).
 */
export function readFunctionalLog(scenario: string, agentId: number): GoldenFunctionalLog {
  const file = functionalLogPath(scenario, agentId);
  if (!file) throw new Error(`no functional log for ${scenario} agent ${agentId}`);
  const text = gunzipSync(readFileSync(file)).toString('latin1');
  const lines = text.split('\n').filter((line) => /^\d+ /.test(line));
  const allLines = text.split('\n').filter((line) => line.trim().length > 0);
  const header = allLines[1]!; // line 0 is `version 1`
  const headerParts = header.split(' ');
  const numNeurons = Number(headerParts[2]);
  const steps: GoldenFunctionalStep[] = [];
  if (lines.length % numNeurons !== 0) {
    throw new Error(`brainFunction_${agentId}: ${lines.length} values is not a whole number of ${numNeurons}-neuron steps`);
  }
  for (let i = 0; i + numNeurons <= lines.length; i += numNeurons) {
    const printed: string[] = [];
    const values: number[] = [];
    for (let k = 0; k < numNeurons; k++) {
      const line = lines[i + k]!;
      const space = line.indexOf(' ');
      printed.push(line.slice(space + 1));
      values.push(Number(line.slice(space + 1)));
    }
    steps.push({ step: steps.length, printed, values });
  }
  return {
    file,
    header,
    agentId,
    numNeurons,
    numInputNeurons: Number(headerParts[3]),
    numOutputNeurons: Number(headerParts[4]),
    stepBorn: Number(headerParts[6]),
    sensorRanges: headerParts.slice(7),
    steps,
  };
}

/** The nerve index ranges of the three retina channels, from the anatomy/function header. */
export function retinaRanges(log: GoldenFunctionalLog): { red: [number, number]; green: [number, number]; blue: [number, number] } {
  const parse = (token: string): [number, number] => {
    const [a, b] = token.split('-');
    return [Number(a), Number(b)];
  };
  const names = log.sensorRanges.slice(-3);
  return { red: parse(names[0]!), green: parse(names[1]!), blue: parse(names[2]!) };
}
