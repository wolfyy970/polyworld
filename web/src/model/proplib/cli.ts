/**
 * Lane W1b — the lane's reproduction CLI.
 *
 * Repeats exactly what the native does for a scenario, from the *native* tree, with the
 * *native* relative paths (they are document identities and therefore part of the byte
 * contract):
 *
 *   cd <nativeTree>
 *   Polyworld --ui term [--Key Value]… <worldfilePath>
 *     →  run/converted.wf     (worldfile, converted, before the schema is applied)
 *     →  run/normalized.wf    (worldfile + schema defaults + parameters)
 *
 * so the port can be compared with the recorded goldens byte for byte:
 *
 *   npx vite-node src/model/proplib/cli.ts -- \
 *     --root ../polyworld \
 *     --worldfile worldfiles/tests/low-spec-pc/minitest.wf \
 *     --set Vision=False \
 *     --converted-out /tmp/converted.wf --normalized-out /tmp/normalized.wf
 *
 * PORT-NOTE(proplib/cli-fs): this is the only file in the lane that touches `node:fs`; the
 * model itself takes document text (`DocumentBuilder`). Nothing imports this file, so it is
 * never part of the browser bundle.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_SCHEMA_PATH, emitNormalizedWorldfile } from './index';

interface Args {
  root: string;
  schema: string;
  worldfile?: string;
  sets: [string, string][];
  convertedOut?: string;
  normalizedOut?: string;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { root: '../polyworld', schema: NATIVE_SCHEMA_PATH, sets: [], quiet: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        args.root = require_(argv[++i], '--root');
        break;
      case '--schema':
        args.schema = require_(argv[++i], '--schema');
        break;
      case '--worldfile':
        args.worldfile = require_(argv[++i], '--worldfile');
        break;
      case '--set': {
        const pair = require_(argv[++i], '--set');
        const eq = pair.indexOf('=');
        if (eq < 0) throw new Error(`--set expects Key=Value, got '${pair}'`);
        args.sets.push([pair.slice(0, eq), pair.slice(eq + 1)]);
        break;
      }
      case '--converted-out':
        args.convertedOut = require_(argv[++i], '--converted-out');
        break;
      case '--normalized-out':
        args.normalizedOut = require_(argv[++i], '--normalized-out');
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument '${arg}' (try --help)`);
    }
  }

  if (!args.worldfile) throw new Error('--worldfile is required');
  return args;
}

function require_(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return [
    'proplib dump — reproduce the native run/{converted,normalized}.wf',
    '',
    '  --root <dir>             native tree (default ../polyworld)',
    `  --schema <path>          schema path, as the native spells it (default ${NATIVE_SCHEMA_PATH})`,
    '  --worldfile <path>       worldfile path, as the native spells it (required)',
    '  --set <Key=Value>        a native `--Key Value` override (repeatable)',
    '  --converted-out <file>   write converted.wf here',
    '  --normalized-out <file>  write normalized.wf here',
    '  --quiet                  no status line',
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Native `std::map<string,string>`: parameters are applied in *key* order.
  const parameters = new Map<string, string>([...args.sets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const sourceName = args.worldfile as string;
  const read = (path: string): string => {
    try {
      // latin-1: one JS char per byte, so the document round-trips byte for byte.
      return readFileSync(join(args.root, path), 'latin1');
    } catch (error) {
      throw new Error(`No such file: ${join(args.root, path)} (${String(error)})`);
    }
  };

  const result = emitNormalizedWorldfile(read, {
    worldfilePath: sourceName,
    schemaPath: args.schema,
    parameters,
  });

  if (args.convertedOut) writeFileSync(args.convertedOut, result.converted, 'latin1');
  if (args.normalizedOut) writeFileSync(args.normalizedOut, result.normalized, 'latin1');

  if (!args.quiet) {
    process.stdout.write(
      `proplib: ${sourceName} -> converted.wf ${result.converted.length} bytes, ` +
        `normalized.wf ${result.normalized.length} bytes\n`,
    );
  }
}

main();
