#!/usr/bin/env python3
"""verify_cppprops.py - acceptance test for lane W1h.

For every recorded fixture:

  1. extract a spec from the *worldfile* (`extract_cppprops.py`, build time);
  2. cross-check the emitted C++ against the `generated.cc` captured from a
     real native run (byte-exact);
  3. run the browser-side interpreter (`run_cppprops.mjs`) over the recorded
     state trace with a **scrubbed PATH** - no compiler, no `make`, no
     `python`, no native tree - and compare its per-step values against the
     native FarmMonitor trace (`fixtures/native/<scn>.farm.log`).

Failing any of the three fails the lane.  The scrubbed PATH is the proof for
"no compiler invoked at run time": the child is started with
`PATH=/nonexistent` and `--spec` only, so nothing can be built or `dlopen`ed
even if the code tried.

Two scenario blocks exist for the inputs a spec cannot get from the state
trace, both read **out of the recording**, never typed:

  `engineFromState`  per-step engine tables for a binding (the token ring's
                     `FoodPatch::agentInsideCount`), read from the state's
                     `foodPatches` block - see `engine_trace`;
  `genesFromGenerange`
                     the gene table a `$[gene, …]`-bound property needs,
                     read from the run's own `run/genome/meta/generange.txt`
                     (kept as `fixtures/native/<scn>.generange.txt`) - see
                     `gene_table`.  Without it a gene-bound property would
                     have no gene source and `run_cppprops.mjs` exits 1
                     (that is the binding's contract, not a stub).

It also audits the manifest's hand-maintained `worldfiles` sha256 pins against
disk (a stale pin fails the run).

Usage:
    verify_cppprops.py [--scenario NAME ...] [--keep] [--verbose]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(TOOLS))
FIXTURES = os.path.join(TOOLS, "fixtures")
SCRUBBED_PATH = "/nonexistent"

# farm-log column Title -> cppprops property Name, taken from the harness'
# monitor config.  The titles are a harness convenience; the values are the
# native cppprops property values.
TITLE_RE = re.compile(r'\{\s*Name\s*"([^"]*)"\s*;\s*Title\s*"([^"]*)"')
FARM_LINE_RE = re.compile(r"^\[(.*)\]$")
KV_RE = re.compile(r"([^=\s]+)=([^\s]*)")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest():
    with open(os.path.join(FIXTURES, "manifest.json")) as f:
        return json.load(f)


def title_map():
    """Parse fixtures/harness/term.mf: {Title: Name}."""
    text = open(os.path.join(FIXTURES, "harness", "term.mf")).read()
    return {title: name for name, title in TITLE_RE.findall(text)}


def parse_farm_log(path, titles):
    """[(step, {name: value_text})] from the native FarmMonitor trace."""
    out = []
    for line in open(path):
        line = line.strip()
        m = FARM_LINE_RE.match(line)
        if not m:
            continue
        values = {}
        step = None
        for key, value in KV_RE.findall(m.group(1)):
            name = titles.get(key, key)
            if name == "Step":
                step = int(value)
            values[name] = value
        out.append((step, values))
    return out


def state_trace(path, runtime_map):
    """Convert a recorded state file into the canonical trace run_cppprops.mjs wants."""
    with open(path) as f:
        state = json.load(f)
    steps = []
    for record in state["steps"]:
        values = {}
        for name, key in runtime_map.items():
            source = key[1:] if key.startswith("@") else key
            if source not in record:
                raise SystemExit("state %s: step %s lacks '%s' (for %s)"
                                 % (path, record.get("step"), source, name))
            values[name] = record[source]
        steps.append({"step": record["step"], "values": values})
    return {"formatVersion": 1, "scenario": state.get("scenario"), "steps": steps}


def engine_trace(state, spec):
    """Per-step engine inputs for the bindings, built out of the state trace.

    `spec` is a scenario's `engineFromState` block:

      table      engine table name (e.g. `patchAgentInsideCount`)
      field      the state key read out of each `<domain>.<patch>` entry
      stepShift  which state record step N's table comes from (N + stepShift)

    The shape handed to `run_cppprops.mjs --engine` is

      {"formatVersion": 1,
       "steps": {"<step>": {"<table>": {"<domain>.<patch>": <value>}}}}

    and a step with no source record (step 1 under `stepShift` -1, or any gap)
    gets an empty table - the native initial zeros, which is also what a
    missing `--engine` gives.
    """
    table = spec["table"]
    field = spec["field"]
    shift = spec.get("stepShift", 0)
    by_step = {record["step"]: record for record in state["steps"]}
    steps = {}
    for record in state["steps"]:
        source = by_step.get(record["step"] + shift) or {}
        steps[str(record["step"])] = {
            table: {key: patch[field]
                    for key, patch in (source.get("foodPatches") or {}).items()
                    if field in patch},
        }
    return {"formatVersion": 1, "steps": steps}


GENE_KINDS = ("INT", "FLOAT", "BOOL")


def scalar_literal(kind, text, path, number):
    """`Scalar::str()`'s value half (`utils/Scalar.cc:65-86`) as a JSON value."""
    if kind == "INT":
        return int(text)
    if kind == "FLOAT":
        return float(text)
    if text not in ("true", "false"):
        raise SystemExit("%s:%d: %s scalar is neither true nor false: %r"
                         % (path, number, kind, text))
    return text == "true"


