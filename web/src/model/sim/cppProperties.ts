/**
 * Lane L11 (sim) — `proplib::CppProperties::UpdateContext` (`cppprops.h:32`) as this lane serves
 * it: the live runtime property values a `dyn` set reads, the two engine callbacks an unportable
 * body reaches through, and the write-back of every `dyn` value into the model object its cpp
 * symbol names.
 *
 * Native side (all verified against the sources, not inferred):
 *
 *  * `CppProperties::UpdateContext` is `{ TSimulation *sim; }` (`cppprops.h:32`) — the only handle
 *    a generated dyn body has on the model.
 *  * `CppProperties_Init( context )` binds each property's storage to the *live* variable its
 *    `cppsym` names (`metadata[i].value = &( context->sim->fDomains[0].fFoodPatches[0].on )`,
 *    `generated.cc`) and runs the property's init body once; it does **not** write the initial
 *    value into that variable (the worldfile already did).
 *  * `CppProperties::update()` runs at the **start** of every `Step()` (`Simulation.cc:648`),
 *    before `UpdateAgents`/`Interact`, and each dynamic property writes its value only when it
 *    changed (`if( newval != *value ) *value = newval;`).
 *  * The runtime properties are not copies: `metadata[i].value` is a *pointer* to
 *    `context->sim->fStep`, `objectxsortedlist::gXSortedObjects.agentCount|foodCount` and
 *    `context->sim->fNumberAliveWithMetabolism[ Metabolism::get( i )->index ]` — so a body reads
 *    the live variable at the update point, and the monitor that prints them
 *    (`getStatusText`/`FarmMonitor`) reads the same live variables at the step-ending signal.
 *
 * PORT-NOTE(sim/cppprops-engine-context): the W1h interpreter (`tools/cppprops/lib/cppprops.mjs`)
 * owns the property *values* (storage, update order, write-if-changed, `%g`); it cannot own the
 * engine. This module is the engine half and is wired into the sim through
 * `DynamicPropertySet` (`simulation.ts`, `PORT-NOTE(sim/cppprops-seam)`): `init( sim )` at the
 * ctor's `InitCppProperties` step and `update( sim )` at the update step. There is no second
 * implementation of the interpreter here — `CppPropsEvaluator` is constructed as-is and this
 * module only serves its `ctx`:
 *
 *    `ctx.patchAgentInsideCount( domain, patch )` → the live `FoodPatch::agentInsideCount`
 *        (`environment/patch.ts`; native resets it at the top of `DeathAndStats`,
 *        `Simulation.cc:1701`, and accumulates per agent at `:1842-1850`), which is why the ring
 *        reads the **previous** step's accumulation — the interpreter's own phase note.
 *    `ctx.engine.onActivatePatch( domain, patch, radius )` → native
 *        `FoodPatchTokenRing::updateActive` (`state.cc:205-213`): mark every agent inside the
 *        newly active patch `SetDeathByPatch()`; the death itself happens later, in the sim's own
 *        death gate (`sim/interact.ts`, native `Simulation.cc:1810-1818`).
 *
 * PORT-NOTE(sim/cppprops-storage-writeback): a dynamic property's cpp symbol is a *pointer into
 * the model*, so a value that changes must change the model, not just the property table. The
 * port reproduces that for the symbols it can resolve by walking the same
 * `context->sim->…`/`barrier::gBarriers[…]` shapes the extractor emits, and then *setting* the
 * live member (`FoodPatch::setOn`, the barrier's `LineSegment` accessors, whose setters narrow to
 * native's `float`). A symbol the port has no object for stays in the interpreter's storage — the
 * value is still published (the farm monitor / status text read it) but it cannot reach the
 * simulation; every such property is listed on `unresolvedStorage` so the limit is auditable
 * instead of silent. `bindings/gene.mjs` names the same class of limit for the gene write-back
 * (`docs/specs/cppprops.md` §8.1).
 */

import { CppPropsEvaluator, formatNative } from '../../../tools/cppprops/lib/cppprops.mjs';
import type {
  CppPropsBindingEntry,
  CppPropsProperty,
  CppPropsSpec,
} from '../../../tools/cppprops/lib/cppprops.mjs';
import defaultBindings from '../../../tools/cppprops/bindings/index.mjs';
import { Agent, Metabolism } from '../agent';
import { Barrier, type FoodPatch } from '../environment';
import { GObjectType } from '../types';
import type { CppPropertyMetadataView, DynamicPropertySet, Simulation } from './simulation';

const AGENTTYPE = GObjectType.AGENT;
const FOODTYPE = GObjectType.FOOD;

