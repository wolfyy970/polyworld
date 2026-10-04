/**
 * Lane L12 (logs) — semantics: the parts of the recorder layer the byte-exact replay cannot
 * reach, plus the artifacts whose *content* another lane owns.
 *
 * The replay corpus (`tests/logs-replay.test.ts`) proves the bytes of every artifact this lane
 * decides. This file covers:
 *
 *  1. the registry/`Logger` machinery — install order, event routing, state scopes, the
 *     `assert( false )` that a mis-registered logger hits;
 *  2. the **brain** recorders, whose file *contents* are lane L6's: the whole `run/brain/**`
 *     path set (87 function files incl. 23 never-finalised, 238 anatomy, 238 synapses, 89
 *     `Recent/<epoch>` links, 120 `bestRecent` and 308 `bestSoFar` links) is replayed from the
 *     goldens' own listings and compared as a set, with every link's bytes checked against its
 *     source;
 *  3. the recorders that are **off** in both recorded scenarios (`GenomeLog`, `GenomeMetaLog`,
 *     `GenomeSubsetLog`, `AdamiComplexityLog`, `GitRevisionLog`), exercised with synthetic
 *     events so their paths, triggers and formats are still pinned;
 *  4. the contact-flag decoder: every `events/contacts.log` row in the golden round-trips
 *     through the port's encoder.
 * Load, not slowness of the code: the heavy test here has been measured at 6.4 s with four
 * concurrent full suites against a 1252 ms solo baseline — past vitest's 5 s default, which is
 * what false-reds it. It carries LOAD_TIMEOUT_MS below; no assertion changed.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BirthReason,
  DeathReason,
  Event_AgentBirth,
  Event_AgentDeath,
  Event_AgentGrown,
  Event_BrainAnalysisBegin,
  Event_BrainAnalysisEnd,
  Event_BrainGrown,
  Event_BrainUpdated,
  Event_ContactBegin,
  Event_EpochEnd,
  Event_SimEnd,
  Event_SimInited,
  Event_StepEnd,
  GObjectType,
} from '../src/model/types';
import { ColumnType as DataLibColumnType } from '../src/model/types/datalib';
import { DataLibReader } from '../src/model/datalib';
import {
  AgentEnergyLog,
  GeneStatsLog,
  GenomeLog,
  GenomeMetaLog,
  GenomeSubsetLog,
  GitRevisionLog,
  Logs,
  SeparationLog,
  encodeContactInfo,
  maxOpenFiles,
  postEvent,
  registeredEventMask,
  resetRegistry,
} from '../src/model/logs';
import { AdamiComplexityLog, resetLogsSingletonForTests } from '../src/model/logs';
import { LearningMode, brainConfig } from '../src/model/brain/core';
import { ConcreteFileType } from '../src/model/types/datalib';
import { nodeRecordFileSystem } from '../src/model/logs/nodeFiles';
import { separationCache } from '../src/model/genome';
import { Golden } from './logsReplay';
import {
  FakeAgent,
  FakeFittestList,
  FakeFoodTypes,
  FakeGeneSchema,
  FakeGenomeUtil,
  FakeSimulation,
  FakeWorld,
  RecordedSeparations,
  decodeContactInfo,
  deriveFlags,
  flagsToConfig,
  freshDir,
  goldenContactRows,
  readLifespans,
} from './logsReplay';
import { CANDIDATE_ROOT, goldenRunRoot, listFiles } from './logsCorpus';

beforeEach(() => {
  // Native has exactly one `Logs` per process; a test file builds many.
  resetLogsSingletonForTests();
  resetRegistry();
});

const scenario = 'minitest_voff';
const golden = new Golden(goldenRunRoot(scenario));

/**
 * The recorded flags with every *other* recorder turned off, for unit tests that drive one
 * recorder: `Logs` always constructs all 23, and a recorder that recorded would receive the
 * events the test raises (`LifeSpanLog` and `GenomeMetaLog` have no worldfile flag).
 */
function minimalFlags(overrides: Partial<ReturnType<typeof deriveFlags>> = {}) {
  return {
    ...deriveFlags(golden),
    RecordAgentEnergy: false,
    RecordPosition: 'False',
    RecordBirthsDeaths: false,
    RecordCarry: false,
    RecordCollisions: false,
    RecordContacts: false,
    RecordEnergy: false,
    RecordFoodConsumption: false,
    RecordFoodEnergy: false,
    RecordGeneStats: false,
    RecordGenomes: false,
    RecordBrainAnatomy: false,
    RecordBrainFunction: false,
    RecordBrainRecent: false,
    RecordBrainBestRecent: false,
    RecordBrainBestSoFar: false,
    RecordSynapses: false,
    RecordPopulation: false,
    RecordSeparations: 'False',
    ...overrides,
  };
}