def generange_ranges(path):
    """`{gene: {kind, min, max}}` out of a native `run/genome/meta/generange.txt`.

    `Gene.cc:226-238` (`__InterpolatedGene::printRanges`) writes

        <rounding> <smin Scalar::str()> <smax Scalar::str()> <name>

    and `Scalar::str()` (`utils/Scalar.cc:65-86`) is `<KIND> <value>`, so a line
    reads `None FLOAT 0.500000 FLOAT 0.800000 MateEnergyFraction`.  `rounding`
    (`None|IntFloor|IntNearest|IntBin`) is only printed for an INT range and is
    not part of the Scalar the binding reads, so it is not consumed here.

    Every value comes out of the file the native run wrote - the same values the
    port's genome layer is pinned against by
    `tests/cppprops-gene-binding.test.ts` (`geneTableFromGenomeUtil`).  A line
    this parser does not recognise, or a gene whose two range ends disagree about
    their kind, is a hard error: the binding refuses a mixed range, so accepting
    one here would only move the failure somewhere less legible.
    """
    out = {}
    with open(path) as f:
        for number, line in enumerate(f, 1):
            parts = line.split()
            if not parts:
                continue
            if len(parts) < 6 or parts[1] not in GENE_KINDS or parts[3] not in GENE_KINDS:
                raise SystemExit("%s:%d: not a generange line: %r"
                                 % (path, number, line.rstrip()))
            name = parts[5]
            if parts[1] != parts[3]:
                raise SystemExit("%s:%d: gene %s has a mixed range kind (%s/%s); "
                                 "the gene binding refuses that"
                                 % (path, number, name, parts[1], parts[3]))
            out[name] = {
                "kind": parts[1],
                "min": scalar_literal(parts[1], parts[2], path, number),
                "max": scalar_literal(parts[3], parts[4], path, number),
            }
    return out


def gene_table(block):
    """The `ctx.engine.genes` table for one scenario, from the recording.

    `block` is a scenario's `genesFromGenerange` entry:

      source  the recorded `generange.txt` (relative to `fixtures/`)
      names   the genes the scenario's spec reads (the `$[gene, NAME, …]`
              symbols the worldfile reaches)
    """
    path = os.path.join(FIXTURES, block["source"])
    ranges = generange_ranges(path)
    table = {}
    for name in block["names"]:
        if name not in ranges:
            raise SystemExit("%s: no generange line for gene %s" % (path, name))
        table[name] = ranges[name]
    return table


