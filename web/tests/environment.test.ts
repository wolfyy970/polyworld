/**
 * Lane L10 — the environment lane's parity evidence.
 *
 * Two kinds of check live here:
 *
 *  1. **Bit-exact replay of the native probe** (`src/model/environment/native/envprobe.cc`).
 *     The test drives the same fixtures in the same order against the port and compares every
 *     value with the golden bit pattern. Nothing is sampled or approximated: an `f32` pin is
 *     an exact float32 bit comparison, so a one-ulp difference fails. The test also asserts
 *     *coverage* — every key the probe emitted must be consumed — so a fixture that silently
 *     stops running cannot pass.
 *  2. **The recorded run's own barrier rows.** `oracle/minitest_voff/run/events/collisions.log`
 *     logs `barrier` collisions with the agent number and step, and
 *     `oracle/minitest_voff/run/motion/position/agents/position_*.txt` logs where every agent
 *     was at every step — so the barrier geometry this lane owns can be checked against the
 *     real oracle, not just against the probe.
 *
 * The replay must run in the probe's order: the native statics (`Brick::NumBricks`,
 * `Food::fFoodEver`, the food type registry, `globals`) carry state from section to section,
 * and so do the port's. Vitest runs the tests of one file in declaration order, sequentially.
 */

import { describe, expect, it } from 'vitest';

import {
  Barrier,
  BxSortedList,
  Energy,
  EnergyMultiplier,
  EnergyPolarity,
  Food,
  FoodPatch,
  FoodType,
  Patch,
  RecordingStage,
  RECTANGULAR,
  ELLIPTICAL,
  UNIFORM,
  LINEAR,
  GAUSSIAN,
  gXSortedObjects,
  Brick,
  BrickPatch,
  XSortedObjects,
  type DomainLike,
  type GoObject,
} from '../src/model/environment';
import { GOLDEN_BOOL, GOLDEN_F32, GOLDEN_INT, GOLDEN_STR } from '../src/model/environment/golden/nativeEnvironment';
import { GObjectType, globals, resetGlobals, type Color, type RngSurface } from '../src/model/types';
import { f32, f32Bits, f32UlpDistance } from '../src/model/geometry';

// ---------------------------------------------------------------------------
// the pinning harness
// ---------------------------------------------------------------------------

type Kind = 'f32' | 'int' | 'bool' | 'str';

const mismatches: string[] = [];
const consumed = new Set<string>();
const allGoldenKeys = new Set<string>([
  ...Object.keys(GOLDEN_F32).map((k) => `f32:${k}`),
  ...Object.keys(GOLDEN_INT).map((k) => `int:${k}`),
  ...Object.keys(GOLDEN_BOOL).map((k) => `bool:${k}`),
  ...Object.keys(GOLDEN_STR).map((k) => `str:${k}`),
]);

function hex32(bits: number): string {
  return `0x${(bits >>> 0).toString(16).padStart(8, '0')}`;
}

function note(kind: Kind, key: string, port: string, native: string): void {
  consumed.add(`${kind}:${key}`);
  if (port !== native) mismatches.push(`${key}: port=${port} native=${native}`);
}

function missing(kind: Kind, key: string): void {
  consumed.add(`${kind}:${key}`);
  mismatches.push(`${key}: no golden value of kind ${kind}`);
}

/** Pin a native `float` result by its exact bit pattern. */
function p32(key: string, value: number): void {
  const native = GOLDEN_F32[key];
  if (native === undefined) return missing('f32', key);
  note('f32', key, hex32(f32Bits(value)), `0x${native}`);
}

function pint(key: string, value: number): void {
  const native = GOLDEN_INT[key];
  if (native === undefined) return missing('int', key);
  note('int', key, String(value), String(native));
}

function pbool(key: string, value: boolean): void {
  const native = GOLDEN_BOOL[key];
  if (native === undefined) return missing('bool', key);
  note('bool', key, String(value), String(native));
}

function pstr(key: string, value: string): void {
  const native = GOLDEN_STR[key];
  if (native === undefined) return missing('str', key);
  note('str', key, value, native);
}

