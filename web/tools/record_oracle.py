#!/usr/bin/env python3
"""Record golden masters from the native Polyworld build.

Usage
    python3 tools/record_oracle.py <scenario> [--force]
    python3 tools/record_oracle.py --all
    python3 tools/record_oracle.py --scenario <name> --candidate-out <dir>   # stage, do not publish
    ./oracle/run_parity.sh <scenario> --record                               # the lane-facing form

What it does, in order (all of it under the native-run lock):
  1. move the native tree's `run/` aside -> `run.previous.<epoch>` (never deleted:
     it is the previous native result and the only copy of it);
  2. run `<native>/Polyworld --ui term <scenario args> <worldfile>` with cwd=native;
  3. snapshot the resulting `run/` tree into `oracle/<scenario>/run/` plus
     stdout.txt, stderr.txt and meta.json, and write `run/manifest.sha256`;
  4. if `oracle/<scenario>/` already exists: refuse unless --force, and with
     --force move it aside to `oracle/_native_previous/<scenario>.previous.<epoch>`
     (a golden is never deleted, and never silently overwritten).

PORT-NOTE(parity-runner/record-isolation): the old single-shot script deleted the
previous `oracle/<scenario>/` with shutil.rmtree on every record. That turns a
re-record into an unrecoverable loss of the only known-good artifact, so it is
gone: displacement replaced deletion in both places (native `run/`, golden dir).

PORT-NOTE(parity-runner/native-lock): `Polyworld` always writes to `<native>/run`,
so concurrent recordings would interleave into one tree. All native runs take an
fcntl lock on `<native>/.parity-native.lock` and wait for each other instead.

PORT-NOTE(parity-runner/stdout-encoding): stdout/stderr are decoded as latin-1.
The native status text contains bytes (the "+/-" lifespan glyph) that are not
UTF-8; latin-1 is byte-preserving, so a recorded stdout.txt round-trips exactly.
stdout/stderr are NOT part of the frozen contract (PORT_SPEC freezes run/**).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_common as pc  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description="record goldens from the native build")
    parser.add_argument("positional", nargs="*",
                        help="scenario name (lane form). Legacy positional native/web paths are also accepted.")
    parser.add_argument("--scenario", action="append", default=[], help="scenario name (repeatable)")
    parser.add_argument("--all", action="store_true", help="record every registered scenario")
    parser.add_argument("--native", help="native Polyworld tree (default: $POLYWORLD_NATIVE, parity.config.json, ../polyworld)")
    parser.add_argument("--web", help="web repo root (default: this repo)")
    parser.add_argument("--candidate-out", help="record into this directory instead of publishing oracle/<scenario>/")
    parser.add_argument("--force", action="store_true", help="re-record over an existing golden (it is moved aside, not deleted)")
    parser.add_argument("--timeout", type=int, default=pc.DEFAULT_TIMEOUT_SEC, help="per-run timeout in seconds")
    parser.add_argument("--json", action="store_true", help="machine-readable summary on stdout")
    return parser.parse_args(argv)


def resolve_selection(args, reg, web):
    names = list(args.scenario)
    legacy = []
    for item in args.positional:
        path = Path(item)
        if path.is_dir() or "/" in item:
            legacy.append(item)
        else:
            names.append(item)
    if legacy:
        # pre-harness CLI was: record_oracle.py [native_dir] [web_dir] [only_scenario]
        if legacy and not args.native:
            args.native = legacy.pop(0)
        if legacy and not args.web:
            args.web = legacy.pop(0)
        for item in legacy:
            names.append(item)
    if args.all or not names:
        names = list(reg["scenarios"].keys())
    unknown = [n for n in names if n not in reg["scenarios"]]
    if unknown:
        raise pc.ParityError("unknown scenario(s): %s (registered: %s)"
                             % (", ".join(unknown), ", ".join(sorted(reg["scenarios"])) or "none"))
    return names


def native_command(native, scenario):
    return [str(native / pc.NATIVE_BINARY), "--ui", "term"] + list(scenario.get("args", [])) + [scenario["worldfile"]]


def record_one(scenario, reg, native, web, args, log):
    name = scenario["name"]
    cmd = native_command(native, scenario)
    native_run = pc.native_run_dir(native)
    excludes = pc.record_excludes(scenario, reg)

    if args.candidate_out:
        stage_root = Path(args.candidate_out)
        # t_37bf7212: a staging root is never a golden path -- not the oracle root, not a
        # scenario dir, not a run tree, and not a worktree's symlink into one.
        pc.refuse_golden_candidate(stage_root, "--candidate-out", web)
        if stage_root.exists() and any(stage_root.iterdir()):
            raise pc.ParityError("--candidate-out %s is not empty; refusing to mix staged runs" % stage_root)
    else:
        stage_root = None

    golden = pc.golden_dir(name, web)
    displaced = None
    if stage_root is None and golden.exists() and not args.force:
        raise pc.ParityError(
            "%s already exists; refusing to overwrite a golden. Re-record the same scenario with "
            "`--force` (the old one is moved to %s/%s.previous.<epoch>, not deleted), "
            "or register a new scenario name." % (golden, pc.displaced_dir(web), name)
        )

    record = {"scenario": name, "golden": str(golden) if stage_root is None else str(stage_root)}
    with pc.native_lock(native, timeout=args.timeout, log=log, purpose="recording %s" % name) as lock:
        record["lock_wait_sec"] = lock.get("waited_sec")
        if native_run.exists():
            record["native_run_displaced"] = str(pc.displace(
                native_run, reason="isolating the native run before %s" % name, log=log))
        started = time.time()
        proc = subprocess.run([str(c) for c in cmd], cwd=str(native), capture_output=True, timeout=args.timeout)
        wall = time.time() - started

    stdout = proc.stdout.decode("latin-1")
    stderr = proc.stderr.decode("latin-1")
    end_reason = None
    if (native_run / "endReason.txt").exists():
        end_reason = (native_run / "endReason.txt").read_text().strip()

    record.update({"command": " ".join(str(c) for c in cmd), "cwd": str(native),
                   "exit_code": proc.returncode, "wall_sec": round(wall, 2),
                   "end_reason": end_reason, "recorded": time.strftime("%Y-%m-%dT%H:%M:%S")})

    if proc.returncode != 0:
        record["status"] = "native-failed"
        record["stderr_tail"] = stderr[-2000:]
        log.write("parity: native run for %s exited %d; not publishing\n" % (name, proc.returncode))
        return record
    if not native_run.is_dir():
        record["status"] = "no-run-dir"
        return record

    # t_37bf7212: build the tree in a staging directory, verify it against its own manifest, and
    # only then move it into place. `oracle/_t_record_<scenario>_<pid>` for a published record
    # (the .gitignore prefix), or the caller's explicit --candidate-out. A golden is never
    # assembled in place, and a lane reading in parallel sees either no tree or a complete one.
    staged = stage_root if stage_root is not None else pc.staging_dir(name, web)
    if staged.exists():
        if stage_root is not None:
            raise pc.ParityError("--candidate-out %s already exists; refusing to mix staged runs" % staged)
        shutil.rmtree(str(staged), ignore_errors=True)  # leftovers of a crashed attempt
    staged.mkdir(parents=True, exist_ok=True)
    record["staged_at"] = str(staged)

    try:
        (staged / "stdout.txt").write_text(stdout)
        (staged / "stderr.txt").write_text(stderr)
        count, _ = pc.write_manifest(staged / "run", native_run, excludes)
        meta = dict(record)
        meta.update({"files_hashed": count, "tier": scenario.get("tier"),
                     "manifest_excludes": excludes, "worldfile": scenario["worldfile"],
                     "args": list(scenario.get("args", [])),
                     "runner": "tools/record_oracle.py",
                     "scenario_source": scenario.get("_source")})
        (staged / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

        # stage -> verify: nothing is published until the staged tree hashes to the manifest it
        # just wrote (a short copy or a torn file cannot become a golden).
        hashed = pc.verify_manifest_tree(staged / "run")

        if stage_root is None:
            # install: move the verified tree into place, one rename. --force displaces the
            # previous golden first (it is moved aside to oracle/_native_previous, never deleted).
            if golden.exists():
                displaced = pc.displace(golden, pc.displaced_dir(web), log=log,
                                        reason="previous golden for %s" % name)
                record["golden_displaced"] = str(displaced)
            pc.install_staged_golden(staged, golden, log=log)
    except BaseException:
        shutil.rmtree(str(staged), ignore_errors=True)
        raise

    record.update({"status": "recorded", "files_hashed": hashed})
    log.write("  %-16s exit=%s files=%5d wall=%6.1fs end_reason=%s\n"
              % (name, proc.returncode, hashed, wall, end_reason))
    return record


def main(argv):
    args = parse_args(argv)
    log = sys.stderr
    try:
        web = pc.resolve_web(args.web)
        reg = pc.load_registry(web)
        names = resolve_selection(args, reg, web)
        native = pc.resolve_native(args.native, web)
        if native is None:
            raise pc.ParityError("no native tree")
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    records = []
    failures = 0
    if args.candidate_out and len(names) > 1:
        print("parity: error: --candidate-out takes exactly one scenario (got %d)" % len(names), file=sys.stderr)
        return 2
    for name in names:
        try:
            record = record_one(reg["scenarios"][name], reg, native, web, args, log)
        except pc.ParityError as exc:
            print("parity: error: %s" % exc, file=sys.stderr)
            return 2
        except subprocess.TimeoutExpired:
            print("parity: error: native run for %s exceeded %ss" % (name, args.timeout), file=sys.stderr)
            failures += 1
            continue
        records.append(record)
        if record.get("status") != "recorded":
            failures += 1

    if args.json:
        print(json.dumps({"native": str(native), "records": records}, indent=2))
    if failures:
        print("parity: record FAILED for %d scenario(s)" % failures, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