/** Native `PropertyMetadata::Type` (`cppprops.h:47-50`). */
const CPP_DYNAMIC = 0;
const CPP_RUNTIME = 1;

/**
 * The interpreter's storage map — `lib/cppprops.mjs` keeps it public (`this.storage`), but its
 * `.d.mts` (lane W1h's file, and the card's "do not change `tools/cppprops/**`" constraint) does
 * not declare it. The sim needs it for exactly one thing: native's `metadata[i].value` *is* the
 * live variable, so a live caller has to put its values there before the update runs — see
 * PORT-NOTE(sim/cppprops-live-runtime-values) in `update()`.
 */
const storageOf = (evaluator: CppPropsEvaluator): Map<string, unknown> =>
  (evaluator as unknown as { storage: Map<string, unknown> }).storage;

/**
 * Store a value at the width of the C++ variable it stands for (native `*(float*)value = x` etc.).
 * The interpreter does this for the values it is handed; a caller that seeds the storage itself has
 * to do it before the bodies read.
 */
function coerceLike(cppType: string, value: unknown): unknown {
  switch (cppType) {
    case 'float':
      return Math.fround(Number(value));
    case 'int':
      return Number(value) | 0;
    case 'bool':
      return Boolean(value);
    default:
      return value;
  }
}

/**
 * A `dyn` set that cannot be served: an unportable body with no binding (the W1h refusal, which
 * `run_cppprops.mjs` reports as exit 3), or a runtime property the port has no live source for.
 *
 * Native cannot reach either state — the generated C++ either compiles (every symbol exists) or
 * the run dies at init. The port reproduces that "refuse, never guess": a missing piece of the
 * engine context is an exception at the native point, never a silent 0.
 */
export class CppPropertiesRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CppPropertiesRefusalError';
  }
}

export interface CppPropertiesOptions {
  /** The build-time spec (`tools/cppprops/extract_cppprops.py` → `cppprops.json`). */
  readonly spec: CppPropsSpec | Record<string, unknown>;
  /** Bindings for the unportable bodies; defaults to W1h's shipped registry. */
  readonly bindings?: Record<string, CppPropsBindingEntry>;
}

/**
 * The engine's `patchAgentInsideCount` table.
 *
 * PORT-NOTE(sim/cppprops-live-patch-counts): the W1h interpreter's `ctx.patchAgentInsideCount(
 * domain, patch )` reads `engine.patchAgentInsideCount[ "<domain>.<patch>" ]` (the shape its CLI
 * takes: one static table, or a per-step one), because the CLI's caller only has a *recording* of
 * the counts. The sim has the counts themselves, so it serves the same table shape as a **live
 * view over the running patches** — a `Proxy` whose lookups read `FoodPatch::agentInsideCount` at
 * the moment the ring asks. Two consequences worth naming:
 *
 *  * no phase alignment is needed here (the CLI's `stepShift -1` exists because a recorded table
 *    is a copy taken at the step-ending signal, while the ring runs at the step's start); the live
 *    field *is* the previous step's accumulation, which is exactly what native's
 *    `member->patch->agentInsideCount` reads;
 *  * a key naming a patch the run does not have is *not* a silent 0: `has` answers only for
 *    well-formed `<domain>.<patch>` keys and the read itself goes through `foodPatchOf`, which
 *    refuses out-of-range addresses.
 */
function livePatchCountTable(sim: () => Simulation): Record<string, number> {
  const keyOf = (key: string | symbol): string | null =>
    typeof key === 'string' && /^\d+\.\d+$/.test(key) ? key : null;
  const read = (key: string): number => {
    const [domain, patch] = key.split('.');
    return foodPatchOf(sim(), domain, patch).agentInsideCount;
  };
  return new Proxy({} as Record<string, number>, {
    has: (_target, key) => keyOf(key) !== null,
    get: (_target, key) => {
      const text = keyOf(key);
      return text === null ? undefined : read(text);
    },
  });
}

/** One runtime property's live source, keyed by the native symbol (and by its full name). */
interface RuntimeSource {
  readonly symbol: RegExp;
  readonly name: RegExp;
  readonly read: (sim: Simulation, match: RegExpExecArray) => number;
}

const normalizeSymbol = (text: unknown): string => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Native `Metabolism::get( i )->index` — the worldfile's definition order. */
function metabolismIndexOf(i: number): number {
  const metabolism = Metabolism.get(i);
  if (metabolism === undefined) {
    throw new CppPropertiesRefusalError(
      `cppprops: the dyn set reads AgentMetabolisms[${i}] but the run defines ` +
        `${Metabolism.getNumberOfDefinitions()} metabolism(s)` +
        " (native `Metabolism::get( i )->index` would dereference NULL)",
    );
  }
  return metabolism.index;
}

