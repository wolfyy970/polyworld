/**
 * Lane W1b — proplib's failure surface.
 *
 * Native proplib never recovers and never returns an error: every failure path is
 * `cerr << ... << endl; exit(1)` (see `Parser::err`, `DocumentLocation::err`,
 * `Tokenizer::parseString`, `Node::err`). A browser tab cannot exit the process, so the
 * port throws. Two message shapes are preserved verbatim, because they are what the
 * native prints and therefore what a lane recognizes in a diff/log:
 *
 *   parse & tokenizer errors   `<source>:<lineno>: <message>`
 *                              (`Parser::err`, `Tokenizer::parseString`, …)
 *   document errors            `<path>:<lineno>: ERROR! <message>`
 *                              (`DocumentLocation::err`; `Node::err` forwards to it)
 *
 * PORT-NOTE(proplib/throw-not-exit): native `err()`/`exit(1)` becomes `throw
 * ProplibError`. Callers that want "this run is over" semantics must simply not catch it.
 *
 * PORT-NOTE(proplib/source-encoding): proplib reads its documents as a byte stream
 * (`ifstream`) and writes them as bytes; identifiers and string literals are compared and
 * emitted byte for byte. The port reads and writes latin-1, so every byte round-trips
 * unchanged through `parse → write` and a byte-exact golden still compares equal.
 */

/** Any fatal proplib condition (native: `exit(1)`). */
export class ProplibError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProplibError';
  }
}

/** `throw new ProplibError(...)`, usable as an expression. */
export function proplibError(message: string): never {
  throw new ProplibError(message);
}
