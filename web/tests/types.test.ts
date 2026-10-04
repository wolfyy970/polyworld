/**
 * Lane W1a — src/model/types: the frozen shared surface.
 *
 * Two kinds of assertion:
 *
 *  1. Semantics. The coercions and lookups are checked against the behavior read out of
 *     `../polyworld/src/library/proplib/dom.cc` (strtol/strtof/toBool corner cases, strcmp
 *     child order), because those are what a lane will otherwise get "almost right".
 *  2. Oracle anchors. When the recorded goldens are present (`oracle/microtest_voff/run/`,
 *     gitignored: point `POLYWORLD_ORACLE_ROOT` at the canonical ones from a worktree) the
 *     frozen tables are checked against the files the native build actually wrote — the
 *     reason names in `lifespans.txt`, the datalib header tokens, the `collisions.log`
 *     object-type tokens, and the spelling/value of the worldfile keys the fixtures use.
 *     Goldens are only ever read.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BIRTH_REASON_NAMES,
  BirthReason,
  CARRY_ACTION_NAMES,
  COLUMN_TYPE_NAMES,
  CarryAction,
  ColumnType,
  ConcreteFileType,
  Config,
  ConfigError,
  DATALIB_COLUMN_NAMES_PREFIX,
  DATALIB_COLUMN_TYPES_PREFIX,
  DATALIB_COLFORMAT_NONE,
  DATALIB_COLFORMAT_PREFIX,
  DATALIB_SCHEMA_PREFIX,
  DATALIB_SCHEMA_SINGLE,
  DATALIB_SIGNATURE,
  DATALIB_VERSION_PREFIX,
  DATALIB_VERSION_WRITE,
  DEATH_REASON_NAMES,
  DeathReason,
  Event_AgentBirth,
  Event_SimEnd,
  Event_SimInited,
  Event_StepEnd,
  GObjectType,
  MATE_DESIRED,
  MATE_PREVENTED_PARTNER,
  OBJECT_TYPE_NAMES,
  ObjectType,
  arrayNode,
  birthReasonName,
  columnTypeName,
  compareIdentifier,
  createConfig,
  deathReasonName,
  documentFromJs,
  documentNode,
  globals,
  nativeBool,
  nativeFloat,
  nativeInt,
  objectNode,
  resetGlobals,
  scalarNode,
  type MemoryValue,
  type SimEvent,
} from '../src/model/types';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const oracleRoot = process.env.POLYWORLD_ORACLE_ROOT ?? path.join(repoRoot, 'oracle');
const scenarioRun = path.join(oracleRoot, 'microtest_voff', 'run');
const goldensAvailable = existsSync(path.join(scenarioRun, 'normalized.wf'));

describe('scalar coercion — native strtol (__ScalarProperty::toInt)', () => {
  it('parses base-10 integers the way strtol does', () => {
    expect(nativeInt('42')).toBe(42);
    expect(nativeInt('-7')).toBe(-7);
    expect(nativeInt('+7')).toBe(7);
    expect(nativeInt('  12')).toBe(12); // strtol skips leading whitespace
    expect(nativeInt('')).toBe(0); // no conversion, endptr == nptr == '\0' -> no error, value 0
  });

  it('rejects a value the parse does not consume whole', () => {
    expect(() => nativeInt('1.0')).toThrow(ConfigError); // a float read as an int is fatal in native
    expect(() => nativeInt('12 ')).toThrow(/Expecting integer\./);
    expect(() => nativeInt('0x10')).toThrow(/Expecting integer\./);
    expect(() => nativeInt(' ')).toThrow(/Expecting integer\./); // all-whitespace: endptr = nptr != '\0'
    expect(() => nativeInt('abc')).toThrow(/Expecting integer\./);
  });

  it('truncates through the (int) cast like x86-64 gcc', () => {
    expect(nativeInt('2147483648')).toBe(-2147483648);
    expect(nativeInt('4294967295')).toBe(-1);
    // LONG_MAX: strtol clamps (ERANGE, ignored) and the (int) cast keeps the low 32 bits.
    expect(nativeInt('9223372036854775807')).toBe(-1);
  });
});

describe('scalar coercion — native strtof ((float)strtof)', () => {
  it('rounds to float before the value is used', () => {
    expect(nativeFloat('1.0')).toBe(1);
    expect(nativeFloat('0.1')).toBe(Math.fround(0.1));
    expect(nativeFloat('0.1')).not.toBe(0.1); // f32 != f64: proof the value is stored as float
    expect(nativeFloat('1e3')).toBe(1000);
    expect(nativeFloat('-2.5e-1')).toBe(Math.fround(-0.25));
    expect(nativeFloat('.5')).toBe(0.5);
    expect(nativeFloat('5.')).toBe(5);
    expect(nativeFloat('')).toBe(0);
    expect(nativeFloat('inf')).toBe(Infinity);
    expect(nativeFloat('-infinity')).toBe(-Infinity);
    expect(Number.isNaN(nativeFloat('nan'))).toBe(true);
  });

  it('rejects a value the parse does not consume whole', () => {
    expect(() => nativeFloat('1.0x')).toThrow(/Expecting float\./);
    expect(() => nativeFloat('1.0 ')).toThrow(/Expecting float\./);
    expect(() => nativeFloat(' ')).toThrow(/Expecting float\./);
    expect(() => nativeFloat('1e')).toThrow(/Expecting float\./);
  });
});

describe('scalar coercion — native toBool', () => {
  it('accepts exactly four spellings', () => {
    expect(nativeBool('True')).toBe(true);
    expect(nativeBool('1')).toBe(true);
    expect(nativeBool('False')).toBe(false);
    expect(nativeBool('0')).toBe(false);
  });

  it('fails on every other spelling (native err( "Expecting bool." ))', () => {
    for (const bad of ['true', 'TRUE', 'FALSE', 'yes', 'True ', '2', '']) {
      expect(() => nativeBool(bad)).toThrow(/Expecting bool\./);
    }
  });
});

describe('property document — native map semantics', () => {
  it('orders children by strcmp on the identifier, not numerically', () => {
    const twelve = arrayNode(
      'FoodTypes',
      Array.from({ length: 12 }, (_unused, i) => scalarNode('Standard', String(i))),
    );
    expect(twelve.elements().map((element) => element.name)).toEqual([
      '0',
      '1',
      '10',
      '11',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('looks an array element up by index and by its decimal name', () => {
    const array = arrayNode('Barriers', [scalarNode('X1', '1'), scalarNode('X1', '2'), scalarNode('X1', '3')]);
    expect(array.get(2).scalarText()).toBe('3');
    expect(array.get('2').scalarText()).toBe('3');
    expect(array.size()).toBe(3);
    expect(compareIdentifier(10, 2)).toBeLessThan(0); // "10" < "2"
  });

  it('fails the way native fails', () => {
    const object = objectNode('Sheets', [scalarNode('CrossoverProbability', '0.5')]);
    expect(() => object.get('Missing')).toThrow(/No such property: 'Missing'/);
    expect(() => object.elements()[0]!.elements()).toThrow(/Invalid request for properties\./);
    expect(() => object.scalarText()).toThrow(/Expecting String/);
    expect(() => objectNode('Sheets', [scalarNode('X', '1'), scalarNode('X', '2')])).toThrow(
      /Duplicate property name 'X'/,
    );
  });
});

describe('Config accessors — the native doc.get( "Name" ) idiom', () => {
  // Keys, spellings and nesting follow the recorded `run/normalized.wf` (anchored below).
  // Numbers are the *evaluated* values proplib produces, e.g. the two Barriers in microtest
  // come from `( 0.3333 if RatioBarrierPositions else (0.3333 * WorldSize) )` with
  // `WorldSize 25` and `RatioBarrierPositions True`.
  const worldfile: { readonly [name: string]: MemoryValue } = {
    Vision: 'False',
    MaxVelocity: '1.0',
    NumEnergyTypes: '1',
    Edges: 'B',
    WorldSize: '25',
    CompressFiles: 'True',
    FoodTypes: [
      { Name: 'Standard', EnergyPolarity: ['1'], EatMultiplier: ['1'] },
    ],
    AgentMetabolisms: [
      {
        Name: 'Null',
        CarcassFoodTypeMode: 'FindEnergyPolarity',
        CarcassFoodTypeName: 'Standard',
        MinEatAge: '0',
        EnergyDelta: ['0'],
      },
    ],
    AgentMetabolismSelectionMode: 'Gene',
    Barriers: [
      { X1: '8.3325', Z1: '-25', X2: '8.3325', Z2: '-2.5' },
      { X1: '16.6675', Z1: '-25', X2: '16.6675', Z2: '-2.5' },
    ],
    Domains: [
      {
        CenterX: '0.5',
        CenterZ: '0.5',
        SizeX: '1.0',
        SizeZ: '1.0',
        FoodPatches: [{ FoodFraction: '0.2', FoodTypeName: 'Standard' }],
      },
    ],
  };
  const doc = documentFromJs(worldfile, 'run/normalized.wf');
  const cfg = createConfig(doc);

  it('reads scalars with the native coercions', () => {
    expect(cfg.getBool('Vision')).toBe(false);
    expect(cfg.getFloat('MaxVelocity')).toBe(1);
    expect(cfg.getInt('NumEnergyTypes')).toBe(1);
    expect(cfg.getString('Edges')).toBe('B');
    expect(cfg.getInt('WorldSize')).toBe(25);
    expect(cfg.getBool('CompressFiles')).toBe(true);
  });

  it('walks nested arrays and objects', () => {
    expect(cfg.getString('AgentMetabolismSelectionMode')).toBe('Gene');
    const foodTypes = cfg.getArray('FoodTypes').map((type) => createConfig(type).getString('Name'));
    expect(foodTypes).toEqual(['Standard']);
    expect(createConfig(cfg.getArray('FoodTypes')[0]!).getArray('EnergyPolarity')).toHaveLength(1);

    const barriers = cfg.getArray('Barriers').map((barrier) => createConfig(barrier));
    expect(barriers.map((barrier) => barrier.getFloat('Z1'))).toEqual([-25, -25]);

    // Object -> array -> object -> scalar, three levels deep (Domains[0].FoodPatches[0]).
    const domain = createConfig(cfg.getArray('Domains')[0]!);
    const patch = createConfig(domain.getArray('FoodPatches')[0]!);
    expect(patch.getFloat('FoodFraction')).toBe(Math.fround(0.2));
    expect(patch.getString('FoodTypeName')).toBe('Standard');
  });

  it('is strict: no defaults, no lenient parsing', () => {
    expect(() => cfg.getFloat('NotAProperty')).toThrow(/No such property: 'NotAProperty'/);
    expect(() => cfg.getInt('MaxVelocity')).toThrow(/Expecting integer\./); // "1.0" is not an int
    expect(() => cfg.getBool('MaxVelocity')).toThrow(/Expecting bool\./);
    expect(() => cfg.getArray('Vision')).toThrow(/Invalid request for properties\./);
    expect(() => cfg.getFloat('Barriers')).toThrow(/Expecting Float/); // array element object is not a scalar
  });

  it('offers the optional read path (native getp) for genuinely optional properties', () => {
    expect(cfg.has('Vision')).toBe(true);
    expect(cfg.has('NotAProperty')).toBe(false);
    expect(cfg.find('NotAProperty')).toBeUndefined();
    expect(new Config(scalarNode('root', '1')).has('x')).toBe(false);
  });
});

describe('globals singleton', () => {
  it('starts zero-initialized, like native statics before processWorldFile', () => {
    resetGlobals();
    expect(globals).toEqual({
      worldsize: 0,
      wraparound: false,
      blockedEdges: false,
      stickyEdges: false,
      numEnergyTypes: 0,
      recordFileType: ConcreteFileType.TYPE_UNDEFINED,
    });
  });

  it('is a shared mutable singleton', () => {
    resetGlobals();
    globals.worldsize = 100;
    globals.wraparound = true;
    globals.numEnergyTypes = 3;
    globals.recordFileType = ConcreteFileType.TYPE_GZIP_FILE;
    expect(globals.worldsize).toBe(100);
    expect(globals.wraparound).toBe(true);
    expect(globals.numEnergyTypes).toBe(3);
    expect(globals.recordFileType).toBe(2);
    resetGlobals();
  });
});

describe('event / lifecycle / sim constant tables', () => {
  it('uses native Event_* bit values', () => {
    expect(Event_SimInited).toBe(1 << 0);
    expect(Event_AgentBirth).toBe(1 << 1);
    expect(Event_StepEnd).toBe(1 << 14);
    expect(Event_SimEnd).toBe(1 << 16);
  });

  it('carries the reason names the logs write', () => {
    expect(BIRTH_REASON_NAMES).toHaveLength(6);
    expect(DEATH_REASON_NAMES).toHaveLength(9);
    expect(birthReasonName(BirthReason.SIMINIT)).toBe('SIMINIT');
    expect(birthReasonName(BirthReason.NATURAL)).toBe('NATURAL');
    expect(deathReasonName(DeathReason.SIMEND)).toBe('SIMEND');
    expect(deathReasonName(DeathReason.NATURAL)).toBe('NATURAL');
  });

  it('freezes the log token tables', () => {
    expect(OBJECT_TYPE_NAMES[ObjectType.AGENT]).toBe('agent');
    expect(OBJECT_TYPE_NAMES[ObjectType.BARRIER]).toBe('barrier');
    expect(OBJECT_TYPE_NAMES[ObjectType.EDGE]).toBe('edge');
    expect(CARRY_ACTION_NAMES[CarryAction.Pickup]).toBe('P');
    expect(CARRY_ACTION_NAMES[CarryAction.DropRecent]).toBe('D');
    expect(CARRY_ACTION_NAMES[CarryAction.DropObject]).toBe('Do');
    expect(COLUMN_TYPE_NAMES[ColumnType.STRING]).toBe('string');
    expect(columnTypeName(ColumnType.BOOL)).toBe('bool');
  });

  it('keeps the gobject bits and the sim ObjectType apart', () => {
    expect(GObjectType.AGENT).toBe(0x1);
    expect(GObjectType.FOOD).toBe(0x2);
    expect(GObjectType.BRICK).toBe(0x4);
    // The trap this records: gobject's AGENTTYPE and sim's ObjectType.FOOD are both 1.
    expect(GObjectType.AGENT).toBe(ObjectType.FOOD);
  });

  it('has distinct, usable contact status bits', () => {
    expect(MATE_DESIRED & MATE_PREVENTED_PARTNER).toBe(0);
    expect(MATE_DESIRED | MATE_PREVENTED_PARTNER).toBe(3);
  });

  it('narrows a SimEvent on its type tag', () => {
    const events: readonly SimEvent[] = [
      { type: Event_AgentBirth, a: null, reason: BirthReason.VIRTUAL, parent1: null, parent2: null },
      { type: Event_StepEnd },
    ];
    const described = events.map((event) => {
      switch (event.type) {
        case Event_AgentBirth:
          return `birth:${birthReasonName(event.reason)}:${event.a === null ? 'virtual' : 'real'}`;
        case Event_StepEnd:
          return 'step-end';
        default:
          return 'other';
      }
    });
    expect(described).toEqual(['birth:VIRTUAL:virtual', 'step-end']);
  });
});

describe.skipIf(!goldensAvailable)('oracle anchors — the recorded goldens (read-only)', () => {
  const read = (name: string): string => readFileSync(path.join(scenarioRun, name), 'utf8');

  it('matches the worldfile keys, values and blocks the config fixtures use', () => {
    const normalized = read('normalized.wf');
    const pairs: readonly (readonly [string, string])[] = [
      ['Vision', 'False'],
      ['MaxVelocity', '1.0'],
      ['NumEnergyTypes', '1'],
      ['Edges', 'B'],
      ['WorldSize', '25'],
      ['CompressFiles', 'True'],
      ['AgentMetabolismSelectionMode', 'Gene'],
    ];
    for (const [key, value] of pairs) {
      expect(normalized, `${key} ${value}`).toMatch(new RegExp(`^\\s*${key}\\s+${value}\\s*$`, 'm'));
    }
    // The containers the fixture mirrors: arrays of objects, and Domains[0].FoodPatches[].
    expect(normalized).toMatch(/^\s*FoodTypes\s*\[/m);
    expect(normalized).toMatch(/^\s*AgentMetabolisms\s*\[/m);
    expect(normalized).toMatch(/^\s*Barriers\s*\[/m);
    expect(normalized).toMatch(/^\s*Domains\s*\[/m);
    expect(normalized).toMatch(/^\s*FoodPatches\s*\[/m);
    expect(normalized).toMatch(/^\s*FoodTypeName\s+"Standard"/m);
    expect(normalized).toMatch(/^\s*Z1\s+/m);
  });

  it('builds the datalib header the datalib goldens actually contain', () => {
    for (const name of ['lifespans.txt', 'population.txt']) {
      const text = read(name);
      expect(text.startsWith(`${DATALIB_SIGNATURE}\n`), name).toBe(true);
      expect(text, name).toContain(`${DATALIB_VERSION_PREFIX}${DATALIB_VERSION_WRITE}\n`);
      expect(text, name).toContain(`${DATALIB_SCHEMA_PREFIX}${DATALIB_SCHEMA_SINGLE}\n`);
      expect(text, name).toContain(`${DATALIB_COLFORMAT_PREFIX}${DATALIB_COLFORMAT_NONE}\n`);
    }
    const lifespans = read('lifespans.txt');
    expect(lifespans).toContain(DATALIB_COLUMN_NAMES_PREFIX);
    expect(lifespans).toContain(DATALIB_COLUMN_TYPES_PREFIX);
    expect(lifespans).toContain(`${COLUMN_TYPE_NAMES[ColumnType.INT]} `);
    expect(lifespans).toContain(`${COLUMN_TYPE_NAMES[ColumnType.STRING]} `);
    // BirthsDeaths.log is *not* a datalib file: native writes it with plain fprintf.
    expect(read('BirthsDeaths.log').startsWith('% Timestep Event')).toBe(true);
  });

  it('uses only reason names the frozen tables declare', () => {
    const rows = read('lifespans.txt')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [, , birthReason, , deathReason] = row.split('\t');
      expect(BIRTH_REASON_NAMES, row).toContain(birthReason);
      expect(DEATH_REASON_NAMES, row).toContain(deathReason);
    }
  });

  it('uses only object-type tokens the frozen table declares', () => {
    const collisions = read(path.join('events', 'collisions.log'))
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(collisions.length).toBeGreaterThan(0);
    for (const row of collisions) {
      const [, , type] = row.split('\t');
      expect(OBJECT_TYPE_NAMES, row).toContain(type);
    }
  });
});
