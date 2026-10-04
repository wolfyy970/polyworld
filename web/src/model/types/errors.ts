/**
 * Lane W1a — error surface shared by the frozen types layer.
 *
 * Native proplib never recovers from a bad read: `DocumentLocation::err()` /
 * `Property::err()` print to stderr and call `exit(1)`. A browser tab cannot exit the
 * process, so the port throws instead. The messages are kept verbatim where they were
 * taken from the C++ so that a lane that hits one recognizes it.
 *
 * PORT-NOTE(types/config-error-is-a-throw): native `err()` ends the run (`exit(1)`); the
 * port throws `ConfigError`. Native wording is preserved; a lane that wants "this run is
 * over" semantics must simply not catch it.
 */

/** Which property/document a failure belongs to, e.g. `Run/worldfile.wf:MaxSteps`. */
export class ConfigError extends Error {
  /** Document/property path the failure belongs to (empty when unknown). */
  readonly where: string;

  constructor(where: string, message: string) {
    super(where.length > 0 ? `${where}: ERROR! ${message}` : `ERROR! ${message}`);
    this.name = 'ConfigError';
    this.where = where;
  }
}

/** `throw new ConfigError(...)`, as an expression (mirrors native `err(msg)`, which is `[[noreturn]]` in effect). */
export function configError(where: string, message: string): never {
  throw new ConfigError(where, message);
}