/**
 * The four runtime symbols the shipping worldfiles compile to (measured across the ten shipping
 * worldfiles, `docs/specs/cppprops.md` §1) — each read from the live sim, exactly where native's
 * `metadata[i].value` points.
 */
const RUNTIME_SOURCES: readonly RuntimeSource[] = [
  {
    symbol: /^context->sim->fStep$/,
    name: /^Step$/,
    read: (sim) => sim.fStep,
  },
  {
    symbol: /^objectxsortedlist::gXSortedObjects\.agentCount$/,
    name: /^AgentCount$/,
    read: (sim) => sim.objects().getCount(AGENTTYPE),
  },
  {
    symbol: /^objectxsortedlist::gXSortedObjects\.foodCount$/,
    name: /^FoodCount$/,
    read: (sim) => sim.objects().getCount(FOODTYPE),
  },
  {
    symbol: /^context->sim->fNumberAliveWithMetabolism\[ Metabolism::get\( (\d+) \)->index \]$/,
    name: /^AgentMetabolisms\[(\d+)\]\.MetabolismAgentCount$/,
    read: (sim, match) => {
      const index = metabolismIndexOf(Number(match[1]));
      const value = sim.fNumberAliveWithMetabolism[index];
      if (value === undefined) {
        throw new CppPropertiesRefusalError(
          `cppprops: fNumberAliveWithMetabolism has no entry ${index} (native reads the live array)`,
        );
      }
      return value;
    },
  },
];

function runtimeSourceFor(prop: CppPropsProperty): { source: RuntimeSource; match: RegExpExecArray } | null {
  for (const source of [prop.cppSymbol, prop.name]) {
    const text = normalizeSymbol(source);
    for (const candidate of RUNTIME_SOURCES) {
      const match = (source === prop.cppSymbol ? candidate.symbol : candidate.name).exec(text);
      if (match) return { source: candidate, match };
    }
  }
  return null;
}

/** Native `Patch::pointIsInside`/`FoodPatch::agentInsideCount` reached through the sim handle. */
function foodPatchOf(sim: Simulation, domain: unknown, patch: unknown): FoodPatch {
  const domainNumber = Number(domain);
  const patchNumber = Number(patch);
  const dom = sim.fDomains[domainNumber];
  if (dom === undefined) {
    throw new CppPropertiesRefusalError(
      `cppprops: the dyn set addressed fDomains[${domainNumber}] but the run has ` +
        `${sim.fNumDomains} domain(s)`,
    );
  }
  const foodPatch = dom.foodPatches[patchNumber];
  if (foodPatch === undefined) {
    throw new CppPropertiesRefusalError(
      `cppprops: the dyn set addressed fDomains[${domainNumber}].fFoodPatches[${patchNumber}] ` +
        `but that domain has ${dom.numFoodPatches} food patch(es)`,
    );
  }
  return foodPatch;
}

/**
 * Native `FoodPatchTokenRing::updateActive`'s kill side effect (`state.cc:205-213`): reset the
 * x-sorted list, walk the agents in x order and `SetDeathByPatch()` every one inside the newly
 * active patch, within `radius`. Returns how many were marked (native returns void; the count is
 * for tests and for the event log).
 */
function killAgentsInside(sim: Simulation, foodPatch: FoodPatch, radius: number): number {
  const list = sim.objects();
  list.reset();
  let marked = 0;
  for (;;) {
    const agent = list.nextObj(AGENTTYPE) as Agent | null;
    if (agent === null) break;
    if (foodPatch.pointIsInside(agent.x(), agent.z(), radius)) {
      agent.setDeathByPatch();
      marked++;
    }
  }
  return marked;
}

/**
 * The live member a dynamic property's cpp symbol names, as a setter — or `null` when the port
 * has no object for it (see PORT-NOTE(sim/cppprops-storage-writeback)).
 */
