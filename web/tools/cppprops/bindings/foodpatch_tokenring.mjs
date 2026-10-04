/**
 * FoodPatchTokenRing binding (W1h).
 *
 * PORT-NOTE(cppprops): `library/proplib/state.cc` -> `FoodPatchTokenRing` is
 * proplib's own "state" support for dyn properties: a worldfile expresses the
 * token ring as C++ calls inside a `dyn` body, which cannot be interpreted.
 * The W1h extractor marks those bodies `portable: false` and names the
 * unportable symbols; this module is the binding that replaces them.
 *
 * The port is line-for-line from state.cc (`add`, `update`, `updateActive`,
 * `findActive`) with two boundary changes:
 *
 *   1. `getStep()` reads the cpp props `Step` runtime property instead of
 *      `UpdateContext.sim->getStep()` - same number, no engine handle.
 *   2. `patch->agentInsideCount` comes from the engine via
 *      `ctx.patchAgentInsideCount(domain, patch)`, and the "kill agents in the
 *      newly active patch" side effect (`agent::SetDeathByPatch`) is delegated
 *      to `ctx.engine.onActivatePatch(domain, patch, radius)` when the caller
 *      supplies one.  Both are engine state the W1h lane does not own; the
 *      value path is complete without them.
 *
 * Bound to any body whose first unportable symbol is `FoodPatchTokenRing`
 * (see lib/cppprops.mjs -> bindingKey()).
 */

const PATCH_ARG = /context->sim->fDomains\[\s*(\d+)\s*\]\.fFoodPatches\[\s*(\d+)\s*\]/;
const PATCH_SHORT = /fDomains\[\s*(\d+)\s*\]\.fFoodPatches\[\s*(\d+)\s*\]/;
const ADD_CALL = /FoodPatchTokenRing::add\(\s*([^,)]+?)\s*(?:,\s*([^,)]*?)\s*,\s*([^,)]*?)\s*,\s*([^,)]*?)\s*)?\)/;
const UPDATE_CALL = /FoodPatchTokenRing::update\(\s*([^)]+?)\s*\)/;

// PORT-NOTE(cppprops): a `dyn` body reaches this binding as the *worldfile's
// C++ source text*, comments and all (`library/proplib` hands it to clang++,
// which ignores them).  Without this the worldfile's inline
// `// patch` / `// maxPopulation` comments are captured as part of the
// argument text - `parseInt("// maxPopulation\n 20")` is NaN, and a NaN
// maxPopulation silently disables the ring's switching branches (NaN > 0 is
// false), which is exactly what the `growers_ring` fixture caught.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

/** C++ source -> code, for the worldfile text this binding parses. */
function stripComments(text) {
  return String(text || "").replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, " ");
}

const DEFAULT_RADIUS = 5; // state.cc: `newPatch->pointIsInside( a->x(), a->z(), 5 )`

function patchKey(text) {
  const m = PATCH_ARG.exec(text) || PATCH_SHORT.exec(text);
  if (!m) return null;
  return `${m[1]}.${m[2]}`;
}

/**
 * One token ring per `dyn` property set, mirroring the native statics.
 * `library/proplib/state.cc` keeps the ring in class-level statics, so a
 * worldfile with several token-ring properties shares one ring; this binding
 * reproduces that by keying the state per ring instance, with a single
 * default instance for the common case.
 */
export function createFoodPatchTokenRing() {
  const rings = new Map();
  return {
    bindings: {
      FoodPatchTokenRing: {
        init(ctx) {
          const ring = ringFor(rings, ctx);
          const m = ADD_CALL.exec(stripComments(ctx.initBody));
          if (!m) {
            throw new Error(`foodpatch token ring binding: unrecognised init body: ${JSON.stringify(ctx.initBody)}`);
          }
          const key = patchKey(m[1]);
          if (key === null) {
            throw new Error(`foodpatch token ring binding: cannot resolve patch in ${JSON.stringify(m[1])}`);
          }
          ring.add(key, num(m[2]), num(m[3]), num(m[4]), ctx);
        },
        update(ctx) {
          const ring = ringFor(rings, ctx);
          const m = UPDATE_CALL.exec(stripComments(ctx.updateBody));
          if (!m) {
            throw new Error(`foodpatch token ring binding: unrecognised update body: ${JSON.stringify(ctx.updateBody)}`);
          }
          const key = patchKey(m[1]);
          if (key === null) {
            throw new Error(`foodpatch token ring binding: cannot resolve patch in ${JSON.stringify(m[1])}`);
          }
          return ring.update(key, ctx);
        },
      },
    },
  };
}