def schema_document_name(manifest):
    """The schema *document's own name*, as the recorded `generated.cc` spells it.

    native `Simulation.cc:270` builds the schema document with the literal
    `"./etc/worldfile.wfs"` - the run that writes `run/.cppprops/generated.cc`,
    i.e. the crosscheck oracle - so a schema location in that file reads
    `./etc/worldfile.wfs:1619` (`gene_dyn.generated.cc:153`).  The run's cwd is a
    mirror of the native tree, so the literal is the schema path relative to the
    recorded `native_root`: derive it rather than typing it, and let the
    byte-exact crosscheck be the judge - a derivation that does not describe the
    recording fails it, loudly, instead of emitting a plausible path.
    """
    root = manifest.get("native_root")
    schema = manifest.get("schema")
    if not root or not schema:
        return None
    relative = os.path.relpath(schema, root)
    if relative.startswith(".."):
        return None
    return "./" + relative.replace(os.sep, "/")


def worldfile_pins(manifest):
    """sha256 audit of the hand-maintained `worldfiles` block.

    `record_scenario.py` writes the `scenarios` block only, so these pins are
    edited by hand and can drift silently (one did: `growers_ring` held a hash
    from an exploratory variant of the worldfile it describes).  The block is
    documentation, but a pin that does not describe its file is worse than no
    pin, so a mismatch fails the run.
    """
    problems = []
    for name, entry in sorted(manifest.get("worldfiles", {}).items()):
        path = os.path.join(FIXTURES, entry["path"])
        if not os.path.exists(path):
            problems.append("worldfile pin %s: %s does not exist" % (name, entry["path"]))
            continue
        digest = sha256_file(path)
        if digest != entry["sha256"]:
            problems.append("worldfile pin %s: manifest %s, disk %s (%s)"
                            % (name, entry["sha256"], digest, entry["path"]))
    return problems


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def verify_scenario(name, scenario, manifest, titles, workdir, verbose):
    problems = []
    local = os.path.join(FIXTURES, "worldfiles", "%s.wf" % name)
    worldfile = local if os.path.exists(local) else scenario["worldfile"]
    if not os.path.exists(worldfile):
        return ["no worldfile for %s (looked at %s and %s)"
                % (name, local, scenario["worldfile"])]
    schema = manifest["schema"]
    generated = os.path.join(FIXTURES, scenario["generated_cc"])
    farm_log = os.path.join(FIXTURES, scenario["farm_log"])

    spec_path = os.path.join(workdir, "%s.spec.json" % name)
    emit_path = os.path.join(workdir, "%s.generated.cc" % name)
    trace_path = os.path.join(workdir, "%s.trace.json" % name)

    # --- 1 + 2: extract from the worldfile, cross-check the emitted C++ -----
    schema_name = schema_document_name(manifest)
    name_args = ["--schema-name", schema_name] if schema_name else []
    extract = run([sys.executable, os.path.join(TOOLS, "extract_cppprops.py"),
                   "--worldfile", worldfile, "--schema", schema,
                   "--out", spec_path, "--emit-cc", emit_path,
                   "--crosscheck", generated, "--quiet"] + name_args)
    if extract.returncode != 0:
        problems.append("extract/crosscheck failed:\n%s%s"
                        % (extract.stdout, extract.stderr))
        return problems

    # --- 3: interpret with the browser path, scrubbed PATH -----------------
    runtime_map = scenario.get("runtimeMap")
    if runtime_map is None:
        problems.append("manifest has no runtimeMap for %s" % name)
        return problems
    trace = state_trace(os.path.join(FIXTURES, scenario["state"]), runtime_map)
    with open(trace_path, "w") as f:
        json.dump(trace, f)

    # Engine inputs for the bindings, when the scenario records them (additive:
    # a scenario without `engineFromState`/`genesFromGenerange` runs exactly as
    # before).  A gene-bound property has no other source: without `genes` the
    # binding refuses (`run_cppprops.mjs` exit 1, "no gene source").
    engine = None
    if scenario.get("engineFromState"):
        with open(os.path.join(FIXTURES, scenario["state"])) as f:
            engine_state = json.load(f)
        engine = engine_trace(engine_state, scenario["engineFromState"])
    if scenario.get("genesFromGenerange"):
        engine = engine or {"formatVersion": 1}
        engine["genes"] = gene_table(scenario["genesFromGenerange"])
    engine_args = []
    if engine is not None:
        engine_path = os.path.join(workdir, "%s.engine.json" % name)
        with open(engine_path, "w") as f:
            json.dump(engine, f)
        engine_args = ["--engine", engine_path]

    env = dict(os.environ)
    env["PATH"] = SCRUBBED_PATH
    env.pop("PWFARM_STATUS", None)
    env.pop("PWFARM_STATUS_LOG", None)

    node = shutil.which("node")
    if node is None:
        problems.append("node not found on this machine")
        return problems

    result = run([node, os.path.join(TOOLS, "run_cppprops.mjs"),
                  "--spec", spec_path, "--state", trace_path,
                  "--format", "native", "--quiet"] + engine_args, env=env)
    if result.returncode == 3:
        problems.append("unbound unportable dyn bodies:\n%s" % result.stderr)
        return problems
    if result.returncode != 0:
        problems.append("interpreter failed (exit %d):\n%s%s"
                        % (result.returncode, result.stdout, result.stderr))
        return problems

    produced = [line for line in result.stdout.splitlines() if line.startswith("[")]
    expected = parse_farm_log(farm_log, titles)

    if len(produced) != len(expected):
        problems.append("step count: interpreter %d, native %d"
                        % (len(produced), len(expected)))
    mismatches = []
    for i, (line, (step, native)) in enumerate(zip(produced, expected)):
        m = FARM_LINE_RE.match(line)
        if not m:
            mismatches.append("step %s: malformed output line %r" % (step, line))
            continue
        got = dict(KV_RE.findall(m.group(1)))
        for prop, expected_text in native.items():
            if prop not in got:
                mismatches.append("step %d: missing property %s" % (step, prop))
            elif got[prop] != expected_text:
                mismatches.append("step %d: %s: interpreter %s, native %s"
                                  % (step, prop, got[prop], expected_text))
        if len(mismatches) > 10:
            break
    if mismatches:
        problems.append("%d value mismatches (first 10):\n  %s"
                        % (len(mismatches), "\n  ".join(mismatches[:10])))

    if verbose and not problems:
        print("    %d steps x %d properties ok" % (len(expected), len(expected[0][1])))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description="W1h acceptance test")
    parser.add_argument("--scenario", action="append", default=[],
                        help="verify only these scenarios")
    parser.add_argument("--keep", action="store_true",
                        help="keep the scratch work dir")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    manifest = load_manifest()
    titles = title_map()
    scenarios = manifest["scenarios"]
    names = args.scenario or sorted(scenarios.keys())

    # The `worldfiles` pins are hand-maintained (record_scenario.py writes the
    # `scenarios` block only), so audit them against disk on every run.
    pin_problems = worldfile_pins(manifest)
    for problem in pin_problems:
        print("FAIL %s" % problem)

    workdir = tempfile.mkdtemp(prefix="cppprops-verify-")
    failures = 0
    try:
        for name in names:
            if name not in scenarios:
                print("FAIL %s: not in the manifest" % name)
                failures += 1
                continue
            problems = verify_scenario(name, scenarios[name], manifest, titles,
                                       workdir, args.verbose)
            if problems:
                failures += 1
                print("FAIL %s" % name)
                for problem in problems:
                    print("     %s" % problem.replace("\n", "\n     "))
            else:
                print("PASS %s (%d steps, no compiler at run time)"
                      % (name, scenarios[name]["steps_recorded"]))
    finally:
        if args.keep:
            print("work dir: %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    print("%d/%d scenarios pass" % (len(names) - failures, len(names)))
    pins = manifest.get("worldfiles", {})
    if pin_problems:
        print("%d/%d worldfile pins match disk"
              % (len(pins) - len(pin_problems), len(pins)))
        return 1
    print("%d/%d worldfile pins match disk" % (len(pins), len(pins)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