function storageWriterFor(
  sim: Simulation,
  prop: CppPropsProperty,
): ((value: unknown) => void) | null {
  const symbol = normalizeSymbol(prop.cppSymbol);

  const foodPatchOn = /^context->sim->fDomains\[ (\d+) \]\.fFoodPatches\[ (\d+) \]\.on$/.exec(symbol);
  if (foodPatchOn) {
    // Validate the address now: a worldfile's patch index cannot change during a run, so a bad one
    // is a spec/extractor bug worth failing at init rather than at step 1.
    foodPatchOf(sim, foodPatchOn[1], foodPatchOn[2]);
    return (value) => foodPatchOf(sim, foodPatchOn[1], foodPatchOn[2]).setOn(Boolean(value));
  }

  const barrierMember = /^barrier::gBarriers\[ (\d+) \]->getPosition\(\)\.(xa|za|xb|zb)$/.exec(symbol);
  if (barrierMember) {
    const barrier = Barrier.gBarriers[Number(barrierMember[1])];
    if (barrier === undefined) {
      throw new CppPropertiesRefusalError(
        `cppprops: the dyn set addressed barrier::gBarriers[${barrierMember[1]}] but the run built ` +
          `${Barrier.gBarriers.length} barrier(s)`,
      );
    }
    const member = barrierMember[2] as 'xa' | 'za' | 'xb' | 'zb';
    // `LineSegment`'s setters narrow to native's `float` member — the same store native's
    // `*((float*)metadata[i].value) = newval` performs on the generated pointer.
    return (value) => {
      barrier.getPosition()[member] = Number(value);
    };
  }

  return null;
}

/**
 * The sim's `CppProperties`: W1h's interpreter plus the engine context this lane owns.
 *
 * ```ts
 * const properties = createCppProperties({ spec });
 * new Simulation({ …, dynamicProperties: properties });
 * properties.getMetadata();   // the status-text / farm-monitor table, read live
 * ```
 */
export class SimCppProperties implements DynamicPropertySet {
  /** Properties whose storage the port could not resolve to a live object (see the PORT-NOTE). */
  readonly unresolvedStorage: readonly string[];

  private readonly spec: CppPropsSpec;
  private readonly evaluator: CppPropsEvaluator;
  private readonly writers = new Map<string, (value: unknown) => void>();
  private readonly readers = new Map<string, (sim: Simulation) => number>();
  private readonly runtimeProps: CppPropsProperty[] = [];
  private readonly unresolved: string[] = [];
  private sim: Simulation | null = null;

  constructor(options: CppPropertiesOptions) {
    this.spec = options.spec as CppPropsSpec;
    const bindings =
      options.bindings ?? (defaultBindings as unknown as Record<string, CppPropsBindingEntry>);

    // The engine context the W1h bindings reach through `ctx`. Both callbacks need the sim, which
    // only exists after the ctor hands it over in `init` — the same order native has (the context
    // is built with `sim`, and the generated code calls it from the init bodies onwards).
    const engine = {
      patchAgentInsideCount: livePatchCountTable(() => this.requireSim()),
      onActivatePatch: (domain: unknown, patch: unknown, radius: unknown): number =>
        killAgentsInside(this.requireSim(), foodPatchOf(this.requireSim(), domain, patch), Number(radius)),
    };

    this.evaluator = new CppPropsEvaluator(this.spec, { bindings, engine });

    if (this.evaluator.missingBindings.length) {
      // The W1h exit-3 contract, in the sim: native's generated code has no way to reach this
      // state (the symbol either exists or the build fails), so a port that ran on would be
      // inventing a value. Refuse by name, at the native point (init).
      const lines = this.evaluator.missingBindings.map(
        (missing) => `  ${missing.name}: ${missing.symbols.join(', ')}`,
      );
      throw new CppPropertiesRefusalError(
        `cppprops: unportable dyn bodies with no binding:\n${lines.join('\n')}`,
      );
    }

    for (const prop of this.spec.properties) {
      if (prop.kind !== 'Runtime') continue;
      const resolved = runtimeSourceFor(prop);
      if (resolved === null) {
        throw new CppPropertiesRefusalError(
          `cppprops: no live source for runtime property '${prop.name}' ` +
            `(${normalizeSymbol(prop.cppSymbol) || 'no cpp symbol'}) — the port cannot serve a ` +
            'value it would have to invent',
        );
      }
      const { source, match } = resolved;
      this.readers.set(prop.name, (sim) => source.read(sim, match));
      this.runtimeProps.push(prop);
    }

    this.unresolvedStorage = this.unresolved;
  }

