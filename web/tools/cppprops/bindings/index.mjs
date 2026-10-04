/**
 * Default cppprops binding registry (W1h).
 *
 * A binding serves a `dyn` body the extractor classified `portable: false`,
 * keyed by the head of the first unportable symbol (see lib/cppprops.mjs ->
 * bindingKey()).  Only symbols whose behaviour lives in the native `proplib`
 * tree belong here; anything that calls further into the model is recorded as
 * a Gaps row in docs/specs/cppprops.md and must be bound by the owning lane.
 */

import foodPatchTokenRing from "./foodpatch_tokenring.mjs";
import gene from "./gene.mjs";

const bindings = {
  ...foodPatchTokenRing.bindings,
  ...gene.bindings,
};

export { bindings };
export default bindings;
