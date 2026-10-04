/**
 * Lane L12 (logs) — the text sink's *shape*: a sink a recorder hands out must accept **both** of
 * native's `fprintf` forms, because a recorder's file is the file another lane writes through.
 *
 * Measured defect this pins (task t_e76d9e7a, `microtest_voff` 2026-09-28):
 * `run/brain/anatomy/brainAnatomy_10_birth.txt.gz` line 1 held the format string
 *
 *     brain %ld fitness=%g numneurons+1=%d maxWeight=%g maxBias=%g %s=%d-%d …
 *
 * instead of the golden's `brain 10 fitness=0 numneurons+1=38 maxWeight=8 maxBias=8
 * redinput=2-10 …`: `TextSink.printf( text )` took no format arguments, and TypeScript accepts a
 * one-parameter method where a rest-parameter signature is expected, so the brain's values were
 * silently dropped. See PORT-NOTE(l12/text-sink-format) in `src/model/logs/formatSink.ts`.
 *
 * Every test here is a *seam* test: the values are the other lanes', the bytes are this lane's.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Event_AgentGrown, Event_StepEnd, type SimEvent } from '../src/model/types';
import { documentFromJs, createConfig } from '../src/model/types';
import type { MemoryValue } from '../src/model/types/memoryDocument';
import type { Config } from '../src/model/types';
import { BrainAnatomyLog } from '../src/model/logs/brainLogs';
import { AdamiComplexityLog } from '../src/model/logs/simLogs';
import { resetRegistry } from '../src/model/logs';
import type { DataLibWriter } from '../src/model/datalib';
import type { LogAgent, LogBrain, LogContext, RecordFileSystem, TextSink } from '../src/model/logs';
import { FakeSimulation } from './logsReplay';

//===========================================================================
// A `RecordFileSystem` that keeps the bytes in memory
//===========================================================================

/**
 * A *raw* backend sink: it writes what it is given, exactly like `PlainTextSink`/`GzipTextSink`
 * (and like the browser's own implementation). It applies no format — the seam above it does.
 */
class MemoryTextSink implements TextSink {
  constructor(private readonly write: (text: string) => void) {}

  printf(text: string): void {
    this.write(text);
  }

  flush(): void {
    /* unbuffered */
  }

  close(): void {
    /* nothing to release */
  }
}

/** The file seam over a `Map`, so a test reads a recorder's bytes without touching disk. */
class MemoryRecordFileSystem implements RecordFileSystem {
  readonly files = new Map<string, string>();

  makeParentDir(): void {
    /* paths need no directories in memory */
  }

  makeDirs(): void {
    /* ditto */
  }

  openPlain(path: string): TextSink {
    return this.sinkFor(path);
  }

  openAbstract(path: string): TextSink {
    return this.sinkFor(path);
  }

  openDataLib(): DataLibWriter {
    throw new Error('L12 sink-shape test: datalib is not opened here');
  }

  exists(): boolean {
    return false;
  }

  link(): number {
    return -1;
  }

  rename(): number {
    return -1;
  }

  unlink(): number {
    return -1;
  }

  system(): void {
    throw new Error('L12 sink-shape test: no shell here');
  }

  private sinkFor(path: string): TextSink {
    return new MemoryTextSink((text) => this.files.set(path, (this.files.get(path) ?? '') + text));
  }
}

function contextIn(fs: MemoryRecordFileSystem): LogContext {
  return {
    fs,
    world: { reset: () => undefined, next: () => false },
    genomeUtil: { schema: null, layout: null },
    foodTypes: { getNumberDefinitions: () => 0, get: () => ({ index: 0, name: '' }) },
    computeAdamiComplexity: () => undefined,
  };
}

function config(overrides: { readonly [name: string]: MemoryValue }): Config {
  return createConfig(documentFromJs(overrides));
}

/** The two accessors `BrainAnatomyLog::createAnatomyFile` reads. */
function agentWith(number: number, brain: LogBrain): LogAgent {
  return { number: () => number, brain: () => brain } as unknown as LogAgent;
}

/**
 * The brain as this lane sees it: lane L6's `Brain::dumpAnatomical` writes a format **and** its
 * values (native `AbstractFile::printf`), and the sensor hooks append their channel ranges the
 * same way (`Retina::sensor_dump_anatomical`).
 */
class FormattedBrain implements LogBrain {
  dumpAnatomical(file: TextSink, n: number, fitness: number): void {
    file.printf(
      'brain %ld fitness=%g numneurons+1=%d maxWeight=%g maxBias=%g %s=%d-%d %s=%d-%d\n',
      n,
      fitness,
      38,
      8,
      8,
      'redinput',
      2,
      10,
      'greeninput',
      11,
      19,
    );
  }

  dumpSynapses(file: TextSink, n: number): void {
    file.printf('synapses %ld maxweight=%g\n', n, 8);
  }

  startFunctional(file: TextSink, n: number): void {
    file.printf('version 1\nbrainFunction %ld %d %d %d %ld\n', n, 37, 29, 8, 74);
  }

