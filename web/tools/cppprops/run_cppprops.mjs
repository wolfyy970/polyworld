#!/usr/bin/env node
/**
 * run_cppprops.mjs - replay a state trace through a cppprops spec (W1h).
 *
 *   node tools/cppprops/run_cppprops.mjs --spec spec.json --state trace.json
 *
 * No compiler, no dlopen, no native tree: the spec is data (build-time
 * artifact) and the interpreter is lib/cppprops.mjs.
 *
 * State trace forms:
 *   canonical  {"steps":[{"step":1,"values":{"Step":1,"AgentCount":181,...}}, ...]}
 *   fixture    {"steps":[{"step":1,"agents":181,"food":90}, ...]}
 *              plus --runtime-map '{"Step":"step","AgentCount":"agents"}'
 *
 * Engine inputs for bindings (optional, --engine file.json) are passed through
 * to the binding context, either as one static table
 *
 *   {"patchAgentInsideCount": {"0.0": 0, "0.1": 3}}
 *
 * or per step, keyed by the value of the `Step` runtime property
 *
 *   {"defaults": {},                      # optional shared tables/keys
 *    "steps": {"1": {"patchAgentInsideCount": {"0.0": 0, "0.1": 3}}, ...}}
 *
 * (`lib/cppprops.mjs` `splitEngine`).  A step with no entry sees the defaults.
 * Unlisted patches read 0, which is also what a missing --engine gives.
 *
 * Output (--format):
 *   native : one `[Name=Value ...]` line per step, metadata order, native
 *            `PropertyMetadata::toString()` rendering   (default)
 *   json   : one JSON object per step, values rendered as text
 *   values : one JSON object per step, raw values (for model comparisons)
 *
 * Exit: 0 ok, 1 error, 3 unbound unportable properties.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { CppPropsEvaluator } from "./lib/cppprops.mjs";
import defaultBindings from "./bindings/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`usage: run_cppprops.mjs --spec SPEC.json --state STATE.json
        [--format native|json|values] [--runtime-map MAP.json]
        [--engine ENGINE.json] [--bindings FILE.mjs] [--steps N] [--quiet]`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { format: "native", steps: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--spec": args.spec = argv[++i]; break;
      case "--state": args.state = argv[++i]; break;
      case "--format": args.format = argv[++i]; break;
      case "--runtime-map": args.runtimeMap = argv[++i]; break;
      case "--engine": args.engine = argv[++i]; break;
      case "--bindings": args.bindings = argv[++i]; break;
      case "--steps": args.steps = parseInt(argv[++i], 10); break;
      case "--quiet": args.quiet = true; break;
      case "-h": case "--help": usage(); break;
      default: usage(`unknown argument ${arg}`);
    }
  }
  if (!args.spec) usage("--spec is required");
  if (!args.state) usage("--state is required");
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function loadBindings(arg) {
  if (!arg) return defaultBindings;
  const module = await import(resolve(arg) === arg ? arg : resolve(process.cwd(), arg));
  return module.default || module.bindings || module;
}

function valuesForStep(record, runtimeMap) {
  if (record.values) return record.values;
  if (!runtimeMap) {
    throw new Error("state record has no `values`; pass --runtime-map to derive them");
  }
  const out = {};
  for (const [name, key] of Object.entries(runtimeMap)) {
    if (!(key in record)) {
      throw new Error(`state record (step ${record.step}) has no '${key}' for runtime property '${name}'`);
    }
    out[name] = record[key];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = readJson(args.spec);
  const trace = readJson(args.state);
  const runtimeMap = args.runtimeMap ? readJson(args.runtimeMap) : null;
  const engine = args.engine ? readJson(args.engine) : {};
  const bindings = await loadBindings(args.bindings);

  const evaluator = new CppPropsEvaluator(spec, { bindings, engine });
  if (evaluator.missingBindings.length) {
    console.error("cppprops: unportable dyn bodies with no binding:");
    for (const missing of evaluator.missingBindings) {
      console.error(`  ${missing.name}: ${missing.symbols.join(", ")}`);
    }
    console.error("  (bindings module: " +
      (args.bindings || `${HERE}/bindings/index.mjs`) + ")");
    return 3;
  }

  evaluator.init();

  const records = args.steps ? trace.steps.slice(0, args.steps) : trace.steps;
  const lines = [];
  for (const record of records) {
    evaluator.step(valuesForStep(record, runtimeMap));
    if (args.format === "native") {
      lines.push(evaluator.formatNativeLine());
    } else if (args.format === "json") {
      lines.push(JSON.stringify({ step: record.step, values: evaluator.format() }));
    } else if (args.format === "values") {
      lines.push(JSON.stringify({ step: record.step, values: evaluator.snapshot() }));
    } else {
      usage(`unknown --format ${args.format}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");

  if (!args.quiet && evaluator.errors.length) {
    for (const err of evaluator.errors) console.error(`cppprops: ${err}`);
    return 1;
  }
  return 0;
}

// NOTE: do not call process.exit() here - stdout to a pipe is asynchronous and
// exiting immediately truncates the trace (verified: 300 lines cut to 250).
main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