/** A `LogContext` over a scratch directory (the recorders write native-relative paths). */
function contextIn(dir: string, overrides: Partial<import('../src/model/logs').LogContext> = {}) {
  return {
    fs: nodeRecordFileSystem(ConcreteFileType.TYPE_GZIP_FILE),
    world: new FakeWorld(),
    // The schema the recorders read: a fake that reports the recorded `genestats.txt` header.
    genomeUtil: new FakeGenomeUtil(new FakeGeneSchema(2843)),
    foodTypes: new FakeFoodTypes(['Standard']),
    computeAdamiComplexity: () => undefined,
    ...overrides,
  };
}

/**
 * Vitest's default is 5 s, which this test has been measured past: 6.4 s with four concurrent
 * full suites against a 1252 ms solo baseline (2026-09-29, the load the fleet runs at). 60 s is
 * the budget the vision-on gate already carries (t_1f4a7a8a) — that measurement with room, and
 * still a guard: a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('L12 registry and Logger machinery', () => {
  it('installs the recorders in Logs.h declaration order and routes events by type', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-registry'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(deriveFlags(golden));
      const logs = new Logs(sim, doc, contextIn(dir));

      // `Logs::Logs` registers every recorder that records for this worldfile; the mask is the
      // OR of what they asked for.
      expect(registeredEventMask() & Event_StepEnd).toBe(Event_StepEnd);
      expect(registeredEventMask() & Event_AgentBirth).toBe(Event_AgentBirth);
      // `RecordBrainBestRecent`/`BestSoFar` are on in the recorded worldfile, so the brain
      // loggers register for epochs.
      expect(registeredEventMask() & Event_EpochEnd).toBe(Event_EpochEnd);
      expect(logs.getMaxOpenFiles()).toBeGreaterThan(0);

      // A logger that never registered for an event type must not receive it: `postEvent`
      // filters on the mask, and a registered-but-unhandled event hits the base `assert`.
      const before = listFiles(path.join(dir, 'run')).length;
      postEvent({ type: Event_EpochEnd, epoch: 100 });
      expect(listFiles(path.join(dir, 'run')).length).toBe(before);

      logs.dispose();
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('AdamiComplexityLog reports four open files whatever its scope', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-adami'));
    const log = new AdamiComplexityLog(contextIn(dir));
    // Not recording yet: native's base returns 0 before `initRecording`.
    expect(log.getMaxOpenFiles()).toBe(4); // the override is unconditional in native too
    void maxOpenFiles;
  });

  it('rejects an event a logger did not register for (native asserts)', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-assert'));
    resetRegistry();
    const log = new AgentEnergyLog(contextIn(dir));
    expect(() => log.processEvent({ type: Event_SimInited })).toThrow(/did not register/);
    resetRegistry();
  });
});

describe('L12 contact flag encoding', () => {
  it('round-trips every recorded contacts.log row', () => {
    const rows = goldenContactRows(golden);
    expect(rows.length).toBeGreaterThan(1000);

    const wrong: string[] = [];
    for (const row of rows) {
      const encoded = `${encodeContactInfo(row.c)}C${encodeContactInfo(row.d)}`;
      if (encoded !== row.raw) wrong.push(`${row.raw} -> ${encoded}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('decodes the same masks the types vocabulary names', () => {
    const info = decodeContactInfo('MdxF', 1);
    expect(info.mate).not.toBe(0);
    expect(info.fight).not.toBe(0);
    expect(info.give).toBe(0);
    expect(encodeContactInfo(info)).toBe('MdxF');
  });
});

describe('L12 brain recorders against the recorded run', () => {
  it('reproduces the whole run/brain path set, links included', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, `${scenario}-brain`));
    const runDir = path.join(dir, 'run');
    const previous = process.cwd();

    const flags = deriveFlags(golden);
    const doc = flagsToConfig(flags);
    const sim = new FakeSimulation();
    const world = new FakeWorld();
    const env = contextIn(dir, { world });

    resetRegistry();

    try {
      process.chdir(dir);

      const logs = new Logs(sim, doc, env);
      const agents = readLifespans(golden);
      const fakeAgents = new Map<number, FakeAgent>();
      for (const number of [...agents.keys()].sort((a, b) => a - b)) {
        fakeAgents.set(number, new FakeAgent(number, number, new RecordedSeparations()));
      }

      // `LearningMode All` in the recorded worldfile opens both gates (incept + death dumps).
      brainConfig.learningMode = LearningMode.LEARN_ALL;

      // Agent construction: `BrainGrown` (incept) then `AgentGrown` (birth + function start).
      for (const [, agent] of fakeAgents) {
        postEvent({ type: Event_BrainGrown, a: agent });
        postEvent({ type: Event_AgentGrown, a: agent });
      }

      // Analyses, in the epochs the goldens' `Recent/<epoch>` trees record. Epoch 0 is not an
      // analysis epoch: it holds the *second* link a seed agent's single analysis writes
      // (`number <= _nseeds`), so driving it again would analyse an agent twice.
      const epochs = golden
        .list('brain/Recent')
        .map(Number)
        .filter((epoch) => epoch > 0)
        .sort((a, b) => a - b);
      for (const epoch of epochs) {
        sim.epochValue = epoch;
        const files = golden.list(`brain/Recent/${epoch}`);
        for (const file of files) {
          const match = /^brainFunction_(\d+)\.txt(\.gz)?$/.exec(file);
          if (!match) continue;
          const agent = fakeAgents.get(Number(match[1]));
          if (!agent) continue;
          postEvent({ type: Event_BrainUpdated, a: agent });
          postEvent({ type: Event_BrainAnalysisBegin, a: agent });
        }
      }

      // Epoch ends: the fittest lists are reconstructed from the goldens' own link trees, whose
      // names carry the rank (`<rank>_brainFunction_<agent>`).
      for (const epoch of [100, 200, 300]) {
        sim.epochValue = epoch;
        sim.fittestLists.set(
          1, // FitnessScope.RECENT
          fittestFromTree(golden, `brain/bestRecent/${epoch}`),
        );
        sim.fittestLists.set(0, fittestFromTree(golden, `brain/bestSoFar/${epoch}`));
        postEvent({ type: Event_EpochEnd, epoch });
      }

      sim.stepValue = 301;
      world.objects = [...fakeAgents.values()].map((agent) => ({ type: GObjectType.AGENT, obj: agent }));
      postEvent({ type: Event_SimEnd });

      logs.dispose();

      const produced = listFiles(path.join(runDir, 'brain')).map((rel) => `brain/${rel}`).sort();
      const expected = golden
        .files()
        .filter((rel) => rel.startsWith('brain/'))
        .sort();

      expect(produced).toEqual(expected);

      // Every link is byte-identical to the file it points at (native `::link`).
      const linked = produced.filter((rel) => /brain\/(Recent|bestRecent|bestSoFar)\//.test(rel));
      expect(linked.length).toBe(89 + 120 + 308);

      const mismatched: string[] = [];
      for (const rel of linked) {
        const match = /(?:brain\/)(?:Recent\/\d+|bestRecent\/\d+|bestSoFar\/\d+)\/(?:\d+_)?([^/]+)$/.exec(rel);
        if (!match) continue;
        const name = match[1]!;
        const source = name.includes('brainAnatomy') ? `brain/anatomy/${name}` : `brain/function/${name}`;
        if (Buffer.compare(readFileSync(path.join(runDir, rel)), readFileSync(path.join(runDir, source))) !== 0) {
          mismatched.push(rel);
        }
      }
      expect(mismatched).toEqual([]);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  }, LOAD_TIMEOUT_MS);

  it('counts the brain artifacts the way the goldens do', () => {
    const count = (prefix: string) => golden.files().filter((rel) => rel.startsWith(prefix)).length;
    expect(count('brain/function/')).toBe(87);
    expect(golden.list('brain/function').filter((f) => f.startsWith('incomplete')).length).toBe(23);
    expect(count('brain/anatomy/')).toBe(238);
    expect(count('brain/synapses/')).toBe(238);
    expect(count('brain/Recent/')).toBe(89);
    expect(count('brain/bestRecent/')).toBe(120);
    expect(count('brain/bestSoFar/')).toBe(308);
  });
});

describe('L12 recorders that the recorded scenarios leave off', () => {
  it('GenomeLog writes run/genome/agents/genome_<n>.txt through the gzip backend', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-genome-log'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags({ RecordGenomes: true }));
      const env = contextIn(dir);
      const logs = new Logs(sim, doc, env);

      const agent = new FakeAgent(7);
      postEvent({ type: Event_AgentBirth, a: agent, reason: BirthReason.NATURAL, parent1: agent, parent2: agent });
      // `BR_VIRTUAL` writes no genome at all.
      postEvent({ type: Event_AgentBirth, a: new FakeAgent(8), reason: BirthReason.VIRTUAL, parent1: agent, parent2: agent });
      logs.dispose();

      const produced = listFiles(path.join(dir, 'run')).filter((rel) => rel.startsWith('genome/agents/'));
      expect(produced).toEqual(['genome/agents/genome_7.txt.gz']);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('GenomeMetaLog writes the five meta files on SimInited, in native order', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-genome-meta'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags());
      const schema = new FakeGeneSchema(2843, {
        geneindex: '0\tMutationRate\n',
        genelayout: '2\tMutationRate\n0\tOther\n',
        genetitle: 'MutationRate :: MutationRate\n',
        generange: 'None FLOAT 0.1 FLOAT 0.6 BitProbability\n',
      });
      const env = contextIn(dir, { genomeUtil: new FakeGenomeUtil(schema) });
      const logs = new Logs(sim, doc, env);

      postEvent({ type: Event_SimInited });
      logs.dispose();

      const produced = listFiles(path.join(dir, 'run')).filter((rel) => rel.startsWith('genome/meta/')).sort();
      expect(produced).toEqual([
        'genome/meta/geneindex.txt',
        'genome/meta/genelayout-sorted.txt',
        'genome/meta/genelayout.txt',
        'genome/meta/generange.txt',
        'genome/meta/genetitle.txt',
      ]);

      // The `sort -n` pass (native `SYSTEM( "cat … | sort -n" )`) is lane L5's renderer.
      expect(read(path.join(dir, 'run/genome/meta/genelayout-sorted.txt'))).toBe('0\tOther\n2\tMutationRate\n');
      expect(read(path.join(dir, 'run/genome/meta/geneindex.txt'))).toBe('0\tMutationRate\n');
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('GeneStatsLog prints the schema size then one `%.1f,%.1f` pair per gene per step', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-gene-stats'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags({ RecordGeneStats: true }));
      const env = contextIn(dir, { genomeUtil: new FakeGenomeUtil(new FakeGeneSchema(2)) });
      const logs = new Logs(sim, doc, env);

      sim.geneStatsValue.mean = [128, 0.0078125];
      sim.geneStatsValue.stddev = [0, 0.5];
      sim.stepValue = 5;
      postEvent({ type: Event_StepEnd });
      logs.dispose();

      const text = read(path.join(dir, 'run/genome/genestats.txt'));
      expect(text.split('\n')[0]).toBe('2');
      // `0.0078125` is the tie case: glibc's `%.1f` rounds it to even, `toFixed` rounds up.
      expect(text.split('\n')[1]).toBe('5 128.0,0.0 0.0,0.5');
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('GenomeSubsetLog writes one INT column per named gene and rejects an unknown name', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-genome-subset'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags({ GenomeSubsetLogRecord: true }), {
        geneNames: ['MutationRate', 'Tau'],
      });
      const schema = new FakeGeneSchema(1, {}, new Map([['MutationRate', 0], ['Tau', 1]]));
      const env = contextIn(dir, { genomeUtil: new FakeGenomeUtil(schema) });
      const logs = new Logs(sim, doc, env);

      const agent = new FakeAgent(3);
      postEvent({ type: Event_AgentBirth, a: agent, reason: BirthReason.NATURAL, parent1: agent, parent2: agent });
      logs.dispose();

      const reader = new DataLibReader(readFileSync(path.join(dir, 'run/genome/subset.log')));
      expect(reader.tableNames()).toEqual(['GenomeSubset']);
      reader.seekTable('GenomeSubset');
      expect(reader.columnNames()).toEqual(['Agent', 'MutationRate', 'Tau']);
      expect(reader.columnTypes()).toEqual([DataLibColumnType.INT, DataLibColumnType.INT, DataLibColumnType.INT]);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }

    // An unknown gene name is fatal in native (`exit(1)`); the port throws instead.
    const badDir = freshDir(path.join(CANDIDATE_ROOT, 'unit-genome-subset-bad'));
    resetRegistry();
    const sim = new FakeSimulation();
    const doc = flagsToConfig(minimalFlags({ GenomeSubsetLogRecord: true }), {
      geneNames: ['NotAGene'],
    });
    const schema = new FakeGeneSchema(1, {}, new Map());
    const record = new GenomeSubsetLog(contextIn(badDir, { genomeUtil: new FakeGenomeUtil(schema) }));
    expect(() => record.init(sim, doc)).toThrow(/Invalid gene name/);
    resetRegistry();
  });

  it('AdamiComplexityLog appends to four files on its frequency and nothing in between', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-adami'));
    const previous = process.cwd();
    resetRegistry();

    const written: string[] = [];
    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags({ RecordAdamiComplexity: true }));
      const env = contextIn(dir, {
        computeAdamiComplexity: (step, oneBit) => {
          written.push(`step ${step}`);
          oneBit.printf(`1bit ${step}\n`);
        },
      });
      const logs = new Logs(sim, doc, env);

      sim.stepValue = 1;
      postEvent({ type: Event_StepEnd });
      sim.stepValue = 200;
      postEvent({ type: Event_StepEnd });
      sim.stepValue = 201;
      postEvent({ type: Event_StepEnd });
      logs.dispose();

      expect(written).toEqual(['step 200']);
      expect(read(path.join(dir, 'run/genome/AdamiComplexity-1bit.txt'))).toBe('1bit 200\n');
      expect(listFiles(path.join(dir, 'run/genome')).filter((f) => f.startsWith('AdamiComplexity'))).toEqual([
        'AdamiComplexity-1bit.txt',
        'AdamiComplexity-2bit.txt',
        'AdamiComplexity-4bit.txt',
        'AdamiComplexity-summary.txt',
      ]);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('GitRevisionLog shells out through the file seam on SimInited', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-git'));
    const commands: string[] = [];
    resetRegistry();

    const sim = new FakeSimulation();
    const doc = flagsToConfig(minimalFlags({ RecordGitRevision: true }));
    const fs = nodeRecordFileSystem(ConcreteFileType.TYPE_FILE);
    fs.system = (cmd) => {
      commands.push(cmd);
    };
    const logs = new Logs(sim, doc, contextIn(dir, { fs }));

    postEvent({ type: Event_SimInited });
    logs.dispose();

    expect(commands).toEqual(['git rev-parse HEAD > run/gitrevision.txt']);
    resetRegistry();
  });

  it('SeparationLog in Contact mode caches pairs on contact-begin', () => {
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-separation-contact'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(minimalFlags({ RecordSeparations: 'Contact' }));
      const separations = new RecordedSeparations();
      separations.set(3, 5, 0.25);
      const a = new FakeAgent(3, 3, separations);
      const b = new FakeAgent(5, 5, separations);
      separationCache.init();
      separationCache.birth(a);
      separationCache.birth(b);

      const logs = new Logs(sim, doc, contextIn(dir));
      postEvent({
        type: Event_ContactBegin,
        c: { a, number: 3, mate: 0, fight: 0, give: 0 },
        d: { a: b, number: 5, mate: 0, fight: 0, give: 0 },
      });
      sim.stepValue = 9;
      postEvent({ type: Event_AgentDeath, a, reason: DeathReason.NATURAL });
      logs.dispose();

      const reader = new DataLibReader(readFileSync(path.join(dir, 'run/genome/separations.txt')));
      expect(reader.tableNames()).toEqual(['3']);
      reader.seekTable('3');
      expect(reader.allRows()).toEqual([[5, 0.25]]);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });

  it('BrainComplexityLog writes its .plt rows in ascending agent order, not arrival order', () => {
    // Native's `ComplexityMap` is `std::map< long, float >` (`Logs.h:178`) and
    // `writeComplexityFile` iterates it (`Logs.cc:678-681`), so `complexity_<type>.plt`'s rows
    // are ordered by *agent number* no matter which order the analyses arrived in — the analyses
    // run on several threads, so arrival order is not even deterministic in native. The port's
    // `Map` is insertion-ordered, so the write site sorts: PORT-NOTE(l12/complexity-row-order).
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-brain-complexity'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(
        minimalFlags({ RecordComplexity: true, InitAgents: 2, ComplexityType: 'None' }),
      );
      const logs = new Logs(sim, doc, contextIn(dir));

      const analysed = (number: number, complexity: number) => {
        const a = new FakeAgent(number);
        a.complexityValue = complexity;
        return a;
      };

      // Arrival order 1, 3, 0 — deliberately not ascending. Agents 0 and 1 are the `_nseeds`
      // seeds, so the last of them to arrive (0) writes `Recent/0`; agent 3 only reaches the
      // recent map.
      postEvent({ type: Event_BrainAnalysisEnd, a: analysed(1, 1.5) });
      postEvent({ type: Event_BrainAnalysisEnd, a: analysed(3, 3.5) });
      postEvent({ type: Event_BrainAnalysisEnd, a: analysed(0, 0.5) });

      const seed = new DataLibReader(readFileSync(path.join(dir, 'run/brain/Recent/0/complexity_None.plt')));
      expect(seed.tableNames()).toEqual(['None']);
      seed.seekTable('None');
      // Insertion order (and so the pre-fix port's order) would be [[1, 1.5], [0, 0.5]].
      expect(seed.allRows()).toEqual([
        [0, 0.5],
        [1, 1.5],
      ]);

      // Epoch end: the recent map holds 1, 3, 0 (arrival order); the file is by agent number.
      postEvent({ type: Event_EpochEnd, epoch: 100 });
      const recent = new DataLibReader(
        readFileSync(path.join(dir, 'run/brain/Recent/100/complexity_None.plt')),
      );
      recent.seekTable('None');
      expect(recent.allRows()).toEqual([
        [0, 0.5],
        [1, 1.5],
        [3, 3.5],
      ]);

      // `close()` is native's destructor, which flushes whatever the last `EpochEnd` left behind;
      // the same ordering applies there.
      sim.epochValue = 200;
      postEvent({ type: Event_BrainAnalysisEnd, a: analysed(7, 7.5) });
      postEvent({ type: Event_BrainAnalysisEnd, a: analysed(4, 4.5) });
      logs.dispose();

      const flushed = new DataLibReader(
        readFileSync(path.join(dir, 'run/brain/Recent/200/complexity_None.plt')),
      );
      flushed.seekTable('None');
      expect(flushed.allRows()).toEqual([
        [4, 4.5],
        [7, 7.5],
      ]);

      expect(listFiles(path.join(dir, 'run/brain/Recent'))).toEqual([
        '0/complexity_None.plt',
        '100/complexity_None.plt',
        '200/complexity_None.plt',
      ]);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });
});

describe('L12 file backends', () => {
  it('keeps datalib logs plain and AbstractFile logs gzipped under CompressFiles', () => {
    // `CompressFiles True` (both recorded worldfiles) only affects `AbstractFileLogger`s:
    // `DataLibWriter` and `FileLogger` open with `fopen` and stay plain. The replay corpus
    // proves the same thing across 186 artifacts; this pins it in one place.
    const dir = freshDir(path.join(CANDIDATE_ROOT, 'unit-backends'));
    const previous = process.cwd();
    resetRegistry();

    try {
      process.chdir(dir);
      const sim = new FakeSimulation();
      const doc = flagsToConfig(
        minimalFlags({ RecordPopulation: true, RecordGenomes: true, RecordAgentEnergy: true }),
      );
      const logs = new Logs(sim, doc, contextIn(dir));
      const agent = new FakeAgent(1);
      postEvent({ type: Event_AgentBirth, a: agent, reason: BirthReason.NATURAL, parent1: agent, parent2: agent });
      postEvent({ type: Event_StepEnd });
      logs.dispose();

      const files = listFiles(path.join(dir, 'run'));
      expect(files).toContain('population.txt'); // datalib -> fopen
      expect(files).toContain('energy/agents/agent_1.txt'); // datalib -> fopen
      expect(files).toContain('genome/agents/genome_1.txt.gz'); // AbstractFile -> gzopen
      expect(files.filter((rel) => rel.endsWith('.gz'))).toEqual(['genome/agents/genome_1.txt.gz']);
    } finally {
      process.chdir(previous);
      resetRegistry();
    }
  });
});

/** Build a fittest list from a golden link tree (`<rank>_<dump>_<agent>...`). */
function fittestFromTree(goldenTree: Golden, dir: string): FakeFittestList {
  const ranks = new Map<number, number>();
  for (const file of goldenTree.list(dir)) {
    const match = /^(\d+)_/.exec(file);
    const agent = /_brain(?:Function|Anatomy)_(\d+)/.exec(file);
    if (!match || !agent) continue;
    ranks.set(Number(match[1]), Number(agent[1]));
  }
  const ordered = [...ranks.entries()].sort((a, b) => a[0] - b[0]);
  return new FakeFittestList(ordered.map(([, agentID]) => ({ agentID, complexity: 0, fitness: 0 })));
}

function read(file: string): string {
  return readFileSync(file).toString('latin1');
}
