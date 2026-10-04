/**
 * `bindings/index.mjs` — the W1h binding registry, keyed by `lib/cppprops.mjs`
 * `bindingKey()` (the head of the first unportable `X::`-qualified symbol).
 */

import type { CppPropsBindingEntry } from '../lib/cppprops.mjs';

export declare const bindings: Record<string, CppPropsBindingEntry>;
export default bindings;