/** `%.9g`-style rendering for the port-side of a string pin (the probes' list dumps). */
function g9(v: number): string {
  if (v === 0) return '0';
  const p = v.toPrecision(9);
  if (!p.includes('.')) return p;
  return p.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const WORLD_SIZE = 25;
const energyFixes = [
  { name: 'uniform1', aBase: 1, aM: [1, 1, 1, 1], bBase: 2.5, bM: [1, 1, 1, 1] },
  { name: 'zero', aBase: 0, aM: [1, 1, 1, 1], bBase: 0.1, bM: [1, 1, 1, 1] },
  { name: 'negative', aBase: -3.75, aM: [1, 1, 1, 1], bBase: -2.5, bM: [1, 1, 1, 1] },
  { name: 'mixed', aBase: 3, aM: [2, 0.5, 0.25, 1], bBase: 1, bM: [0.5, 2, 4, 0.125] },
  { name: 'tinyHuge', aBase: 1e-5, aM: [1, 1e-3, 1e3, 1], bBase: 1e10, bM: [1, 1e-3, 1e3, 1] },
  { name: 'eps', aBase: 1, aM: [1e-5, 2e-5, 0.5, 1], bBase: 0.5, bM: [1, 1, 1, 1] },
] as const;
const foodTypeNames = ['Standard', 'a', 'A', '10', '2', 'B'];
const foodTypeThresholds = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
const foodTypeMultipliers = [1, 2, 3, 4, 5, 6];

function colorOf(i: number): Color {
  return { r: 0.1 * (i + 1), g: 0.2 * (i + 1), b: 0.3 * (i + 1) };
}

function makeEnergy(n: number, base: number, m: readonly number[]): Energy {
  return new Energy(base).mulMultiplier(EnergyMultiplier.fromNumbers(m.slice(0, n)));
}

function dumpFood(key: string, f: Food): void {
  p32(`${key}.energy`, f.getEnergy().get(0));
  p32(`${key}.x`, f.x());
  p32(`${key}.y`, f.y());
  p32(`${key}.z`, f.z());
  p32(`${key}.radius`, f.radius());
  p32(`${key}.lx`, f.length[0]!);
  p32(`${key}.ly`, f.length[1]!);
  p32(`${key}.lz`, f.length[2]!);
  pint(`${key}.typeNumber`, f.getTypeNumber());
  pint(`${key}.objType`, f.getType());
  pint(`${key}.domain`, f.domain());
  pstr(`${key}.foodType`, f.getType_().name);
  pbool(`${key}.isDepleted`, f.isDepleted());
}

// The probe's stage/domain, shared across the patch, brick and object-list sections.
const stage = new RecordingStage();
const domain: DomainLike = { startX: -12.5, startZ: -25, absoluteSizeX: 25, absoluteSizeZ: 25 };

const objectTypeName = (bits: number): string =>
  bits === GObjectType.AGENT ? 'agent' : bits === GObjectType.FOOD ? 'food' : bits === GObjectType.BRICK ? 'brick' : 'unknown';

function dumpListOrder(pre: string, list: XSortedObjects): void {
  let idx = 0;
  list.reset();
  for (;;) {
    const o = list.next();
    if (o === null) break;
    pstr(`${pre}.${idx}`, `${objectTypeName(o.getType())}#${o.getTypeNumber()}@${g9(o.x())}`);
    idx++;
  }
  pint(`${pre}.count`, idx);
}

/** The cursor `sort()` leaves behind — the next walker resumes from exactly here. */
function dumpCursor(pre: string, list: XSortedObjects): void {
  const c = list.current();
  pstr(`${pre}.current`, c === null ? '<off-end>' : `${objectTypeName(c.getType())}#${c.getTypeNumber()}@${g9(c.x())}`);
  pbool(`${pre}.currItemOffEnd`, list.getcurr() === null);
  pint(`${pre}.kount`, list.count());
}

/**
 * Lane L8's `agent` as the x-sorted list sees it: the radius lives behind the `radius()`
 * *method* and there is no numeric radius field anywhere on the object — exactly the shape
 * that makes a field read in the list compute `NaN`. Native's `objectxsortedlist` spells its
 * key `a->x() - a->radius()` over `gobject*` elements, so an object like this one is a
 * first-class list member; the probe's `objectlist.accessor.*` section is the native side of
 * the same shape (a bare `gobject` subclass whose radius arrives through the accessor).
 */
class AccessorRadiusObject {
  listLink: unknown = null;
  private px: number;
  private radiusValue: number;
  private readonly typeNumber: number;

  constructor(x: number, r: number, typeNumber: number) {
    this.px = f32(x);
    this.radiusValue = f32(r);
    this.typeNumber = typeNumber;
  }

  x(): number {
    return this.px;
  }
  radius(): number {
    return this.radiusValue;
  }
  getType(): number {
    return GObjectType.AGENT;
  }
  getTypeNumber(): number {
    return this.typeNumber;
  }
  setx(x: number): void {
    this.px = f32(x);
  }
  setradius(r: number): void {
    this.radiusValue = f32(r);
  }
}

/**
 * `add` is typed `GoObject`; this stub answers every member the list actually calls on its
 * members (`getType`, `getTypeNumber`, `x`, `radius`, `listLink`), which is what the native
 * `gobject*` slot asks of `agent` too.
 */
function addAccessorObject(o: AccessorRadiusObject): void {
  gXSortedObjects.add(o as unknown as GoObject);
}

describe('L10 environment — native probe replay (bit-exact)', () => {
  it('part 1/7: Energy', () => {
    pstr('probe.mode', 'env');
    for (let n = 1; n <= 3; n++) {
      globals.numEnergyTypes = n;
      for (const fix of energyFixes) {
        const a = makeEnergy(n, fix.aBase, fix.aM);
        const b = makeEnergy(n, fix.bBase, fix.bM);
        const pre = `energy.n${n}.${fix.name}`;

        for (let k = 0; k < n; k++) {
          p32(`${pre}.a.${k}`, a.get(k));
          p32(`${pre}.b.${k}`, b.get(k));
        }

        p32(`${pre}.sum`, a.sum());
        p32(`${pre}.mean`, a.mean());
        pbool(`${pre}.isZero`, a.isZero());
        pbool(`${pre}.isDepletedDefault`, a.isDepletedDefault());
        pbool(`${pre}.isDepletedEps`, a.isDepleted(new Energy(0.00001)));
        const zeroed = a.clone();
        zeroed.zero();
        p32(`${pre}.zeroAfterZero`, zeroed.get(0));

        const sum = a.clone();
        sum.addAssign(b);
        const diff = a.clone();
        diff.subAssign(b);
        const scaled = a.mulScalar(3.5);
        const halved = a.mulScalar(2.5); // `2.5f * a` is native's `a * 2.5f`
        for (let k = 0; k < n; k++) {
          p32(`${pre}.add.${k}`, sum.get(k));
          p32(`${pre}.sub.${k}`, diff.get(k));
          p32(`${pre}.mulScalarLeft.${k}`, scaled.get(k));
          p32(`${pre}.mulScalarRight.${k}`, halved.get(k));
        }

        for (let k = 0; k < n; k++) {
          p32(`${pre}.addAssign.${k}`, sum.get(k));
          p32(`${pre}.subAssign.${k}`, diff.get(k));
        }

        const m2 = EnergyMultiplier.fromNumbers([0, -2, 2, 0.5].slice(0, n));
        const prod = a.mulMultiplier(m2);
        for (let k = 0; k < n; k++) p32(`${pre}.mulMultiplier.${k}`, prod.get(k));

        const polarity = new EnergyPolarity();
        const flipped = a.mulPolarity(polarity);
        for (let k = 0; k < n; k++) p32(`${pre}.mulPolarity.${k}`, flipped.get(k));
        const threshold = Energy.createDepletionThreshold(new Energy(1), polarity);
        for (let k = 0; k < n; k++) p32(`${pre}.depletionThreshold.${k}`, threshold.get(k));
        pbool(`${pre}.polarityEquals`, polarity.equals(polarity));

        const clamped = a.clone();
        clamped.constrain(new Energy(-2), new Energy(1));
        const overflowed = a.clone();
        const overflow = overflowed.constrainOverflow(new Energy(-2), new Energy(1));
        for (let k = 0; k < n; k++) {
          p32(`${pre}.constrain.${k}`, clamped.get(k));
          p32(`${pre}.clamped.${k}`, overflowed.get(k));
          p32(`${pre}.overflow.${k}`, overflow.get(k));
        }

        const fromPolarity = Energy.fromPolarity(a, b, new EnergyPolarity());
        for (let k = 0; k < n; k++) p32(`${pre}.fromPolarity.${k}`, fromPolarity.get(k));
      }
    }

    globals.numEnergyTypes = 3;
    pbool('energy.polarequal.xx', new EnergyPolarity().equals(new EnergyPolarity()));
    const m1 = EnergyMultiplier.fromNumbers([1, 0.5, -2, 0]);
    const m2 = EnergyMultiplier.fromNumbers([1, 0.5, -2, 0]);
    const m3 = EnergyMultiplier.fromNumbers([1, 0.5 + 1e-7, -2, 0]);
    pbool('energy.muleq.near', multiplierEquals(m1, m2));
    pbool('energy.muleq.far', multiplierEquals(m1, m3));
    pint('energy.muleq.index0', m1.get(0) === 1 ? 1 : 0);

    expect(mismatches).toEqual([]);
  });

  it('part 2/7: FoodType registry', () => {
    globals.numEnergyTypes = 1;
    FoodType.resetRegistry();

    for (let i = 0; i < 6; i++) {
      FoodType.define(
        foodTypeNames[i]!,
        colorOf(i),
        new EnergyPolarity(),
        EnergyMultiplier.fromNumbers([foodTypeMultipliers[i]!, 1, 1, 1].slice(0, 1)),
        new Energy(foodTypeThresholds[i]!),
      );
    }

    pint('foodtype.count', FoodType.getNumberDefinitions());
    for (let i = 0; i < FoodType.getNumberDefinitions(); i++) {
      const ft = FoodType.get(i);
      pstr(`foodtype.get.${i}.name`, ft.name);
      pint(`foodtype.get.${i}.index`, ft.index);
      p32(`foodtype.get.${i}.threshold`, ft.depletionThreshold.get(0));
      p32(`foodtype.get.${i}.eatMultiplier`, ft.eatMultiplier.get(0));
      p32(`foodtype.get.${i}.colorR`, ft.color.r);
    }

    for (const name of foodTypeNames) pbool(`foodtype.lookup.${name}.present`, FoodType.lookup(name) !== null);

    const found = FoodType.find(new EnergyPolarity());
    pstr('foodtype.find.positive', found ? found.name : '<null>');
    pstr(
      'foodtype.find.namesOrder',
      [FoodType.lookup('Standard')!.name, FoodType.lookup('2')!.name, FoodType.lookup('10')!.name, FoodType.lookup('A')!.name, FoodType.lookup('B')!.name, FoodType.lookup('a')!.name].join(','),
    );

    pint('foodtype.count.beforeUnknownLookup', FoodType.getNumberDefinitions());
    pbool('foodtype.lookup.unknown.isNull', FoodType.lookup('ZZZ-never-defined') === null);
    pint('foodtype.count.afterUnknownLookup', FoodType.getNumberDefinitions());

    expect(mismatches).toEqual([]);
  });

  it('part 3/7: food', () => {
    const st = FoodType.lookup('Standard')!;

    Food.gFoodHeight = 1;
    Food.gFoodColor = { r: 0.25, g: 0.5, b: 0.75 };
    Food.gMinFoodEnergy = 200;
    Food.gMaxFoodEnergy = 1000;
    Food.gSize2Energy = 300;
    Food.gMaxFoodRadius = 1.5;
    Food.gCarryFood2Energy = 0.125;
    Food.gMaxLifeSpan = 0;
    globals.worldsize = WORLD_SIZE;

    globalRngSurface().srand48(20260928);

    for (let i = 0; i < 3; i++) dumpFood(`food.random2.${i}`, new Food(st, 0));

    for (let i = 0; i < 2; i++) {
      const f = new Food(st, 7, new Energy(1500));
      dumpFood(`food.givenE.${i}`, f);
      pint(`food.givenE.${i}.age10`, f.getAge(10));
      pint(`food.givenE.${i}.age0`, f.getAge(0));
    }

    {
      const f = new Food(st, -3, new Energy(400), 12.5, -7.25);
      dumpFood('food.carcass', f);
      pint('food.carcass.creationStepViaAge0', f.getAge(0));
    }

    {
      const f = new Food(st, 0, new Energy(100), 1, 2);
      dumpFood('food.eat.initial', f);

      p32('food.eat.part.actual', f.eat(new Energy(25)).get(0));
      dumpFood('food.eat.part', f);

      p32('food.eat.all.actual', f.eat(new Energy(1000)).get(0));
      dumpFood('food.eat.all', f);

      p32('food.eat.empty.actual', f.eat(new Energy(5)).get(0));
      dumpFood('food.eat.empty', f);

      p32('food.eat.negative.actual', f.eat(new Energy(-4)).get(0));
      dumpFood('food.eat.negative', f);
    }

    {
      Food.gAllFood.clear();
      new Food(st, 5, new Energy(1), 1, 1);
      new Food(st, -1, new Energy(2), 2, 2);
      new Food(st, 5, new Energy(3), 3, 3);
      new Food(st, -7, new Energy(4), 4, 4);
      new Food(st, 0, new Energy(5), 5, 5);
      new Food(st, -1, new Energy(6), 6, 6);

      const order = Food.gAllFood.toArray();
      order.forEach((f, idx) => p32(`food.gAllFood.order.${idx}`, f.getEnergy().get(0)));
      pint('food.gAllFood.size', Food.gAllFood.size);
    }

    expect(mismatches).toEqual([]);
  });

  it('part 4/7: Patch / FoodPatch / BrickPatch', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = WORLD_SIZE;
    const st = FoodType.lookup('Standard')!;

    const specs = [
      { name: 'recorded0', x: 0.5, z: 0.05, sx: 1, sz: 0.1, shape: RECTANGULAR, distrib: UNIFORM, nh: 10 },
      { name: 'recorded1', x: 0.5, z: 0.8, sx: 1, sz: 0.4, shape: RECTANGULAR, distrib: UNIFORM, nh: 10 },
      { name: 'rectLinear', x: 0.25, z: 0.75, sx: 0.5, sz: 0.5, shape: RECTANGULAR, distrib: LINEAR, nh: 2.5 },
      { name: 'rectGauss', x: 0.1, z: 0.2, sx: 0.3, sz: 0.4, shape: RECTANGULAR, distrib: GAUSSIAN, nh: 1 },
      { name: 'ellipseUniform', x: 0.5, z: 0.5, sx: 1, sz: 1, shape: ELLIPTICAL, distrib: UNIFORM, nh: 3 },
      { name: 'ellipseLinear', x: 0.75, z: 0.25, sx: 0.6, sz: 0.8, shape: ELLIPTICAL, distrib: LINEAR, nh: 0.5 },
      { name: 'ellipseGauss', x: 0.9, z: 0.1, sx: 0.2, sz: 0.9, shape: ELLIPTICAL, distrib: GAUSSIAN, nh: 0 },
    ] as const;

    for (const spec of specs) {
      const p = new FoodPatch(stage);
      p.init(st, spec.x, spec.z, spec.sx, spec.sz, 0.1, 500, 90, 45, 90, 90, 0.25, spec.shape, spec.distrib, spec.nh, true, false, domain, 2);

      const pre = `patch.${spec.name}`;
      p32(`${pre}.centerX`, p.centerX);
      p32(`${pre}.centerZ`, p.centerZ);
      p32(`${pre}.sizeX`, p.sizeX);
      p32(`${pre}.sizeZ`, p.sizeZ);
      p32(`${pre}.startX`, p.startX);
      p32(`${pre}.endX`, p.endX);
      p32(`${pre}.startZ`, p.startZ);
      p32(`${pre}.endZ`, p.endZ);
      p32(`${pre}.area`, p.getArea());
      p32(`${pre}.neighborhoodSize`, p.neighborhoodSize);
      pint(`${pre}.domainNumberOfParent`, p.domainNumberOfParent);
      pint(`${pre}.agentInsideCount`, p.agentInsideCount);
      p32(`${pre}.fraction`, p.fraction);
      p32(`${pre}.growthRate`, p.growthRate);
      p32(`${pre}.energy`, p.energy);
      pint(`${pre}.initFoodCount`, p.initFoodCount);
      pint(`${pre}.minFoodCount`, p.minFoodCount);
      pint(`${pre}.maxFoodCount`, p.maxFoodCount);
      pint(`${pre}.maxFoodGrownCount`, p.maxFoodGrownCount);
      pint(`${pre}.removeFood`, p.removeFood ? 1 : 0);
      pint(`${pre}.on`, p.isOn() ? 1 : 0);
      pint(`${pre}.foodGrown`, p.isInitFoodGrown() ? 1 : 0);

      const pts: [number, number][] = [
        [p.centerX, p.centerZ],
        [p.startX, p.startZ],
        [p.endX, p.endZ],
        [f32(p.startX - 0.01), p.centerZ],
        [p.centerX, f32(p.endZ + 0.01)],
        [0, 0],
        [-12.5, -25],
      ];
      pts.forEach(([x, z], k) => {
        pbool(`${pre}.inside.${k}`, p.pointIsInside(x, z, 0));
        pbool(`${pre}.insideNh.${k}`, p.pointIsInside(x, z, p.neighborhoodSize));
      });

      p.resetAgentCounts();
      for (const [x, z] of pts) {
        p.checkIfAgentIsInside(x, z);
        p.checkIfAgentIsInsideNeighborhood(x, z);
      }
      pint(`${pre}.agentInsideCount.afterProbe`, p.agentInsideCount);
      pint(`${pre}.agentNeighborhoodCount.afterProbe`, p.agentNeighborhoodCount);

      globalRngSurface().srand48(97);
      for (let k = 0; k < 4; k++) {
        const { x, z } = p.setPoint();
        p32(`${pre}.setPoint.${k}.x`, x);
        p32(`${pre}.setPoint.${k}.z`, z);
      }
    }

    {
      const p = new FoodPatch(stage);
      p.init(st, 0.5, 0.05, 1, 1, 0.1, 500, 90, 45, 90, 90, 0.25, RECTANGULAR, UNIFORM, 10, true, false, domain, 0);
      p.setInitCounts(11, 22, 33, 44, 0.125);
      pint('patch.setInitCounts.init', p.initFoodCount);
      pint('patch.setInitCounts.min', p.minFoodCount);
      pint('patch.setInitCounts.max', p.maxFoodCount);
      pint('patch.setInitCounts.maxGrown', p.maxFoodGrownCount);
      p32('patch.setInitCounts.fraction', p.fraction);
      pint('patch.onChanged.afterInit', p.isOnChanged() ? 1 : 0);
      p.endStep();
      pint('patch.onChanged.afterEndStep', p.isOnChanged() ? 1 : 0);
    }

    {
      const p = new FoodPatch(stage);
      p.init(st, 0.5, 0.05, 1, 1, 0.1, -1.0, 90, 45, 2, 90, 0.25, RECTANGULAR, UNIFORM, 10, true, false, domain, 0);
      gXSortedObjects.reset();

      globalRngSurface().srand48(555);
      for (let k = 0; k < 4; k++) {
        const f = p.addFood(11, gXSortedObjects);
        pbool(`foodpatch.addFood.${k}.exists`, f !== null);
        if (f) dumpFood(`foodpatch.addFood.${k}`, f);
      }
      pint('foodpatch.addFood.foodCount', p.foodCount);
      pint('foodpatch.addFood.listFoodCount', gXSortedObjects.getCount(GObjectType.FOOD));
      pint('foodpatch.addFood.stageCount', stage.size());
    }

    {
      const bp = new BrickPatch(stage);
      Brick.gBrickHeight = 0.5;
      bp.init({ r: 0.125, g: 0.25, b: 0.5 }, 0.5, 0.5, 0.25, 0.25, 3, RECTANGULAR, UNIFORM, 1, domain, 0, true);

      gXSortedObjects.reset();
      globalRngSurface().srand48(2024);
      bp.updateOn(gXSortedObjects);
      pint('brickpatch.brickCount', bp.brickCount);
      pint('brickpatch.numBricks', Brick.GetNumBricks());
      pint('brickpatch.listBricks', gXSortedObjects.getCount(GObjectType.BRICK));
      pint('brickpatch.stageCount', stage.size());
      {
        let idx = 0;
        gXSortedObjects.reset();
        for (;;) {
          const o = gXSortedObjects.nextObj(GObjectType.BRICK);
          if (o === null) break;
          p32(`brickpatch.brick.${idx}.x`, o.x());
          p32(`brickpatch.brick.${idx}.z`, o.z());
          pint(`brickpatch.brick.${idx}.typeNumber`, o.getTypeNumber());
          idx++;
        }
      }

      bp.updateOn(gXSortedObjects); // no-op: on == onPrev
      pint('brickpatch.afterSecondUpdate.listBricks', gXSortedObjects.getCount(GObjectType.BRICK));

      bp.setOn(false);
      bp.updateOn(gXSortedObjects);
      pint('brickpatch.afterOff.listBricks', gXSortedObjects.getCount(GObjectType.BRICK));
      pint('brickpatch.afterOff.stageCount', stage.size());
      pint('brickpatch.afterOff.brickCount', bp.brickCount);
      pint('brickpatch.afterOff.numBricks', Brick.GetNumBricks());

      bp.setOn(true);
      bp.updateOn(gXSortedObjects);
      pint('brickpatch.afterOn.listBricks', gXSortedObjects.getCount(GObjectType.BRICK));
      pint('brickpatch.afterOn.stageCount', stage.size());
      pint('brickpatch.afterOn.numBricks', Brick.GetNumBricks());
    }

    expect(mismatches).toEqual([]);
  });

  it('part 5/7: barrier', () => {
    globals.worldsize = WORLD_SIZE;
    Barrier.gBarrierHeight = 5;
    Barrier.gBarrierColor = { r: 1, g: 0.5, b: 0.25 };
    Barrier.gStickyBarriers = false;

    const segs = [
      { name: 'recorded0', xa: 0.3333, za: -1, xb: 0.3333, zb: -0.1 },
      { name: 'recorded1', xa: 0.6667, za: -1, xb: 0.6667, zb: -0.1 },
      { name: 'diag', xa: 1, za: 2, xb: 3, zb: 4 },
      { name: 'diagRev', xa: 3, za: 4, xb: 1, zb: 2 },
      { name: 'negSlope', xa: -0.6, za: 0.9, xb: -0.2, zb: -0.35 },
      { name: 'degeneratePoint', xa: 0.5, za: 0.5, xb: 0.5, zb: 0.5 },
      { name: 'degenerateZero', xa: 0, za: 0, xb: 0, zb: 0 },
      { name: 'horizontal', xa: 0.2, za: -0.45, xb: 0.9, zb: -0.45 },
      { name: 'horizontalRev', xa: 0.9, za: -0.45, xb: 0.2, zb: -0.45 },
      { name: 'extreme', xa: -1e6, za: 1e6, xb: 1e6, zb: -1e6 },
    ] as const;

    const pts: [number, number][] = [
      [0, 0],
      [8.3325, -12],
      [-3.25, -25],
      [16.6675, -2.5],
      [1e6, 1e6],
      [-1e6, 1e6],
      [0.5, -0.5],
      [-0.25, 0.125],
      [25, -25],
      [12.5, -1],
    ];

    for (const ratioMode of [0, 1]) {
      Barrier.gRatioPositions = ratioMode === 1;
      for (const seg of segs) {
        const b = new Barrier();
        b.getPosition().xa = seg.xa;
        b.getPosition().za = seg.za;
        b.getPosition().xb = seg.xb;
        b.getPosition().zb = seg.zb;
        b.init();

        const pre = `barrier.${ratioMode === 1 ? 'ratio' : 'abs'}.${seg.name}`;
        p32(`${pre}.xmin`, b.xmin());
        p32(`${pre}.xmax`, b.xmax());
        p32(`${pre}.zmin`, b.zmin());
        p32(`${pre}.zmax`, b.zmax());
        p32(`${pre}.sina`, b.sina());
        p32(`${pre}.cosa`, b.cosa());
        pts.forEach(([x, z], k) => p32(`${pre}.dist.${k}`, b.dist(x, z)));

        b.getPosition().xa = seg.xb;
        b.getPosition().za = seg.zb;
        b.update();
        p32(`${pre}.afterUpdate.xmin`, b.xmin());
        p32(`${pre}.afterUpdate.dist.0`, b.dist(0, 0));
      }
    }

    {
      Barrier.gRatioPositions = false;
      Barrier.gXSortedBarriers.clear();
      const xmins = [5, 3, 5, 1, 4, 0, -2, 5];
      for (const xm of xmins) {
        const b = new Barrier();
        b.getPosition().xa = xm;
        b.getPosition().za = -1;
        b.getPosition().xb = xm;
        b.getPosition().zb = -0.5;
        b.init();
        Barrier.gXSortedBarriers.add(b);
      }
      Barrier.gXSortedBarriers.xsort();

      let idx = 0;
      Barrier.gXSortedBarriers.reset();
      for (;;) {
        const b = Barrier.gXSortedBarriers.next();
        if (b === null) break;
        p32(`barrier.list.order.${idx}`, b.xmin());
        idx++;
      }
      pint('barrier.list.count', Barrier.gXSortedBarriers.count());
    }
    Barrier.gRatioPositions = true;

    expect(mismatches).toEqual([]);
  });

  it('part 6/7: brick', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = WORLD_SIZE;
    Brick.gBrickHeight = 0.5;
    Brick.gCarryBrick2Energy = 0.05;

    p32('brick.gBrickRadius.atSectionStart', Brick.gBrickRadius);
    pint('brick.numBricks.atSectionStart', Brick.GetNumBricks());

    const c: Color = { r: 0.5, g: 0.25, b: 1 };

    globalRngSurface().srand48(31337);
    for (let i = 0; i < 3; i++) {
      const b = new Brick(c);
      const key = `brick.drawn.${i}`;
      p32(`${key}.x`, b.x());
      p32(`${key}.y`, b.y());
      p32(`${key}.z`, b.z());
      p32(`${key}.radius`, b.radius());
      p32(`${key}.lx`, b.length[0]!);
      p32(`${key}.ly`, b.length[1]!);
      p32(`${key}.lz`, b.length[2]!);
      pint(`${key}.typeNumber`, b.getTypeNumber());
      pint(`${key}.objType`, b.getType());
      p32(`${key}.gBrickRadius`, Brick.gBrickRadius);
    }

    {
      const b = new Brick(c, 3.5, -4.25);
      p32('brick.placed.x', b.x());
      p32('brick.placed.y', b.y());
      p32('brick.placed.z', b.z());
      p32('brick.placed.radius', b.radius());
      p32('brick.placed.lx', b.length[0]!);
      pint('brick.placed.typeNumber', b.getTypeNumber());
    }

    pint('brick.numBricks', Brick.GetNumBricks());

    Brick.gBrickHeight = 1.5;
    {
      const b = new Brick(c, 1, 1);
      p32('brick.tall.radius', b.radius());
      p32('brick.tall.ly', b.length[1]!);
    }

    expect(mismatches).toEqual([]);
  });

  it('part 7/9: the x-sorted object list', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = WORLD_SIZE;
    const st = FoodType.lookup('Standard')!;

    // Drop whatever the earlier sections left (native's global persists for the process).
    gXSortedObjects.reset();
    for (;;) {
      if (gXSortedObjects.next() === null) break;
      gXSortedObjects.removeCurrentObject();
    }

    const positions = [8, 2, 8, 0.5, 19, 2, 12];
    const foods: Food[] = [];
    for (let i = 0; i < 7; i++) {
      const f = new Food(st, 0, new Energy(100), positions[i]!, 0);
      f.setradius(0.25 * (i + 1));
      foods.push(f);
      gXSortedObjects.add(f);
    }
    dumpListOrder('objectlist.afterAdds', gXSortedObjects);
    pint('objectlist.count.food', gXSortedObjects.getCount(GObjectType.FOOD));
    pint('objectlist.count.agent', gXSortedObjects.getCount(GObjectType.AGENT));
    pint('objectlist.count.brick', gXSortedObjects.getCount(GObjectType.BRICK));
    pint('objectlist.count.any', gXSortedObjects.getCount(GObjectType.ANY));

    gXSortedObjects.removeObjectWithLink(foods[2]!);
    dumpListOrder('objectlist.afterRemoveWithLink', gXSortedObjects);

    gXSortedObjects.reset();
    for (;;) {
      const o = gXSortedObjects.nextObj(GObjectType.FOOD);
      if (o === null) break;
      if (o.x() === 8) gXSortedObjects.removeCurrentObject();
    }
    dumpListOrder('objectlist.afterWalkRemove', gXSortedObjects);
    pint('objectlist.count.food.final', gXSortedObjects.getCount(GObjectType.FOOD));
    pint('objectlist.count.any.final', gXSortedObjects.getCount(GObjectType.ANY));

    expect(mismatches).toEqual([]);
  });

  it('part 8/9: the x-sorted object list — sort()', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = WORLD_SIZE;
    const st = FoodType.lookup('Standard')!;

    // `objectxsortedlist::sort()` runs unconditionally every step of `Interact` on a list
    // whose keys went stale when the agents moved. Each fixture inserts ascending keys 1..n
    // (so `add` keeps insertion order), rewrites every key in place, then runs two passes —
    // the second must be a no-op and must leave the same cursor.
    const runSortFixture = (name: string, xAfter: readonly number[], radii: readonly number[]): void => {
      gXSortedObjects.reset();
      for (;;) {
        if (gXSortedObjects.next() === null) break;
        gXSortedObjects.removeCurrentObject();
      }

      const objs: Food[] = [];
      for (let i = 0; i < xAfter.length; i++) {
        const f = new Food(st, 0, new Energy(100), i + 1, 0);
        f.setradius(0);
        objs.push(f);
        gXSortedObjects.add(f);
      }
      dumpListOrder(`${name}.before`, gXSortedObjects);

      for (let i = 0; i < objs.length; i++) {
        objs[i]!.setradius(radii[i]!);
        objs[i]!.setx(xAfter[i]!);
      }
      for (let i = 0; i < objs.length; i++) {
        p32(`${name}.staleKey.${i}`, objs[i]!.x() - objs[i]!.radius());
      }

      for (let pass = 1; pass <= 2; pass++) {
        gXSortedObjects.sort();
        const pre = `${name}.after${pass}`;
        dumpCursor(pre, gXSortedObjects);
        dumpListOrder(pre, gXSortedObjects);
      }
      pint(`${name}.count.food`, gXSortedObjects.getCount(GObjectType.FOOD));
      pint(`${name}.count.any`, gXSortedObjects.getCount(GObjectType.ANY));
    };

    // A. one node moves back past three others; B. fully reversed (every node relocates and
    // the deepest runs off the front — native's new-head branch); C. non-uniform radii, so
    // the key order and the `x` order differ; D. a realistic two-neighbour swap; E. already
    // sorted; F. the empty and one-element lists.
    runSortFixture('objectlist.sort.a', [5, 1, 2, 7, 3, 0.5, 4], [0, 0, 0, 0, 0, 0, 0]);
    runSortFixture('objectlist.sort.b', [7, 6, 5, 4, 3, 2, 1], [0, 0, 0, 0, 0, 0, 0]);
    runSortFixture('objectlist.sort.c', [2, 6, 1, 4, 7, 3], [1, 0.5, 0.25, 0.75, 0.5, 1.5]);
    runSortFixture('objectlist.sort.d', [1, 3, 2, 4, 5, 7, 6], [0, 0, 0, 0, 0, 0, 0]);
    runSortFixture('objectlist.sort.e', [1, 2, 2.5, 4, 5, 6, 7], [0, 0, 0, 0, 0, 0, 0]);
    runSortFixture('objectlist.sort.empty', [], []);
    runSortFixture('objectlist.sort.one', [4], [0]);

    expect(mismatches).toEqual([]);
  });

  it('part 9/9: the x-sorted object list — a radius only the accessor exposes', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = WORLD_SIZE;

    // The list's key is `x() - radius()`: the native **accessor**, not a radius field. These
    // objects have no radius field at all, so a field read gives `NaN`, `NaN < NaN` is false,
    // `add()` appends unconditionally and `sort()` never relocates a node. That is the failure
    // the whole `objectlist.accessor.*` section exists to catch.
    gXSortedObjects.reset();
    for (;;) {
      if (gXSortedObjects.next() === null) break;
      gXSortedObjects.removeCurrentObject();
    }

    // (a) `add()`: keys 4.5, 0.75, 1.5, -1.5, 7.875, 2.0 in insertion order, and an `x` order
    // (0.5, 1, 2, 3, 5, 8) that is a different order.
    const xs = [5, 1, 3, 0.5, 8, 2];
    const rs = [0.5, 0.25, 1.5, 2, 0.125, 0];
    for (let i = 0; i < xs.length; i++) {
      addAccessorObject(new AccessorRadiusObject(xs[i]!, rs[i]!, i + 1));
    }
    dumpListOrder('objectlist.accessor.adds', gXSortedObjects);
    pint('objectlist.accessor.count.agent', gXSortedObjects.getCount(GObjectType.AGENT));
    pint('objectlist.accessor.count.any', gXSortedObjects.getCount(GObjectType.ANY));

    gXSortedObjects.reset();
    for (let i = 0; ; i++) {
      const o = gXSortedObjects.next();
      if (o === null) break;
      p32(`objectlist.accessor.key.${i}`, o.x() - o.radius());
    }

    // (b) `sort()` over the same accessor-shaped objects: keys 1..6 on insertion (so `add`
    // keeps insertion order), then every key rewritten in place — one step of motion — with
    // two passes, as in part 8.
    gXSortedObjects.reset();
    for (;;) {
      if (gXSortedObjects.next() === null) break;
      gXSortedObjects.removeCurrentObject();
    }

    const objs: AccessorRadiusObject[] = [];
    for (let i = 0; i < 6; i++) {
      const o = new AccessorRadiusObject(i + 1, 0, i + 1);
      objs.push(o);
      addAccessorObject(o);
    }
    dumpListOrder('objectlist.accessor.sort.before', gXSortedObjects);

    const xAfter = [5, 1, 2, 7, 3, 0.5];
    const rAfter = [0.5, 0.75, 0, 1.25, 2, 0.25];
    for (let i = 0; i < objs.length; i++) {
      objs[i]!.setradius(rAfter[i]!);
      objs[i]!.setx(xAfter[i]!);
    }
    for (let i = 0; i < objs.length; i++) {
      p32(`objectlist.accessor.sort.staleKey.${i}`, objs[i]!.x() - objs[i]!.radius());
    }

    for (let pass = 1; pass <= 2; pass++) {
      gXSortedObjects.sort();
      const pre = `objectlist.accessor.sort.after${pass}`;
      dumpCursor(pre, gXSortedObjects);
      dumpListOrder(pre, gXSortedObjects);
    }
    pint('objectlist.accessor.sort.count.agent', gXSortedObjects.getCount(GObjectType.AGENT));
    pint('objectlist.accessor.sort.count.any', gXSortedObjects.getCount(GObjectType.ANY));

    expect(mismatches).toEqual([]);
  });

  it('consumed every value the native probe emitted', () => {
    const unconsumed = [...allGoldenKeys].filter((k) => !consumed.has(k));
    expect(unconsumed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the recorded run: barrier rows from the oracle's own collisions.log
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globalRngSurface } from '../src/model/rng';

function multiplierEquals(a: EnergyMultiplier, b: EnergyMultiplier): boolean {
  for (let i = 0; i < globals.numEnergyTypes; i++) {
    if (Math.abs(a.get(i) - b.get(i)) > 0.00001) return false;
  }
  return true;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface LogRows {
  header: string[];
  rows: string[][];
}

function readDatalib(path: string): LogRows {
  const lines = readFileSync(path, 'utf8').split('\n');
  let header: string[] = [];
  const rows: string[][] = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#<')) {
      started = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#@L')) header = splitColumns(line.slice(3));
      if (started) break;
      continue;
    }
    if (line.trim() === '') continue;
    rows.push(line.split('\t'));
  }
  return { header, rows };
}

function splitColumns(text: string): string[] {
  return text.split(/[ \t]+/).filter((c) => c !== '');
}

/**
 * Read a normalized worldfile's `Key Value` leaves. The oracle's `normalized.wf` is a nested
 * property document, but every key this lane needs is unique, so the leaves are collected flat.
 */
function readWorldfile(path: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s+(-?[0-9.eE+-]+)\s*$/.exec(raw.replace(/\r$/, ''));
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

describe('L10 environment — the recorded golden run', () => {
  const runDir = join(repoRoot, 'oracle', 'minitest_voff', 'run');

  it("builds the worldfile's two barriers at the coordinates the run used", () => {
    // `run/normalized.wf`: `WorldSize 25`, `RatioBarrierPositions True`, and two barriers with
    // `X1 = X2 = 0.3333 / 0.6667`, `Z1 = -1.0`, `Z2 = -0.1` (all *ratios*), i.e. absolute
    // `x = 8.3325 / 16.6675`, `z` from `-25` to `-2.5`.
    const b0 = barrierFromRatios(0.3333, -1.0, 0.3333, -0.1);
    // The ratio is a `float` in native and `WorldSize` is a `float`, so the scaling is
    // `f32( f32(0.3333) * 25 )` — not `f32( 0.3333 * 25 )`, which is one ulp away.
    expect(b0.xmin()).toBe(f32(f32(0.3333) * 25));
    expect(b0.xmax()).toBe(f32(f32(0.3333) * 25));
    expect(b0.zmin()).toBe(-25);
    expect(b0.zmax()).toBe(f32(-0.1 * 25));
    // A vertical barrier's normal is (1, 0) up to the sign convention `sna`/`cosa` encode:
    // `sina` is 0 and `cosa` is exactly 1, and the signed distance is `+-(x - 8.3325)` up to
    // the rounding of `a*f` and `b*f` (a few ulps, not exact).
    expect(b0.sina()).toBe(0);
    expect(b0.cosa()).toBe(1);
    const bx0 = f32(f32(0.3333) * 25);
    expect(f32UlpDistance(Math.abs(b0.dist(9.3325, -12)), f32(9.3325) - bx0)).toBeLessThanOrEqual(4);
    expect(f32UlpDistance(Math.abs(b0.dist(-3.25, -25)), Math.abs(f32(-3.25) - bx0))).toBeLessThanOrEqual(4);

    const b1 = barrierFromRatios(0.6667, -1.0, 0.6667, -0.1);
    expect(b1.xmin()).toBe(f32(f32(0.6667) * 25));
    expect(b1.zmax()).toBe(f32(-0.1 * 25));
    const bx1 = f32(f32(0.6667) * 25);
    expect(f32UlpDistance(Math.abs(b1.dist(15.6675, -12)), Math.abs(f32(15.6675) - bx1))).toBeLessThanOrEqual(4);
    // The two barriers the probe pinned for this worldfile (see `barrier.ratio.recorded0.*`
    // and `barrier.ratio.recorded1.*` in the golden) agree with these.
    expect(f32Bits(b0.dist(8.3325, -12))).toBe(parseInt(GOLDEN_F32['barrier.ratio.recorded0.dist.1']!, 16));
    expect(f32Bits(b1.dist(16.6675, -2.5))).toBe(parseInt(GOLDEN_F32['barrier.ratio.recorded1.dist.3']!, 16));
  });

  it('every `barrier` row in collisions.log lies inside the barrier x-window', () => {
    const b0 = barrierFromRatios(0.3333, -1.0, 0.3333, -0.1);
    const b1 = barrierFromRatios(0.6667, -1.0, 0.6667, -0.1);
    const barriers = [b0, b1];

    const collisions = readDatalib(join(runDir, 'events', 'collisions.log'));
    const positions = readPositions(join(runDir, 'motion', 'position', 'agents'));

    // The largest agent "carry radius" the worldfile allows: `sim/Simulation.cc:319-325`
    // (maxagentlenx = MaxAgentSize / sqrt(MinAgentMaxSpeed), maxagentlenz = MaxAgentSize *
    // sqrt(MaxAgentMaxSpeed), radius = 0.5 * hypot(...)), times `agent.cc`'s Fudge Factor 1.01.
    // All three inputs are read from the run's own `normalized.wf` rather than hard-coded, so
    // this is native's predicate for *this* scenario and not a looser one: the earlier
    // hard-coded `MaxAgentMaxSpeed 2.0` made the window 2.020 instead of the native 1.8895.
    // (The chain is computed in double here; native stores it in float and the two agree to a
    // few ulps — ~1e-7 against the 0.1 the observed worst case leaves free.)
    const wf = readWorldfile(join(runDir, 'normalized.wf'));
    const FF = 1.01;
    const maxAgentSize = wf.get('MaxAgentSize')!;
    const minMaxSpeed = wf.get('MinAgentMaxSpeed')!;
    const maxMaxSpeed = wf.get('MaxAgentMaxSpeed')!;
    expect([maxAgentSize, minMaxSpeed, maxMaxSpeed]).toEqual([2, 0.5, 1.5]);
    const maxRadius =
      0.5 * Math.sqrt((maxAgentSize / Math.sqrt(minMaxSpeed)) ** 2 + (maxAgentSize * Math.sqrt(maxMaxSpeed)) ** 2);
    const window = FF * maxRadius;

    let barrierRows = 0;
    let checked = 0;
    let worst = 0;
    const farRows: string[] = [];
    for (const row of collisions.rows) {
      if (row[2] !== 'barrier') continue;
      barrierRows++;
      const step = Number(row[0]);
      const agent = Number(row[1]);
      const pos = positions.get(agent)?.get(step);
      if (pos === undefined) continue;
      checked++;
      const nearest = Math.min(...barriers.map((b) => Math.abs(b.dist(pos[0], pos[1]))));
      worst = Math.max(worst, nearest);
      if (nearest > window) farRows.push(`step ${step} agent ${agent} |dist|=${nearest.toFixed(4)}`);
    }

    // The run logged 1,490 barrier collisions; every one of them must sit within the
    // x-window `agent::UpdateBody` uses, computed from THIS lane's barrier geometry.
    expect(barrierRows).toBe(1490);
    expect(checked).toBe(barrierRows);
    expect(farRows).toEqual([]);
    expect(worst).toBeLessThanOrEqual(window);

    // Negative control: the same predicate is false for the run's `edge` rows that are far
    // from any barrier, so the test above is not vacuously true.
    const edgeFar = collisions.rows.filter((row) => {
      if (row[2] !== 'edge') return false;
      const pos = positions.get(Number(row[1]))?.get(Number(row[0]));
      if (pos === undefined) return false;
      return Math.min(...barriers.map((b) => Math.abs(b.dist(pos[0], pos[1])))) > window;
    });
    expect(edgeFar.length).toBeGreaterThan(100);
  });

  it('the food-energy columns name this lane\'s food types, in definition order', () => {
    // `run/energy/food.txt` is written by `Logs::FoodEnergyLog::init`, which takes its column
    // names from `FoodType::get( i )->name` for i in [0, getNumberDefinitions()).
    const foodEnergy = readDatalib(join(runDir, 'energy', 'food.txt'));
    expect(foodEnergy.header[0]).toBe('Timestep');

    FoodType.resetRegistry();
    FoodType.define('Standard', { r: 0.5, g: 0.5, b: 0.5 }, new EnergyPolarity(), EnergyMultiplier.fromNumbers([1]), new Energy(0.1));
    const columns = [foodEnergy.header[0]!];
    for (let i = 0; i < FoodType.getNumberDefinitions(); i++) columns.push(FoodType.get(i).name);
    expect(columns).toEqual(foodEnergy.header);

    // And the consumption log's `FoodType` token must be one of those names.
    const consumption = readDatalib(join(runDir, 'energy', 'consumption.txt'));
    const tokens = new Set(consumption.rows.map((r) => r[2]));
    for (const token of tokens) expect(columns).toContain(token);

    // Step 0's total food energy is a float sum over the initial food population, and *that*
    // population is the simulation's (`sim/Simulation.cc` `InitFood`), so lane L11 is the one
    // that can reproduce the number. What this lane owns and pins here is the column shape and
    // the registry order above. The measured value is 5395.159668 at step 0 (and the run's
    // `MinFoodEnergy`/`MaxFoodEnergy` are 200/1000, so it implies at least six food objects).
    const zeroRow = foodEnergy.rows.find((r) => r[0] === '0');
    expect(zeroRow).toBeDefined();
    const total = Number(zeroRow![1]);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(200);
    expect(Number.isInteger(total / 200)).toBe(false); // not a whole number of minima
  });
});

// --- small helpers for the recorded-run section -----------------------------

let lastBarrier!: Barrier;

function barrierFromRatios(xa: number, za: number, xb: number, zb: number): Barrier {
  Barrier.gBarrierHeight = 5;
  Barrier.gRatioPositions = true;
  globals.worldsize = 25;
  const b = new Barrier();
  b.getPosition().xa = xa;
  b.getPosition().za = za;
  b.getPosition().xb = xb;
  b.getPosition().zb = zb;
  b.init();
  lastBarrier = b;
  return b;
}

function readPositions(dir: string): Map<number, Map<number, [number, number]>> {
  const out = new Map<number, Map<number, [number, number]>>();
  const files = readdirSync(dir);
  for (const file of files) {
    if (!file.startsWith('position_')) continue;
    const agent = Number(file.slice('position_'.length, -'.txt'.length));
    const { rows } = readDatalib(join(dir, file));
    const byStep = new Map<number, [number, number]>();
    for (const row of rows) byStep.set(Number(row[0]), [Number(row[1]), Number(row[2])]);
    out.set(agent, byStep);
  }
  return out;
}

import { readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The `food( ft, step )` energy draw's dropped `f32(Max - Min)` narrowing
// (t_97ec04fa — the contraction sweep t_981fcace's follow-up; see `PARITY.md` ->
// *the contraction sweep* -> *Residual*, second bullet).
//
// `__ZN4food8initfoodEPK8FoodTypel` (`0x5ac38`) narrows the **difference** to `float`
// *before* widening it back to `double` — and `__ZN4foodC2EPK8FoodTypel` (`0x5ab08`)
// inlines the identical five instructions:
//
//   5ac70:  fsub   s1, s1, s2          ; s1 = f32( gMaxFoodEnergy - gMinFoodEnergy )
//   5ac74:  fcvt   d1, s1              ; widen *that float* to double
//   5ac78:  fcvt   d2, s2              ; widen gMinFoodEnergy to double (exact)
//   5ac7c:  fmadd  d0, d0, d1, d2      ; randpw() * d1 + d2 — ONE double rounding
//   5ac80:  fcvt   s0, d0              ; narrow the result to float
//
// (the constructor's copies are `0x5ab94`/`0x5ab98`/`0x5ab9c`/`0x5aba0`/`0x5aba4`.)
// So native is `f32( randpw() * (double)f32(Max - Min) + (double)Min )`.
//
// The port computed the difference in **binary64**, so the multiply's factor differed
// from the binary's at ~2^-24 *relative* — a wrong operand, not the ≤2^-53
// double-contraction class PARITY.md's residual section covers. `food.ts` now narrows it;
// this block is the pin.
//
// The expected bits are an **independent** reference, not a port re-derivation:
// `gen_food_pin.py` (this card's workspace) evaluates the whole chain in exact rational
// arithmetic (`Fraction` + explicit round-to-nearest-ties-to-even to binary32/binary64)
// from the same three inputs and prints the literals pinned here. `native` is the exact
// rational value of native's *fused* form, and the generator only emits a case when it
// also equals the fixed port's two-rounding form — so each case below separates the
// **operand** and nothing else. `preFix` is the exact-rational value of the pre-fix
// operand: a revert fails here.
//
// Shape of the defect, worth knowing before adding cases: the exact difference of two
// `float`s is *often* representable in binary32 (nearby exponents cancel into trailing
// zeros), so `f32(Max - Min)` only differs from the binary64 difference when the two are
// far apart in magnitude — 0.1/1000 differs, 200/1000 does not.
// ---------------------------------------------------------------------------

type FoodEnergyDrawCase = {
  /** Native's `gMinFoodEnergy` / `gMaxFoodEnergy`, as `float` bit patterns. */
  minBits: number;
  maxBits: number;
  /** The pinned `drand48()` return (native's `randpw()`), as a double's bits. */
  rBits: bigint;
  /**
   * `f32( f64( r * d1 + d2 ) )` with `d1 = (double)f32(Max - Min)` — native's own value.
   * The generator only emits a case when this also equals the *two-rounding* fixed port,
   * so the case separates the operand and nothing else.
   */
  native: number;
  /** The same three inputs with `d1 = Max - Min` in binary64 — what a revert produces. */
  preFix: number;
};

const FOOD_ENERGY_DRAW_CASES: FoodEnergyDrawCase[] = [
  // MinFoodEnergy 0.1 / MaxFoodEnergy 1000 — a 13-exponent gap, so the exact difference
  // needs more than binary32's 24 significant bits (`f32(Max-Min)` = 999.900024…, the
  // binary64 one is 999.800024…)
  { minBits: 0x3dcccccd, maxBits: 0x447a0000, rBits: 0x3fe62ae1677f3ee0n, native: 0x442d30f9, preFix: 0x442d30f8 },
  // MinFoodEnergy 0.01 / MaxFoodEnergy 1000 — the same shape, 17 exponents apart
  { minBits: 0x3c23d70a, maxBits: 0x447a0000, rBits: 0x3fe7dac53acfc460n, native: 0x443a5d4e, preFix: 0x443a5d4f },
  // MinFoodEnergy 0.2 / MaxFoodEnergy 1024
  { minBits: 0x3e4ccccd, maxBits: 0x44800000, rBits: 0x3fe7bf0dcbf86620n, native: 0x443dfbbb, preFix: 0x443dfbbc },
  // MinFoodEnergy 0.7 / MaxFoodEnergy 9.3 — only four exponents apart, and still inexact
  { minBits: 0x3f333333, maxBits: 0x4114cccd, rBits: 0x3fba6b76783b9600n, native: 0x3fcb347e, preFix: 0x3fcb347d },
  // MinFoodEnergy 0.3 / MaxFoodEnergy 3.3 — the binary64 difference is 2.99999994…, which
  // `0x5ac70`'s `fsub` rounds to a clean 3.0f (0x40400000)
  { minBits: 0x3e99999a, maxBits: 0x40533333, rBits: 0x3fe603288db425c0n, native: 0x40174627, preFix: 0x40174626 },
];

describe('L10 environment — the food energy draw keeps native’s f32(Max - Min) (t_97ec04fa)', () => {
  it('no recorded scenario can be moved by the fix (their difference is exact)', () => {
    // Every recorded scenario's worldfile sets MinFoodEnergy 200.0 / MaxFoodEnergy 1000.0
    // (`oracle/*/run/normalized.wf`); both are exactly representable and so is their
    // difference (800), so `0x5ac70`'s `fsub` is lossless there and the binary64 and
    // binary32 operands are the *same* value. That is why this fix cannot move `oracle/**`,
    // and it is checked empirically as well: a full `microtest_voff` candidate built before
    // the change and one built after produced byte-identical `run/` trees, with
    // `oracle/run_parity.sh` reporting PASS (225/225 files) both times.
    const min = fromBits32(0x43480000); // 200.0f
    const max = fromBits32(0x447a0000); // 1000.0f
    expect(max).toBe(1000);
    expect(min).toBe(200);
    expect(f32(max - min)).toBe(max - min);
  });

  it('narrows the difference before widening it (live Food ctor, 0x5ab94/0x5ac70)', () => {
    globals.numEnergyTypes = 1;
    globals.worldsize = 100;
    Food.gFoodHeight = 1;
    Food.gSize2Energy = 300;
    Food.gMaxFoodRadius = 1.5;
    const foodType = { color: { r: 0, g: 0, b: 0 } } as unknown as FoodType;

    for (const c of FOOD_ENERGY_DRAW_CASES) {
      const min = fromBits32(c.minBits);
      const max = fromBits32(c.maxBits);
      const r = fromBits64(c.rBits);
      const label = `Min=${hex32(c.minBits)} Max=${hex32(c.maxBits)} r=${c.rBits.toString(16)}`;

      // non-vacuity: the two operands separate on this case, so a revert lands on `preFix`
      // (an exact-rational value, not a port re-derivation) rather than on `native`
      expect(hex32(c.native), `${label}: case is vacuous`).not.toBe(hex32(c.preFix));

      Food.gMinFoodEnergy = min;
      Food.gMaxFoodEnergy = max;
      const rng: RngSurface = {
        srand: () => {},
        rand: () => 0,
        srand48: () => {},
        drand48: () => r,
        lrand48: () => 0,
        nrand: () => 0,
        nrandScaled: () => 0,
      };
      // `energy === undefined` is native's `food( ft, step )` -> `initfood( ft, step )`,
      // the only construction path that draws the energy.
      const food = new Food(foodType, 0, undefined, undefined, undefined, rng);
      expect(hex32(f32Bits(food.getEnergy().mean())), `${label}: live draw`).toBe(hex32(c.native));

      // the same three inputs through the pre-fix expression, as the live code would have
      // evaluated it: the bits a revert produces
      const preFixValue = f32(r * (max - min) + min);
      expect(hex32(f32Bits(preFixValue)), `${label}: pre-fix expression`).toBe(hex32(c.preFix));
    }
  });
});

const pinF32 = new DataView(new ArrayBuffer(4));
const pinF64 = new DataView(new ArrayBuffer(8));

function fromBits32(bits: number): number {
  pinF32.setUint32(0, bits >>> 0);
  return pinF32.getFloat32(0);
}

function fromBits64(bits: bigint): number {
  pinF64.setBigUint64(0, bits);
  return pinF64.getFloat64(0);
}
