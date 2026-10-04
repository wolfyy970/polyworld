/**
 * Lane L14 — `FarmMonitor` (`Monitor.h:203-230`, `Monitor.cc:324-385`): the monitor that,
 * *only when the process is running inside a farm* (`PWFARM_STATUS` present in the
 * environment), reports a handful of run-time property values out to the farm controller by
 * shelling out on every `Frequency` steps.
 *
 * It is dead code for the recorded scenarios (`PWFARM_STATUS` is unset, so
 * `MonitorManager` never constructs it — see `monitorManager.ts`), but the lane ports it
 * because the monitor document can switch it on and because a silent non-port would be a
 * behaviour difference waiting to happen.
 *
 * PORT-NOTE(monitor/farm-is-present-not-truthy): native `isFarmEnv()` is
 * `getenv( "PWFARM_STATUS" ) != NULL` — an env var set to the **empty string** counts as
 * "in a farm" (`getenv` returns a non-null pointer). The port therefore asks the injected
 * environment for "is this name *present*", not for a truthy value.
 *
 * PORT-NOTE(monitor/farm-command-string): the native builds the command with a
 * `stringstream` and runs it through `system()`. The exact bytes matter to whoever consumes
 * them (the farm parses the bracketed `title=value` list), so the port reproduces the
 * concatenation literally — including the `bash -c '...'` wrapper, the escaped quotes around
 * the bracketed payload, the single space between entries and no trailing space. The command
 * is handed to an injected `FarmRunner` (a browser has no `system()`); a non-zero result is
 * reported on stderr exactly as native does (`Failed executing PWFARM_STATUS`).
 *
 * PORT-NOTE(monitor/farm-metadata-provider): which properties have values to report is
 * decided by `proplib::CppProperties::getMetadata()`, i.e. the *run-time code generation*
 * results (lane W1h — `docs/specs/cppprops.md`). The monitor's own job is the name match
 * (`it->name == metadata[i].name`, first match wins) and skipping unmatched properties; the
 * metadata source is injected.
 */

import { Monitor, MonitorType } from './monitor';
import type { MonitorSim } from './simSurface';

/** Native `proplib::CppProperties::PropertyMetadata` (lane W1h owns the source). */
export interface CppPropertyMetadata {
  readonly name: string;
  /** Native `toString()` — INT `%d`, FLOAT `%g`, BOOL `True`/`False`. */
  toString(): string;
}

/** Native `proplib::CppProperties::getMetadata( &metadata, &count )`. */
export interface CppPropertyMetadataProvider {
  getMetadata(): readonly CppPropertyMetadata[];
}

/** Native `int system( const char * )`. */
export interface FarmRunner {
  run(command: string): number;
}

/**
 * Native `getenv( name ) != NULL`.
 */
export interface FarmEnvironment {
  isSet(name: string): boolean;
}

/** The process environment (native `getenv`); `process` may be absent in a browser. */
export const processEnvironment: FarmEnvironment = {
  isSet(name: string): boolean {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    return env !== undefined && env[name] !== undefined;
  },
};

/** Native `FarmMonitor::Property` (public in native: `name`, `title`, `metadata`). */
export interface FarmProperty {
  readonly name: string;
  readonly title: string;
  /** Native `PropertyMetadata *metadata` — null when the name has no run-time property. */
  metadata: CppPropertyMetadata | null;
}

/** Native `FarmMonitor::Property( name, title )` — `metadata` starts null. */
export function farmProperty(name: string, title: string): FarmProperty {
  return { name, title, metadata: null };
}

export class FarmMonitor extends Monitor {
  /** Native `static bool isFarmEnv()`. */
  static isFarmEnv(env: FarmEnvironment = processEnvironment): boolean {
    return env.isSet('PWFARM_STATUS');
  }

  private readonly frequency: number;
  private readonly properties: readonly FarmProperty[];
  private readonly runner: FarmRunner;

  constructor(
    sim: MonitorSim,
    frequency: number,
    properties: readonly FarmProperty[],
    metadataProvider: CppPropertyMetadataProvider,
    runner: FarmRunner,
  ) {
    super(MonitorType.FARM, sim, 'farm', 'Farm', 'Farm');

    this.frequency = frequency;
    // Native copies the vector; the port keeps the same objects so a caller can read back the
    // resolved metadata (native's copy is a value copy of `Property`, whose `metadata` pointer
    // is shared either way).
    this.properties = [...properties];
    this.runner = runner;

    const metadata = metadataProvider.getMetadata();
    for (const property of this.properties) {
      for (const entry of metadata) {
        if (property.name === entry.name) {
          property.metadata = entry;
          break;
        }
      }
    }
  }

  getProperties(): readonly FarmProperty[] {
    return this.properties;
  }

  step(timestep: number): void {
    if (timestep !== 1 && timestep % this.frequency !== 0) return;

    let command = "bash -c 'PWFARM_STATUS Polyworld \"[";
    let first = true;

    for (const property of this.properties) {
      if (property.metadata !== null) {
        if (!first) command += ' ';
        else first = false;

        command += `${property.title}=${property.metadata.toString()}`;
      }
    }

    command += "]\"'";

    const rc = this.runner.run(command);
    if (rc) console.error('Failed executing PWFARM_STATUS');
  }
}
