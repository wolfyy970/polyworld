#!/usr/bin/env python3
"""Register a scenario for a lane: a worldfile + native args + an oracle tier.

Usage
    python3 tools/add_scenario.py <name> --worldfile <path-in-native-tree> [options]
    ./oracle/run_parity.sh add <name> --worldfile ... --record

Examples
    # a fast vision-on smoke scenario for the vision/retina lanes
    ./oracle/run_parity.sh add microtest_von \
        --worldfile worldfiles/tests/low-spec-pc/microtest.wf \
        --tier B --notes "vision on; movie.pmv ignored" --record

    # the same world with a parameter override: args are passed verbatim, so any
    # `--Key value` the native binary accepts can be pinned per scenario. Use the
    # `--arg=--Key` (equals) form -- plain `--arg --Vision` makes argparse treat
    # the key as the option's value and exits 2.
    ./oracle/run_parity.sh add microtest_voff_norecord \
        --worldfile worldfiles/tests/low-spec-pc/microtest.wf \
        --arg=--Vision --arg=False --tier A --record

Where the registration lives
    tools/scenarios.d/<name>.json -- one file per scenario, so two lanes writing
    at the same time cannot corrupt each other's registration. The harness merges
    these over the read-only base registry (oracle/scenarios/scenarios.json).

PORT-NOTE(parity-runner/overlay-registry): lanes must be able to add scenarios
without editing oracle/scenarios/scenarios.json -- oracle/** is read-only for lane
agents (PORT_SPEC ground rule 8) and a shared JSON file is a merge conflict with
10-20 writers. Overlays shadow the base by name; shadowing a base scenario needs
--force and is reported in the file itself.

PORT-NOTE(parity-runner/tier-b-ignore): a tier-B (vision on) scenario defaults to
`"ignore": ["run/movie.pmv"]`. Measured in PARITY.md: with vision on, movie.pmv is
the one artifact that differs between two native runs of the same world, so a
tier-B golden that compares it is not an oracle. --no-default-ignore opts out.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_common as pc  # noqa: E402

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")


def parse_args(argv):
    parser = argparse.ArgumentParser(description="register a parity scenario for a lane")
    parser.add_argument("name", help="scenario name (lowercase, [a-z0-9_])")
    parser.add_argument("--worldfile", required=True, help="worldfile path relative to the native tree")
    parser.add_argument("--tier", default="A", choices=["A", "B"], help="A = byte-exact tier, B = statistical (vision on)")
    parser.add_argument("--arg", action="append", default=[], dest="extra_args",
                        help="one native arg, e.g. --arg --MaxSteps --arg 500 (repeatable)")
    parser.add_argument("--ignore", action="append", default=[], help="rel-path prefix to ignore at compare time (repeatable)")
    parser.add_argument("--no-default-ignore", action="store_true",
                        help="do not add the tier-B run/movie.pmv default ignore")
    parser.add_argument("--notes", help="free-text note stored with the scenario")
    parser.add_argument("--record", action="store_true", help="record the golden right after registering")
    parser.add_argument("--force", action="store_true", help="overwrite an existing registration (and golden, when --record)")
    parser.add_argument("--native", help="native Polyworld tree")
    parser.add_argument("--web", help="web repo root")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def normalize_args(raw):
    """Accept `--arg --Vision --arg False` and the compact `--Vision False` passthrough."""
    if len(raw) % 2 != 0:
        raise pc.ParityError("args must come in --Key value pairs (got odd count: %s)" % " ".join(raw))
    out = []
    for i in range(0, len(raw), 2):
        key, value = raw[i], raw[i + 1]
        if not key.startswith("--") or key == "--ui":
            raise pc.ParityError("scenario arg %r must look like --Key value (and --ui is fixed to term)" % key)
        out.extend([key, value])
    return out


def main(argv):
    args = parse_args(argv)
    try:
        web = pc.resolve_web(args.web)
        native = pc.resolve_native(args.native, web)
        if native is None:
            raise pc.ParityError("no native tree")
        if not NAME_RE.match(args.name):
            raise pc.ParityError("scenario name %r must match [a-z0-9_]+" % args.name)
        worldfile = pc.validate_native_worldfile(args.worldfile, native, web)
        scenario_args = normalize_args(args.extra_args)
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    overlay_dir = web / "tools" / "scenarios.d"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    target = overlay_dir / ("%s.json" % args.name)
    base = pc.load_registry(web)["scenarios"]
    pre_existing = args.name in base
    if pre_existing and not args.force:
        print("parity: error: scenario %r is already registered (%s); pass --force to shadow it with an overlay"
              % (args.name, base[args.name].get("_source")), file=sys.stderr)
        return 2

    ignore = list(args.ignore)
    if not args.no_default_ignore:
        for pat in pc.tier_default_ignore(args.tier):
            if pat not in ignore:
                ignore.append(pat)

    entry = {"name": args.name, "worldfile": worldfile, "args": scenario_args, "tier": args.tier}
    if ignore:
        entry["ignore"] = ignore
    if args.no_default_ignore:
        entry["no_default_ignore"] = True
    if args.notes:
        entry["notes"] = args.notes
    if pre_existing:
        entry["shadowed_base"] = base[args.name].get("_source")
    entry["registered_by"] = "tools/add_scenario.py"
    entry["registered_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    doc = {
        "_comment": "Lane-registered parity scenario (W1f harness). Merged over "
                    "oracle/scenarios/scenarios.json by tools/parity_common.py; one file per scenario.",
        "scenarios": [entry],
    }
    if target.exists() and not args.force:
        print("parity: error: %s exists; pass --force to rewrite this registration" % target, file=sys.stderr)
        return 2
    target.write_text(json.dumps(doc, indent=2) + "\n")

    native_cmd = "%s --ui term %s %s" % (pc.NATIVE_BINARY, " ".join(scenario_args), worldfile)
    print("registered %s -> %s" % (args.name, target))
    print("  native command : %s" % native_cmd)
    print("  tier           : %s%s" % (args.tier, "  (ignore: %s)" % ", ".join(ignore) if ignore else ""))
    print("  next           : ./oracle/run_parity.sh %s --record" % args.name)

    if args.record:
        cmd = [sys.executable, str(Path(__file__).resolve().parent / "record_oracle.py"),
               "--scenario", args.name, "--native", str(native), "--web", str(web)]
        if args.force:
            cmd.append("--force")
        print("recording golden ...")
        proc = subprocess.run(cmd)
        if proc.returncode != 0:
            print("parity: error: recording failed (exit %d); registration is in place, re-run "
                  "`./oracle/run_parity.sh %s --record`" % (proc.returncode, args.name), file=sys.stderr)
            return proc.returncode
        print("golden recorded: %s" % pc.golden_dir(args.name, web))

    if args.json:
        print(json.dumps({"scenario": entry, "overlay": str(target)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
