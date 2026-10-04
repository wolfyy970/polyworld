/**
 * Lane L10 — native `environment/FoodType.{h,cc}`: the worldfile-declared food kinds and the
 * registry the loggers read their column names from.
 *
 * The registry is two containers in native (`FoodType.cc:11-12`): a `std::map<string,...>`
 * keyed by *name* (`foodTypes`) and a `std::vector<FoodType*>` in *definition order*
 * (`foodTypesVector`). They are not interchangeable and both are observable:
 *
 *  - `getNumberDefinitions()` returns the **map** size and `foodTypesVector` is indexed by
 *    `get()` — the two agree only because `define` inserts into both and the worldfile's
 *    duplicate check stops a name being defined twice.
 *  - `find( polarity )` walks the **map**, i.e. in `strcmp` order on the name (`std::map` is
 *    ordered), and returns the *first* match. A worldfile with two food types of the same
 *    polarity therefore picks the alphabetically-first, not the first-declared.
 *    PORT-NOTE(L10/foodtype-find-order).
 *  - `foodTypes[i]` is `run/energy/food.txt`'s column name (`Logs.cc:1294-1301`) and
 *    `consumption.txt`'s `FoodType` token, so `get( i )->name` for i in
 *    `[0, getNumberDefinitions())` is the byte contract for those two artifacts.
 *    PORT-NOTE(L10/foodtype-log-columns).
 *
 * PORT-NOTE(L10/foodtype-lookup-inserts): native's `lookup()` is `foodTypes[name]` — the
 * `std::map::operator[]`, which **inserts a null entry** for an unknown name. So a lookup of
 * a name that is never defined inflates `getNumberDefinitions()` and adds a null to `find()`'s
 * walk. The port reproduces the insertion (it is observable through the log header) and,
 * like native, lets the null dereference in `find` fail loudly rather than skipping it:
 * a silent skip is exactly the "improvement" PORT_SPEC ground rule 1 forbids.
 */

import type { Color } from '../types';
import type { Energy, EnergyMultiplier, EnergyPolarity } from './energy';

/** Native `class FoodType` (`FoodType.h:9-43`). */
export class FoodType {
  private static foodTypes = new Map<string, FoodType | null>();
  private static foodTypesVector: FoodType[] = [];

  /** Native `const int index;` — the definition order, i.e. `foodTypesVector`'s index. */
  readonly index: number;
  readonly name: string;
  readonly color: Color;
  readonly energyPolarity: EnergyPolarity;
  /** Native declares this one non-const (mutated by `Simulation.cc`'s carcass handling). */
  eatMultiplier: EnergyMultiplier;
  readonly depletionThreshold: Energy;

  private constructor(
    index: number,
    name: string,
    color: Color,
    energyPolarity: EnergyPolarity,
    eatMultiplier: EnergyMultiplier,
    depletionThreshold: Energy,
  ) {
    this.index = index;
    this.name = name;
    this.color = color;
    this.energyPolarity = energyPolarity;
    this.eatMultiplier = eatMultiplier;
    this.depletionThreshold = depletionThreshold;
  }

  /** Native `FoodType::define` (`FoodType.cc:34-50`). */
  static define(
    name: string,
    color: Color,
    energyPolarity: EnergyPolarity,
    eatMultiplier: EnergyMultiplier,
    depletionThreshold: Energy,
  ): FoodType {
    const foodType = new FoodType(
      FoodType.foodTypesVector.length,
      name,
      color,
      energyPolarity,
      eatMultiplier,
      depletionThreshold,
    );
    FoodType.foodTypes.set(name, foodType);
    FoodType.foodTypesVector.push(foodType);
    return foodType;
  }

  /** Native `FoodType::lookup( name )` — inserts a null entry for an unknown name. */
  static lookup(name: string): FoodType | null {
    if (!FoodType.foodTypes.has(name)) FoodType.foodTypes.set(name, null);
    return FoodType.foodTypes.get(name) ?? null;
  }

  /** Native `FoodType::find( const EnergyPolarity & )` — first match in name order. */
  static find(polarity: EnergyPolarity): FoodType | null {
    // `std::map` iterates in `strcmp` order on the key; `Map` preserves *insertion* order, so
    // the keys are sorted explicitly. Native compares with `strcmp` (byte order), which for
    // these ASCII names is the same as the code-unit order `sort()` uses.
    const names = [...FoodType.foodTypes.keys()].sort(compareBytes);
    for (const name of names) {
      const ft = FoodType.foodTypes.get(name);
      // Native dereferences without a null check (a lookup miss crashes it). Keep that: a
      // null here means the worldfile named a food type that does not exist.
      if (ft!.energyPolarity.equals(polarity)) return ft!;
    }
    return null;
  }

  /** Native `FoodType::get( int index )` — the *vector*, i.e. definition order. */
  static get(index: number): FoodType {
    const ft = FoodType.foodTypesVector[index];
    if (ft === undefined) {
      // Native reads past the end of a `std::vector` here (undefined behavior).
      throw new Error(`FoodType::get( ${index} ) is out of range (${FoodType.foodTypesVector.length} defined)`);
    }
    return ft;
  }

  /** Native `FoodType::getNumberDefinitions()` — the **map** size. */
  static getNumberDefinitions(): number {
    return FoodType.foodTypes.size;
  }

  /** Test/simulation hook: native's statics live for the process, so this is explicit. */
  static resetRegistry(): void {
    FoodType.foodTypes = new Map();
    FoodType.foodTypesVector = [];
  }
}

/** `strcmp` on the UTF-8 bytes — the ordering `std::map<string,...>` iterates in. */
function compareBytes(a: string, b: string): number {
  const ta = new TextEncoder().encode(a);
  const tb = new TextEncoder().encode(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    if (ta[i] !== tb[i]) return (ta[i]! - tb[i]!) < 0 ? -1 : 1;
  }
  return ta.length - tb.length;
}