  /** Native `CppProperties_Init( context )` — bind the storage, then run the init bodies. */
  init(sim: Simulation): void {
    if (this.sim !== null) {
      throw new Error('cppprops: init() called twice (native `assert( !inited )`)');
    }
    this.sim = sim;

    for (const prop of this.spec.properties) {
      if (prop.kind !== 'Dynamic') continue;
      const writer = storageWriterFor(sim, prop);
      if (writer === null) {
        this.unresolved.push(`${prop.name} (${normalizeSymbol(prop.cppSymbol)})`);
        continue;
      }
      this.writers.set(prop.name, writer);
    }

    this.evaluator.init();

    // The interpreter collects the problems it *cannot* throw on (the CLI reports them and exits 1:
    // a gene-bound property with an unportable init body, an unportable init body with no binding).
    // Native cannot reach any of them — the generated code would not compile — so a run that
    // continued would be publishing values with a known defect behind them. Refuse instead.
    if (this.evaluator.errors.length) {
      throw new CppPropertiesRefusalError(
        `cppprops: the dyn set did not initialise cleanly:\n${this.evaluator.errors
          .map((error) => `  ${error}`)
          .join('\n')}`,
      );
    }
  }

  /**
   * Native `CppProperties_Update()` — once per step, at the native point (the start of `Step()`,
   * before `UpdateAgents`/`Interact`), against the live variables.
   *
   * PORT-NOTE(sim/cppprops-live-runtime-values): native's body reads `*((int*)metadata[i].value)`
   * — the live variable itself, which at that instant holds the previous step's *printed* value.
   * The interpreter is fed those values through `step( values )`, whose own phase rule (see its
   * `STEP_PROPERTY` note) applies the incoming values **after** the update, so that a caller
   * holding a *recording* — printed at the step-ending signal — still evaluates each body against
   * the previous step's numbers. A live caller has the values the rule is trying to reconstruct, so
   * the sim seeds the interpreter's storage with them before the single `step()` call: the update
   * then runs against the same numbers native's pointers hold, and the tail re-application of the
   * same values is a no-op. Both halves matter — seeding alone without the call would skip the
   * update order, and calling alone would use last step's storage.
   *
   * The seeded value is written at the variable's own width (`float` → `fround`, `int` → `|0`,
   * `bool` → `!!`), because native's `metadata[i].value` is a *typed pointer*: the body reads
   * `*(float*)value`, not a `double` copy. The interpreter gets the same effect from its own
   * coercion on the tail write; here it has to happen up front.
   */
  update(sim: Simulation): void {
    this.sim = sim;

    const storage = storageOf(this.evaluator);
    const values: Record<string, number> = {};
    for (const prop of this.runtimeProps) {
      const read = this.readers.get(prop.name);
      if (read === undefined) throw new Error(`cppprops: no reader for '${prop.name}'`);
      const value = coerceLike(prop.cppType, read(sim));
      storage.set(prop.name, value);
      values[prop.name] = value as number;
    }

    this.evaluator.step(values);

    // Native writes each new value into the live variable as it computes it; the values are
    // identical either way (the interpreter's storage is what the next body reads, and the phase
    // note above makes the set of values within one update the same), so the port applies them
    // after the update order has run — one pass, no partial-visibility difference.
    const snapshot = this.evaluator.snapshot();
    for (const [name, write] of this.writers) write(snapshot[name]);
  }

  /**
   * Native `CppProperties::getMetadata( &metadata, &count )`, in metadata order: the table the
   * status text's dynamic block (`sim/statusText.ts`) and the farm monitor read. `toString()`
   * reads **live** — a Runtime entry is the sim's own variable at this instant (native's
   * `metadata[i].value` *is* `&( context->sim->fStep )`, and the monitor samples at the
   * step-ending signal, after the step's deaths/births/food), and a Dynamic entry is the value the
   * last update stored, which is also what native's pointer holds.
   */
  getMetadata(): readonly CppPropertyMetadataView[] {
    return [...this.spec.properties]
      .sort((a, b) => a.index - b.index)
      .map((prop) => ({
        name: prop.name,
        type: prop.kind === 'Dynamic' ? CPP_DYNAMIC : CPP_RUNTIME,
        toString: (): string => formatNative(prop.datalibType, this.valueOf(prop)),
      }));
  }

  private valueOf(prop: CppPropsProperty): unknown {
    if (prop.kind === 'Runtime') {
      const read = this.readers.get(prop.name);
      if (read === undefined) throw new Error(`cppprops: no reader for '${prop.name}'`);
      return read(this.requireSim());
    }
    return this.evaluator.snapshot()[prop.name];
  }

  private requireSim(): Simulation {
    if (this.sim === null) {
      throw new Error('cppprops: the engine context was used before `init( sim )`');
    }
    return this.sim;
  }
}

/** The sim's `CppProperties` for one spec (see `SimCppProperties`). */
export function createCppProperties(options: CppPropertiesOptions): SimCppProperties {
  return new SimCppProperties(options);
}