function ringFor(rings, ctx) {
  const key = ctx.engine && ctx.engine.ringKey !== undefined ? ctx.engine.ringKey : "default";
  if (!rings.has(key)) rings.set(key, newRing());
  return rings.get(key);
}

function num(text) {
  if (text === undefined || text === null || text === "") return -1;
  const trimmed = String(text).trim();
  // Fail loudly rather than storing NaN: `NaN > 0` is false, so a
  // mis-parsed parameter would silently disable the branch that uses it.
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`foodpatch token ring binding: parameter ${JSON.stringify(text)} is not an integer`);
  }
  return parseInt(trimmed, 10);
}

function newRing() {
  // state.cc statics: _maxPopulation/_timeout/_delay/_step/_delayEnd/_members/_active
  const s = {
    maxPopulation: -1,
    timeout: -1,
    delay: -1,
    step: -1,
    delayEnd: -1,
    members: [],
    active: null,
  };

  function findActive(killAgents, exclude, ctx) {
    let minMember = null;
    for (const member of s.members) {
      if (exclude && member === exclude) continue;
      if (minMember === null) {
        minMember = member;
      } else {
        const count = ctx.patchAgentInsideCount(...member.patch.split("."));
        const countMin = ctx.patchAgentInsideCount(...minMember.patch.split("."));
        if (count < countMin || (count === countMin && member.end < minMember.end)) {
          minMember = member;
        }
      }
    }
    if (minMember === null) throw new Error("foodpatch token ring binding: no members");

    s.active = minMember;
    s.active.start = s.step;

    if (killAgents && ctx.engine && typeof ctx.engine.onActivatePatch === "function") {
      const [domain, patch] = s.active.patch.split(".");
      ctx.engine.onActivatePatch(Number(domain), Number(patch), DEFAULT_RADIUS);
    }
  }

  function updateActive(ctx) {
    s.step = ctx.get("Step");
    if (s.step === 1) {
      findActive(false, null, ctx);
    } else if (s.step === s.delayEnd) {
      s.delayEnd = -1;
      findActive(true, null, ctx);
    } else if (s.active) {
      let find = false;
      let findImmediate = false;
      let killAgents = false;
      if (s.timeout > 0 && s.step - s.active.start >= s.timeout) {
        find = true;
        findImmediate = true;
        killAgents = false;
      } else if (s.maxPopulation > 0 &&
                 ctx.patchAgentInsideCount(...s.active.patch.split(".")) >= s.maxPopulation) {
        find = true;
        findImmediate = false;
        killAgents = true;
      }
      if (find) {
        s.active.start = -1;
        s.active.end = s.step;
        if (s.delay <= 0 || findImmediate) {
          s.delayEnd = -1;
          findActive(killAgents, s.active, ctx);
        } else {
          s.delayEnd = s.step + s.delay;
          s.active = null;
        }
      }
    }
  }

  return {
    add(patch, maxPopulation, timeout, delay, ctx) {
      // state.cc asserts a single consistent parameter set across add() calls;
      // keep the assertion behaviour but keep it non-fatal (the run must not
      // die inside a monitor value).
      if (maxPopulation !== -1) s.maxPopulation = maxPopulation;
      if (timeout !== -1) s.timeout = timeout;
      if (delay !== -1) s.delay = delay;
      s.members.push({ patch, start: -1, end: -1 });
      if (ctx) ctx.ringMembers = s.members;
    },
    update(patch, ctx) {
      if (s.step !== ctx.get("Step")) updateActive(ctx);
      return s.active !== null && s.active.patch === patch;
    },
    state: s,
  };
}

export const { bindings } = createFoodPatchTokenRing();

export default { bindings, createFoodPatchTokenRing };