  writeFunctional(file: TextSink): void {
    file.printf('%d %g\n', 0, 0.123419);
  }

  endFunctional(file: TextSink, fitness: number): void {
    file.printf('end fitness = %g\n', fitness);
  }
}

let fs: MemoryRecordFileSystem;

beforeEach(() => {
  resetRegistry();
  fs = new MemoryRecordFileSystem();
});

describe('L12 text sink: native’s two fprintf shapes', () => {
  it('formats the brain’s anatomy dump handed to it by the recorder (t_e76d9e7a)', () => {
    const log = new BrainAnatomyLog(contextIn(fs));
    log.init(
      new FakeSimulation() as unknown as Parameters<typeof log.init>[0],
      config({ RecordBrainAnatomy: 'True', RecordBrainRecent: 'False', RecordBrainBestRecent: 'False', RecordBrainBestSoFar: 'False' }),
    );

    log.processEvent({
      type: Event_AgentGrown,
      a: agentWith(10, new FormattedBrain()),
    } as unknown as SimEvent);

    const text = fs.files.get('run/brain/anatomy/brainAnatomy_10_birth.txt');

    expect(text).toBe(
      'brain 10 fitness=0 numneurons+1=38 maxWeight=8 maxBias=8 redinput=2-10 greeninput=11-19\n',
    );
    // The defect's signature: the format string reached the file.
    expect(text).not.toContain('%');
  });

  it('formats the synapse dump and the functional header the same way', () => {
    const log = new BrainAnatomyLog(contextIn(fs));
    log.init(
      new FakeSimulation() as unknown as Parameters<typeof log.init>[0],
      config({ RecordBrainAnatomy: 'True', RecordBrainRecent: 'False', RecordBrainBestRecent: 'False', RecordBrainBestSoFar: 'False' }),
    );

    const brain = new FormattedBrain();
    log.processEvent({ type: Event_AgentGrown, a: agentWith(3, brain) } as unknown as SimEvent);

    brain.dumpSynapses(fs.openAbstract('run/brain/synapses/synapses_3_birth.txt'), 3);
    brain.startFunctional(fs.openAbstract('run/brain/function/incomplete_brainFunction_3.txt'), 3);

    expect(fs.files.get('run/brain/anatomy/brainAnatomy_3_birth.txt')).toBe(
      'brain 3 fitness=0 numneurons+1=38 maxWeight=8 maxBias=8 redinput=2-10 greeninput=11-19\n',
    );
  });

  it('applies native’s format for lane L13’s Adami files (adami.cc is `fprintf( f, "%.4f %.4f" )`)', () => {
    const fs2 = new MemoryRecordFileSystem();
    fs2.files.set('__seen', '');

    const log = new AdamiComplexityLog({
      ...contextIn(fs2),
      // Native `computeAdamiComplexity( timestep, oneBit, twoBit, fourBit, summary )` — the four
      // files are written by lane L13 through these sinks.
      computeAdamiComplexity: (_step, oneBit, twoBit, _fourBit, summary) => {
        oneBit.printf('%ld:', 0);
        oneBit.printf(' %.4f %.4f %.4f\n', 1.5, 2.25, 3);
        // Native's own header line is a literal (no values): `fprintf( f, "%% Timestep …" )` prints
        // `% Timestep …`, so the caller renders those bytes — the sink writes a value-less call
        // verbatim, which is what keeps `'% Timestep Event Agent# …'` exact (PORT-NOTE
        // (l12/text-sink-format)).
        twoBit.printf('% Timestep 1bit 2bit 4bit\n');
        summary.printf('%.4f %.4f %.4f\n', 1.5, 2.25, 3);
      },
    });

    log.init(
      new FakeSimulation() as unknown as Parameters<typeof log.init>[0],
      config({ RecordAdamiComplexity: 'True', AdamiComplexityRecordFrequency: '1' }),
    );
    log.processEvent({ type: Event_StepEnd } as unknown as SimEvent);

    expect(fs2.files.get('run/genome/AdamiComplexity-1bit.txt')).toBe('0: 1.5000 2.2500 3.0000\n');
    expect(fs2.files.get('run/genome/AdamiComplexity-2bit.txt')).toBe('% Timestep 1bit 2bit 4bit\n');
    expect(fs2.files.get('run/genome/AdamiComplexity-summary.txt')).toBe('1.5000 2.2500 3.0000\n');
    expect(fs2.files.get('run/genome/AdamiComplexity-4bit.txt')).toBeUndefined();
  });

  it('writes a value-less call verbatim, so a pre-formatted recorder line keeps its `%`', () => {
    // `BirthsDeathsLog` writes its header as native `fprintf( f, "%s", "% Timestep …" )`: the text
    // is not a format, and `%%` must not be assumed.
    const sink = fs.openPlain('run/BirthsDeaths.log');
    sink.printf('% Timestep Event Agent# Parent1 Parent2\n');

    expect(fs.files.get('run/BirthsDeaths.log')).toBe('% Timestep Event Agent# Parent1 Parent2\n');
  });
});
