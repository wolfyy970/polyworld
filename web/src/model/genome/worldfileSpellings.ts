/**
 * Lane L5 (genome) — the worldfile *spellings* the genome schema branches on.
 *
 * Native turns each of these strings into an enum of the owning lane (`Brain::Configuration
 * ::Architecture`, `agent::BodyGreenChannel`, `agent::YawEncoding`,
 * `Brain::Configuration::NeuronModel`) and the genome schema compares the enum. The port
 * carries the spelling itself — the enum (and its numeric values) belongs to L6/L8, and
 * re-declaring it in the genome lane is exactly the duplicate-definition mistake PORT_PLAN
 * warns about.
 *
 * PORT-NOTE(genome/worldfile-spellings): the mapping word -> value is transcribed from
 * `agent/agent.cc` (`BodyGreenChannel`, `YawEncoding`), `brain/Brain.cc` (`NeuronModel`) and
 * `Brain::Configuration::Architecture`; an unknown word is an error, as native's
 * `assert(false)` is.
 */

import type {
  Architecture,
  BodyGreenChannelSpelling,
  NeuronModelSpelling,
  YawEncodingSpelling,
} from './genomeSchema';

/** Native `Brain::Configuration::Architecture` (`BrainArchitecture`). */
export function readArchitecture(value: string): Architecture {
  if (value === 'Groups' || value === 'Sheets') return value;
  throw new Error(`BrainArchitecture: unknown value '${value}'`);
}

/** Native `Brain::Configuration::NeuronModel` — the worldfile spells it F/T/S. */
export function readNeuronModel(value: string): NeuronModelSpelling {
  if (value === 'F' || value === 'T' || value === 'S') return value;
  throw new Error(`NeuronModel: unknown value '${value}'`);
}

/**
 * Native `agent::BodyGreenChannel`: `"I"` -> BGC_ID, `"L"` -> BGC_LIGHT, `"E"` -> BGC_EAT,
 * `"F"` -> BGC_FOOD, anything else -> BGC_CONST (the value is then parsed as a float;
 * the genome lane only needs to know it is *not* the ID channel).
 */
export function readBodyGreenChannel(value: string): BodyGreenChannelSpelling {
  if (value === 'I' || value === 'L' || value === 'E' || value === 'F') return value;
  return 'const';
}

/** Native `agent::YawEncoding`: `"Oppose"` -> YE_OPPOSE, `"Squash"` -> YE_SQUASH. */
export function readYawEncoding(value: string): YawEncodingSpelling {
  if (value === 'Oppose') return 'Oppose';
  if (value === 'Squash') return 'Squash';
  throw new Error(`YawEncoding: unknown value '${value}'`);
}
