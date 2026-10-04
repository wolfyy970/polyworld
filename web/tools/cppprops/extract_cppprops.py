#!/usr/bin/env python3
"""extract_cppprops.py - worldfile + schema -> cppprops spec (W1h).

Build-time replacement for the native run-time code generation in
`library/proplib/cppprops.cc`:

    native:  worldfile -> generated.cc -> make/clang++ -> dlopen   (~6s per run)
    W1h:     worldfile -> cppprops.json -> tools/cppprops/lib/cppprops.mjs

Usage:

    extract_cppprops.py --worldfile WF --schema WFS [--out spec.json]
                        [--emit-cc out.cc] [--crosscheck native_generated.cc]
                        [--schema-name NAME] [--param NAME=VALUE ...] [--quiet]

`--crosscheck` byte-compares the emitted C++ against a `generated.cc` captured
from a real native run.  A mismatch prints the first differing line and exits
non-zero: the emitted text is the contract that the rest of the pipeline
(metadata indices, dynamic bodies) is validated against.

`--schema-name` is the schema *document's own name* (`Document::getName()`,
which `DocumentLocation::getDescription()` prints), not the path it is read
from.  It only surfaces in a `$[gene, …]` expansion's error text
(`cppprops.cc:873`; the recorded `gene_dyn.generated.cc:153` spells it
`./etc/worldfile.wfs:1619`), because native `Simulation.cc:270` builds the
schema with that literal.  Default: the `--schema` path as given.

Exit codes: 0 ok, 1 mismatch/parse error, 2 usage.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import proplib  # noqa: E402
import cppprops_model as M  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Extract a build-time cppprops spec from a worldfile.")
    parser.add_argument("--worldfile", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--out", default=None, help="write the JSON spec here")
    parser.add_argument("--emit-cc", default=None,
                        help="write the generated C++ (native text) here")
    parser.add_argument("--crosscheck", default=None,
                        help="byte-compare the emitted C++ against this file")
    parser.add_argument("--schema-name", default=None, metavar="NAME",
                        help="the schema document's own name for location "
                             "descriptions (native `Document::getName()`; "
                             "`./etc/worldfile.wfs` is what a Simulation run "
                             "spells).  Default: the --schema path as given")
    parser.add_argument("--param", action="append", default=[],
                        metavar="NAME=VALUE",
                        help="worldfile parameter (native ParameterMap)")
    parser.add_argument("--replay", default=None, metavar="STATE.json",
                        help="after extracting, replay this state trace through "
                             "run_cppprops.mjs and print the native-formatted values "
                             "(the one-command 'worldfile -> property values' path)")
    parser.add_argument("--replay-format", default="native",
                        choices=["native", "json", "values"])
    parser.add_argument("--runtime-map", default=None, metavar="MAP.json",
                        help="with --replay: map runtime property names to state keys")
    parser.add_argument("--node", default="node", help="node executable for --replay")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    parameters = {}
    for item in args.param:
        if "=" not in item:
            parser.error("--param expects NAME=VALUE")
        name, value = item.split("=", 1)
        parameters[name] = value

    try:
        model = M.build_model(args.schema, args.worldfile, parameters=parameters or None,
                              schema_name=args.schema_name)
        source = M.emitted_source(model)
    except proplib.PropLibError as ex:
        print("error: %s" % ex, file=sys.stderr)
        return 1

    spec = M.cppprops_json(model, args.schema, args.worldfile)

    if args.emit_cc:
        with open(args.emit_cc, "w") as f:
            f.write(source)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(spec, f, indent=1, sort_keys=False)
            f.write("\n")

    status = 0
    if args.crosscheck:
        with open(args.crosscheck) as f:
            native = f.read()
        if native == source:
            if not args.quiet:
                print("crosscheck: byte-identical to %s (%d bytes)"
                      % (args.crosscheck, len(source)))
        else:
            status = 1
            print("crosscheck: MISMATCH vs %s" % args.crosscheck, file=sys.stderr)
            diff = list(difflib.unified_diff(
                native.splitlines(True), source.splitlines(True),
                fromfile=args.crosscheck, tofile="<emitted>", n=2))
            shown = 0
            for chunk in diff:
                sys.stderr.write(chunk)
                shown += 1
                if shown > 60:
                    sys.stderr.write("... (diff truncated)\n")
                    break

    if args.replay:
        # The evaluator half is compiler-free by construction: it imports
        # lib/cppprops.mjs and reads the spec.  This convenience path exists so
        # that one command can go from a worldfile to property values.
        if args.out is None:
            fd, spec_path = tempfile.mkstemp(prefix="cppprops-", suffix=".json")
            os.close(fd)
            with open(spec_path, "w") as f:
                json.dump(spec, f)
        else:
            spec_path = args.out
        cmd = [args.node, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "run_cppprops.mjs"),
               "--spec", spec_path, "--state", args.replay,
               "--format", args.replay_format, "--quiet"]
        if args.runtime_map:
            cmd += ["--runtime-map", args.runtime_map]
        if not args.quiet:
            print("replay: %s --spec %s --state %s"
                  % (os.path.basename(cmd[1]), spec_path, args.replay))
        replayed = subprocess.run(cmd)
        if replayed.returncode != 0:
            status = replayed.returncode
        if args.out is None:
            os.unlink(spec_path)

    if not args.quiet:
        dyn = [p for p in spec["properties"] if p["kind"] == "Dynamic"]
        print("properties: %d (%d dynamic, %d runtime)"
              % (len(spec["properties"]), len(dyn),
                 len(spec["properties"]) - len(dyn)))
        for prop in dyn:
            d = prop["dynamic"]
            bad = sorted(set(d["updateUnportableSymbols"]) | set(d["initUnportableSymbols"]))
            print("  [%d] %s %s initial=%r portable=%s%s"
                  % (prop["index"], prop["name"], prop["datalibType"],
                     d["initial"], d["portable"],
                     (" unportable=%s" % ",".join(bad)) if bad else ""))

    return status


if __name__ == "__main__":
    sys.exit(main())
