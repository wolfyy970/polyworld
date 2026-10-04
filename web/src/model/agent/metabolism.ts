/**
 * Lane L8 — `Metabolism` (native `agent/Metabolism.{h,cc}`).
 *
 * A metabolism is a named per-agent food-processing rule: an energy polarity, an eat
 * multiplier, a per-step energy delta, a minimum age before eating, and the food type a
 * carcass becomes. `agent::setGenomeReady()` binds one to each agent — either the gene's
 * metabolism or a random one — and `agent::eat()`/`UpdateBody()` read it every step.
 *
 * PORT-NOTE(L8/metabolism-registry): native holds the definitions in a file-static
 * `std::vector<Metabolism *>` filled by `Metabolism::define()` in worldfile order, with the
 * index being `metabolisms.size()` *at definition time*. That ordering is model behaviour
 * (an agent's gene stores an index; `Metabolism::get(index)` must return the same object),
 * so the port keeps a module-level array in definition order and nothing may reorder it.
 *
 * PORT-NOTE(L8/metabolism-selection-mode): `selectionMode` is set from the worldfile by the
 * simulation lane (L11) *before* any agent grows; it is a process-wide setting, not a
 * per-agent one, so it lives on the class (as native's static does).
 */

import type { Energy, EnergyMultiplier, EnergyPolarity } from '../environment/energy';
import { Energy as EnergyValue } from '../environment/energy';
import type { FoodTypeLike } from './contracts';

/** Native `Metabolism::SelectionMode`. */
export const MetabolismSelectionMode = {
  Gene: 0,
  Random: 1,
} as const;

export type MetabolismSelectionMode =
  (typeof MetabolismSelectionMode)[keyof typeof MetabolismSelectionMode];

export class Metabolism {
  /** Native `static SelectionMode selectionMode;` — written by L11 from the worldfile. */
  static selectionMode: MetabolismSelectionMode = MetabolismSelectionMode.Gene;

  /** Native `static std::vector<Metabolism *> metabolisms;` — definition order is contract. */
  private static readonly metabolisms: Metabolism[] = [];

  /** Native `const int index`. */
  readonly index: number;
  /** Native `const std::string name`. */
  readonly name: string;
  /** Native `EnergyPolarity energyPolarity`. */
  readonly energyPolarity: EnergyPolarity;
  /** Native `EnergyMultiplier eatMultiplier` — not const in native. */
  eatMultiplier: EnergyMultiplier;
  /** Native `Energy energyDelta`. */
  energyDelta: Energy;
  /** Native `float minEatAge`. */
  minEatAge: number;
  /** Native `const FoodType *carcassFoodType` (lane L10 owns `FoodType`). */
  readonly carcassFoodType: FoodTypeLike | null;

  private constructor(
    index: number,
    name: string,
    energyPolarity: EnergyPolarity,
    eatMultiplier: EnergyMultiplier,
    energyDelta: Energy,
    minEatAge: number,
    carcassFoodType: FoodTypeLike | null,
  ) {
    this.index = index;
    this.name = name;
    this.energyPolarity = energyPolarity;
    this.eatMultiplier = eatMultiplier;
    this.energyDelta = energyDelta;
    this.minEatAge = minEatAge;
    this.carcassFoodType = carcassFoodType;
  }

  /** Native `Metabolism::define( name, polarity, eatMultiplier, energyDelta, minEatAge, carcass )`. */
  static define(
    name: string,
    energyPolarity: EnergyPolarity,
    eatMultiplier: EnergyMultiplier,
    energyDelta: Energy,
    minEatAge: number,
    carcassFoodType: FoodTypeLike | null,
  ): Metabolism {
    const metabolism = new Metabolism(
      Metabolism.metabolisms.length,
      name,
      energyPolarity,
      eatMultiplier,
      energyDelta,
      minEatAge,
      carcassFoodType,
    );
    Metabolism.metabolisms.push(metabolism);
    return metabolism;
  }

  /** Native `Metabolism::getNumberOfDefinitions()`. */
  static getNumberOfDefinitions(): number {
    return Metabolism.metabolisms.length;
  }

  /** Native `Metabolism::get( index )` — unchecked, as native. */
  static get(index: number): Metabolism | undefined {
    return Metabolism.metabolisms[index];
  }

  /** Native `Metabolism::get( index )`, asserting the index exists (lane tests / resets). */
  static require(index: number): Metabolism {
    const metabolism = Metabolism.metabolisms[index];
    if (metabolism === undefined) {
      throw new Error(`Metabolism::get( ${index} ): no such metabolism`);
    }
    return metabolism;
  }

  /** Test/lane helper: the number of registered definitions without exposing the array. */
  static definitions(): readonly Metabolism[] {
    return Metabolism.metabolisms;
  }

  /** Test/lane helper: drop every definition (native has no such call; process exit only). */
  static clearDefinitions(): void {
    Metabolism.metabolisms.length = 0;
  }

  /** A zero energy delta, spelled the way the agent core needs it. */
  static zeroEnergyDelta(): Energy {
    return new EnergyValue(0.0);
  }
}
