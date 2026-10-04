/**
 * Byte-exactness of the transcribed upstream-zlib deflate (task t_431ed2f0).
 *
 * The oracle is the recorded `.gz` goldens: every container was written by upstream
 * zlib level-6 raw deflate (see `docs/specs/gzip-containers.md`). This test walks
 * every `.gz` in every recorded scenario, gunzips it, re-deflates the payload with
 * `src/model/compress/zlibDeflate.ts`, rebuilds the container, and asserts the whole
 * container matches the golden byte-for-byte.
 *
 * It also round-trips an adversarial payload set (empty, 1 byte, all zeros,
 * incompressible, a 1 MiB log-like text, >32 KiB window slides, >64 KiB multiple
 * `fill_window` calls, lengths an exact multiple of 32768), and — when `python3` is
 * available — cross-checks those against the platform zlib (apple libz 1.2.12, the
 * same library that wrote the goldens) so the adversarial cases are byte-oracled
 * too, not merely round-tripped.
 * Load, not slowness of the code: the guarded test(s) are 785 ms solo and 0.9 s under four
 * concurrent full suites — the band that false-reds when the fleet's three concurrent pairs
 * (6 processes) run. They carry LOAD_TIMEOUT_MS below; no assertion changed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gunzipSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { deflateRaw, gzipContainer, GZIP_HEADER } from '../src/model/compress/zlibDeflate';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ORACLE = join(REPO, 'oracle');

/** Every `.gz` under a scenario's `run/` tree, sorted for a stable report. */
function gzFiles(scenario: string): string[] {
  const root = join(ORACLE, scenario, 'run');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.gz')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const SCENARIOS = ['microtest_voff', 'minitest_voff', 'microtest_von', 'minitest_von', 'hello'];

/**
 * Vitest's default is 5 s. The guarded test(s) are 785 ms solo and 0.9 s under four concurrent
 * full suites; the fleet also runs three concurrent pairs (6 processes), and at that load the
 * orchestrator measured a 946 ms-solo test false-red 6/6 on 2026-09-29 — this is the same band.
 * 60 s is the budget the vision-on gate already carries (t_1f4a7a8a): that measurement with room,
 * and still a guard, so a genuine hang fails.
 */
const LOAD_TIMEOUT_MS = 60_000;

describe('zlib deflate: recorded goldens are reproduced byte-for-byte', () => {
  it('rebuilds every recorded .gz container exactly', () => {
    let total = 0;
    const failures: string[] = [];

    for (const scenario of SCENARIOS) {
      for (const path of gzFiles(scenario)) {
        total++;
        const golden = readFileSync(path);
        const payload = gunzipSync(golden);
        const rebuilt = gzipContainer(payload);
        if (rebuilt.length !== golden.length || !rebuilt.every((b, i) => b === golden[i])) {
          failures.push(`${scenario}:${relative(join(ORACLE, scenario, 'run'), path)}`);
        }
      }
    }

    // 150 (microtest_voff) + 1167 (minitest_voff) + 150 + 1114 + 0
    expect(total).toBe(2581);
    expect(failures).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('uses the frozen 10-byte gzip header the goldens carry', () => {
    expect([...GZIP_HEADER]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13]);
  });
});

/** Deterministic xorshift32 so the "incompressible" case is reproducible. */
function xorshiftBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function logLikeText(approxBytes: number): Uint8Array {
  const lines = ['step,agent,fitness,energy,size,color,vision,parent,generation'];
  for (let i = 0; lines.join('\n').length < approxBytes; i++) {
    lines.push(`${i},${i % 97},${(i * 7919) % 100000},${(i * 104729) % 65536},5,${i % 8},1,${i % 13},${(i / 97) | 0}`);
    if (i % 64 === 63) lines.push('#@L repeat block '.repeat(16));
  }
  const text = lines.join('\n');
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const ADVERSARIAL: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['one byte', new Uint8Array([0x41])],
  ['all zeros 100000', new Uint8Array(100000)],
  ['incompressible 200000', xorshiftBytes(200000, 0x12345678)],
  ['log-like 1 MiB', logLikeText(1024 * 1024)],
  ['window slide >32 KiB', concat(new Uint8Array(40000).fill(0x5a), xorshiftBytes(90000, 0xabcdef01))],
  ['multiple fill_window >64 KiB', concat(logLikeText(70000), xorshiftBytes(70000, 0x0badf00d))],
  ['exact 32768 multiple', xorshiftBytes(32768, 0x77777777)],
  ['exact 65536 multiple', new Uint8Array(65536).map((_, i) => i & 0xff)],
];

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The platform zlib's raw level-6 deflate (apple libz 1.2.12, the golden writer). */
function pythonDeflateRaw(payload: Uint8Array): Uint8Array {
  const script =
    'import sys,zlib;d=sys.stdin.buffer.read();' +
    'c=zlib.compressobj(6,zlib.DEFLATED,-15);' +
    'sys.stdout.buffer.write(c.compress(d)+c.flush())';
  const out = execFileSync('python3', ['-c', script], { input: payload, maxBuffer: 64 * 1024 * 1024 });
  return new Uint8Array(out);
}

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['-c', 'import zlib'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('zlib deflate: adversarial payloads', () => {
  for (const [name, payload] of ADVERSARIAL) {
    it(`${name} round-trips through the container`, () => {
      const container = gzipContainer(payload);
      expect([...container.subarray(0, 10)]).toEqual([...GZIP_HEADER]);
      expect(gunzipSync(container).equals(Buffer.from(payload))).toBe(true);

      const raw = deflateRaw(payload);
      expect(inflateRawSync(raw).equals(Buffer.from(payload))).toBe(true);
    });
  }

  it.skipIf(!pythonAvailable())('matches the platform zlib byte-for-byte', () => {
    const mismatches: string[] = [];
    for (const [name, payload] of ADVERSARIAL) {
      const ours = deflateRaw(payload);
      const theirs = pythonDeflateRaw(payload);
      const equal = ours.length === theirs.length && ours.every((b, i) => b === theirs[i]);
      if (!equal) mismatches.push(`${name} (ours ${ours.length} vs zlib ${theirs.length})`);
    }
    expect(mismatches).toEqual([]);
  });
});
