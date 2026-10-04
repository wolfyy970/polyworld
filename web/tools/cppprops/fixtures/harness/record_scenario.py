#!/usr/bin/env python3
"""record_scenario.py - record native cppprops ground truth for a scenario (W1h).

The native build compiles its property library into `run/.cppprops` at *run*
start (clang++ + dlopen), and the only place property *values* surface is the
FarmMonitor (`library/monitor/Monitor.cc`), which is active only when
`PWFARM_STATUS` is set.  This script reproduces the recording used by
`fixtures/`:

  * it runs the native binary from a **mirror tree** (symlinks to the native
    `Polyworld`, `etc/`, `lib/`, `src/`, plus this directory's `term.mf` and the
    worldfile), so the native tree is never modified and `run/` lands in a
    scratch directory;
  * `term.mf` sets `StatusText.FrequencyDisplay 1` and `Farm.Frequency 1`, so a
    run yields one sample per step instead of 4, and lists the properties to
    sample (native names) with the short titles used in the farm log;
  * `PWFARM_STATUS` is a logger this script installs; the FarmMonitor invokes it
    per step and it appends the formatted line.

Two independent per-step traces come out of one run:

  farm log   `PropertyMetadata::toString()` through the cppprops path   -> the oracle
  state      `Simulation::getStatusText()` (step / agents / food, plus
             `metabolism<j>` per definition when the run has >1 of them,
             plus the food-patch counts below)
             -> the evaluator's input

The state trace also carries the per-step **food-patch agent counts** (the
`  FP<i> <foodCount> <agentInsideCount> <inside+neighborhood> ...` lines that
`getStatusText` prints when `fCalcFoodPatchAgentCounts` is set - it is
hard-coded true in the `TSimulation` ctor, so every run has them).  They are
`FoodPatch::agentInsideCount`, which is an input of the `FoodPatchTokenRing`
binding, and they are the reason `parse_status` keeps the domain counter: each
step record gains

    "foodPatches": {"<domain>.<patch>": {"foodCount": …,
                                         "agentInsideCount": …,
                                         "agentNeighborhoodCount": …}}

`agentNeighborhoodCount` is the printed `inside+neighborhood` column minus
`inside` (that is how the native stat accumulates it:
`Patch::checkIfAgentIsInsideNeighborhood` counts agents in the outer range and
*outside* the patch).  The keys are the binding's own `<domain>.<patch>`
addressing, so a consumer can build an engine table straight from the trace.

PHASE: the counts are accumulated by `DeathAndStats()` - reached from
`Interact()`, which `Step()` runs *after* the agents have moved - while
`CppProperties::update()` (and therefore the token ring) runs at the *start* of
`Step()`.  So the ring reads the counts of the previous step, and the values on
record at step N are the ring's input at step N+1 (step 1 reads the initial
zeros).  `fixtures/manifest.json` records that shift per scenario
(`engineFromState.stepShift`); `verify_cppprops.py` applies it.
             `metabolism<j>` per definition when the run has >1 of them)
             -> the evaluator's input

Usage:

    record_scenario.py --native /path/to/polyworld --worldfile WF \\
        --name SCENARIO [--args '--Vision False'] [--out DIR]

Writes, into --out (default: tools/cppprops/fixtures):

    native/<name>.generated.cc    verbatim run/.cppprops/generated.cc
    native/<name>.farm.log        native property values, one line per step
    native/<name>.generange.txt   verbatim run/genome/meta/generange.txt (the
                                  run's gene ranges; `Gene.cc:226`) - the file a
                                  `$[gene, NAME, min|max]`-bound property is
                                  served from (manifest `genesFromGenerange`)
    state/<name>.state.json       per-step {step, agents, food[, metabolism<j>]}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.dirname(HERE)

STATUS_KEYS = ("agents", "food")
STATUS_RE = re.compile(r"^\s*(-?[A-Za-z_][\w]*)\s*=\s*(-?[\d.]+)")
# ` -<Name> = <n>` lines that are NOT metabolisms: `Simulation::getStatusText`
# prints fNumberCreatedRandom/2Fit/1Fit and the death-cause counters with the
# same shape.  They sit *outside* the `agents` .. `food` window the metabolism
# block occupies (Simulation.cc:4894-4904 vs :4942-4949), so the window is the
# gate; this set only keeps a metabolism that shares one of those names from
# being silently dropped (a real limitation, not a silent one).
DASH_RE = re.compile(r"^\s+-([A-Za-z_][\w]*)\s*=\s*(-?[\d.]+)\s*$")
NON_METABOLISM_DASH_KEYS = frozenset((
    "random", "two", "one",                      # fNumberCreated{Random,2Fit,1Fit}
    "age", "energy", "fight", "eat", "edge", "smite", "patch",  # death causes
))
# The native prints the per-metabolism block only when
# `Metabolism::getNumberOfDefinitions() > 1`; mirror that gate.
METABOLISM_MIN_DEFINITIONS = 2
# The food-patch block: `  Domain <i>` then one line per patch
#   `  FP<i> <foodCount> <agentInsideCount> <inside+neighborhood> <pct…>`
# (`Simulation.cc` `getStatusText`, ~:5183-5214).  `FP*` is the per-domain
# total line and is deliberately not matched (the regex needs the index).
DOMAIN_RE = re.compile(r"^\s*Domain\s+(\d+)\s*$")
FOOD_PATCH_RE = re.compile(r"^\s*FP(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\b")
FARM_RE = re.compile(r"([A-Za-z_][\w\[\].]*)=([^\s\]]*)")


def parse_status(text):
    """Per-step {step, agents, food, metabolism<i>, foodPatches} + metabolism names.

    Returns `(steps, metabolism_names)`.

    The metabolism counts are printed by `Simulation::getStatusText` from
    `fNumberAliveWithMetabolism[i]` for `i = 0 .. getNumberOfDefinitions()-1`
    (`Simulation.cc:4894-4904`, immediately after the `agents` line and before
    the `food` line *of the same step*), and only when there is more than one
    definition.  The printed order is `Metabolism::get(0), get(1), ...`, i.e. the
    order the worldfile defines them in (`Simulation::define`/`Metabolism::define`
    assign `index = position`), so `metabolism0` is `Metabolism::get(0)->index`
    -- the very index the `AgentMetabolisms[0].MetabolismAgentCount` cppsym reads.

    Nothing else that starts with ` -` is inside that window, which is why the
    window (`pending`, opened by `agents` and closed by `food`) and not the
    line shape is the gate.  A run with one metabolism records no such keys.
    """
    steps = []
    current: "dict | None" = None
    names = []      # definition order, taken from the first step that has them
    pending = None  # ` -<Name>` candidates seen since this step's `agents` line
    domain = 0      # the `  Domain <i>` heading the FP lines belong to
    for line in text.splitlines():
        if pending is not None:
            dash = DASH_RE.match(line)
            if dash:
                if dash.group(1) not in NON_METABOLISM_DASH_KEYS:
                    number = float(dash.group(2))
                    pending.append((dash.group(1),
                                    int(number) if number.is_integer() else number))
                continue
        m = STATUS_RE.match(line)
        if not m:
            # The food-patch block (`  Domain <i>` then `  FP<i> …`) is printed
            # by the same `getStatusText` call, after the step's `Rate` line -
            # *not* inside the `agents`..`food` window, and with no `=`.
            if current is not None:
                heading = DOMAIN_RE.match(line)
                if heading:
                    domain = int(heading.group(1))
                    continue
                patch = FOOD_PATCH_RE.match(line)
                if patch:
                    inside = int(patch.group(3))
                    current.setdefault("foodPatches", {})[
                        "%d.%d" % (domain, int(patch.group(1)))] = {
                            "foodCount": int(patch.group(2)),
                            "agentInsideCount": inside,
                            # the native prints inside+neighborhood; the
                            # Patch field counts only the outer ring
                            "agentNeighborhoodCount": int(patch.group(4)) - inside,
                        }
            continue
        key, value = m.group(1), m.group(2)
        if key == "step":
            if current is not None:
                steps.append(current)
            current = {"step": int(float(value))}
            pending = None
            domain = 0
        elif current is not None and key in STATUS_KEYS:
            if key == "agents":
                pending = []
            else:  # "food": the metabolism block is complete
                if pending is not None and len(pending) >= METABOLISM_MIN_DEFINITIONS:
                    if not names:
                        names = [name for name, _ in pending]
                    for index, (_, count) in enumerate(pending):
                        current["metabolism%d" % index] = count
                pending = None
            number = float(value)
            current[key] = int(number) if number.is_integer() else number
        else:
            pending = None
    if current is not None:
        steps.append(current)
    return steps, names


def make_mirror(native, worldfile, workdir):
    mirror = os.path.join(workdir, "mirror")
    os.makedirs(mirror, exist_ok=True)
    for entry in ("Polyworld", "etc", "lib", "src"):
        src = os.path.join(native, entry)
        if not os.path.exists(src):
            raise SystemExit("native tree has no %s" % src)
        dst = os.path.join(mirror, entry)
        if not os.path.lexists(dst):
            os.symlink(src, dst)
    shutil.copy(os.path.join(HERE, "term.mf"), os.path.join(mirror, "term.mf"))
    shutil.copy(os.path.join(HERE, "PWFARM_STATUS"), os.path.join(mirror, "PWFARM_STATUS"))
    os.chmod(os.path.join(mirror, "PWFARM_STATUS"), 0o755)
    return mirror


def run_native(native, worldfile, args, workdir, timeout):
    mirror = make_mirror(native, worldfile, workdir)
    farm_log = os.path.join(workdir, "farm.log")
    open(farm_log, "w").close()

    env = dict(os.environ)
    env["PWFARM_STATUS"] = os.path.join(mirror, "PWFARM_STATUS")
    env["PWFARM_STATUS_LOG"] = farm_log
    # FarmMonitor::step() shells out to `bash -c 'PWFARM_STATUS ...'`, i.e. it
    # resolves the logger through PATH - put the mirror first.
    env["PATH"] = mirror + os.pathsep + env.get("PATH", "")

    cmd = [os.path.join(mirror, "Polyworld"), "--ui", "term"] + list(args) + [worldfile]
    with open(os.path.join(workdir, "stdout.txt"), "w") as out, \
            open(os.path.join(workdir, "stderr.txt"), "w") as err:
        proc = subprocess.Popen(cmd, cwd=mirror, env=env, stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err)
        deadline = time.time() + timeout
        while proc.poll() is None and time.time() < deadline:
            time.sleep(1)
        if proc.poll() is None:
            proc.send_signal(signal.SIGKILL)
            proc.wait()
            print("warning: native run exceeded %ds and was killed" % timeout,
                  file=sys.stderr)

    status = open(os.path.join(workdir, "stdout.txt"), "rb").read().decode("latin-1")
    return status, farm_log


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", required=True, help="native polyworld tree")
    parser.add_argument("--worldfile", required=True)
    parser.add_argument("--name", required=True, help="scenario name")
    parser.add_argument("--args", default="", help="extra native args, e.g. '--Vision False'")
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--workdir", default=None)
    args = parser.parse_args(argv)

    workdir = args.workdir or tempfile.mkdtemp(prefix="cppprops-record-")
    os.makedirs(workdir, exist_ok=True)
    extra = [a for a in args.args.split() if a]
    # the native binary runs with cwd=<mirror>, so the worldfile must be absolute
    worldfile = os.path.abspath(args.worldfile)

    status, farm_log = run_native(args.native, worldfile, extra, workdir, args.timeout)

    steps, metabolism_names = parse_status(status)
    farm_lines = [l for l in open(farm_log).read().splitlines() if l.strip()]

    native_dir = os.path.join(args.out, "native")
    state_dir = os.path.join(args.out, "state")
    os.makedirs(native_dir, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)

    generated_src = os.path.join(workdir, "mirror", "run", ".cppprops", "generated.cc")
    if not os.path.exists(generated_src):
        raise SystemExit("no run/.cppprops/generated.cc - did the run start? (%s)"
                         % os.path.join(workdir, "stderr.txt"))
    generated_dst = os.path.join(native_dir, "%s.generated.cc" % args.name)
    shutil.copy(generated_src, generated_dst)

    # The gene ranges the run wrote (`Logs.cc:1483` -> run/genome/meta/generange.txt,
    # `Gene.cc:226` `__InterpolatedGene::printRanges`).  A scenario whose spec has a
    # `$[gene, NAME, min|max]` symbol is *served* from this file
    # (`fixtures/manifest.json` `genesFromGenerange` -> `verify_cppprops.py` ->
    # `run_cppprops.mjs --engine`), so it is recorded with the rest: keeping it here
    # is what stops a re-record from refreshing `generated.cc`/`farm.log`/`state`
    # while the range a binding serves silently goes stale.
    generange_src = os.path.join(workdir, "mirror", "run", "genome", "meta", "generange.txt")
    generange_dst = None
    if os.path.exists(generange_src):
        generange_dst = os.path.join(native_dir, "%s.generange.txt" % args.name)
        shutil.copy(generange_src, generange_dst)

    farm_dst = os.path.join(native_dir, "%s.farm.log" % args.name)
    with open(farm_dst, "w") as f:
        f.write("\n".join(farm_lines) + "\n")

    state = {
        "formatVersion": 1,
        "scenario": args.name,
        "recordedBy": "tools/cppprops/fixtures/harness/record_scenario.py",
        "stateSource": "run status text (Simulation::getStatusText), independent of the cppprops path",
        "valueSource": "native FarmMonitor -> PropertyMetadata::toString()",
        "note": "state traces are the evaluator's INPUT; farm logs are the EXPECTED OUTPUT",
        "steps": steps,
    }
    if any("foodPatches" in record for record in steps):
        # Per-step FoodPatch counters, keyed `<domain>.<patch>` (the binding's
        # addressing).  `agentInsideCount` is one of the FoodPatchTokenRing
        # binding's engine inputs; it is the value that `CppProperties::update()`
        # reads at the *start* of step N+1 (see the manifest's engineFromState).
        state["foodPatchesKeyNote"] = (
            "steps[i][\"foodPatches\"][\"<domain>.<patch>\"][\"agentInsideCount\"] "
            "= FoodPatch::agentInsideCount as printed by Simulation::getStatusText "
            "for step i; agentNeighborhoodCount is the printed "
            "inside+neighborhood column minus inside")
    if metabolism_names:
        # Only when the run defines more than one metabolism (the native gate):
        # steps[i]["metabolism<j>"] is fNumberAliveWithMetabolism[j] as printed for
        # `Metabolism::get(j)` -- the value the `AgentMetabolisms[j]` cppsym reads.
        state["metabolismNames"] = metabolism_names
        state["metabolismKeyNote"] = (
            "metabolism<j> = fNumberAliveWithMetabolism[ Metabolism::get( j )->index ]; "
            "the printed order IS the definition order, and the names above are what "
            "the run's status text printed for those indices")
    state_dst = os.path.join(state_dir, "%s.state.json" % args.name)
    with open(state_dst, "w") as f:
        json.dump(state, f, indent=1)
        f.write("\n")

    prop = sorted({name for line in farm_lines
                   for name, _ in FARM_RE.findall(line)})
    print("scenario %s: %d farm lines, %d state samples, %d properties"
          % (args.name, len(farm_lines), len(steps), len(prop)))
    print("  worldfile %s" % args.worldfile)
    print("  %s" % generated_dst)
    if generange_dst:
        print("  %s" % generange_dst)
    print("  %s" % farm_dst)
    print("  %s" % state_dst)
    print("  properties: %s" % ", ".join(prop))
    if metabolism_names:
        print("  metabolisms (definition order): %s"
              % ", ".join("metabolism%d=%s" % (i, n)
                          for i, n in enumerate(metabolism_names)))
    print("  workdir: %s" % workdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
