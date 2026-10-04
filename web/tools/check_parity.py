#!/usr/bin/env python3
"""Compare a candidate run/ tree against a recorded golden master.

Usage (lane form -- what the fan-in lanes run):
    ./oracle/run_parity.sh <scenario> --candidate <dir>

Usage (direct, kept backward compatible; this is the DoD line in PORT_SPEC.md):
    python3 tools/check_parity.py --golden oracle/<scenario> --candidate <dir>

Exit codes
    0  every manifested file matches, nothing missing, nothing extra
       (beyond the scenario's ignore patterns and content_compare rules)
    1  parity failure -- the candidate disagrees with the golden
    2  usage/environment problem (no golden, no run tree, bad registry)

`--candidate` may be either a directory containing `run/` or the run tree
itself. Manifest paths are always `run/...`.

Three comparison modes, every one of them counted and printed -- nothing is ever
silently skipped:
  * **byte-compare** (default) -- the file's sha256 must equal the golden's.
  * **content-compare** (opt-in; nothing ships using it) -- for files matching a
    `content_compare` rule (a `run/`-relative glob declared in the registry). The
    registry's *global* rule list is **empty** since 2026-09-29 (the amendment was
    reverted, task `t_9c9fa3de`), so no path is content-compared by default and a
    default run prints no `content-compared` line. `run/**/*.gz` is the example
    rule, not what ships: the mode is reached by a scenario's own
    `content_compare` globs, or by `--content-compare <glob>` for one check. The
    gzip *container* is then free and the **decompressed payload** must be
    byte-equal. Every content-compared file is counted (`content-compared N` plus
    how many containers differ), a payload difference is a `DIFFERS` failure with
    a line/step-level divergence report, and a container the harness cannot read
    is a hard failure. `--no-content-compare` restores strict byte-compare for one
    check -- and it is the *absolute* form: with the flag the check runs with no
    content_compare rule at all, so it wins over a `--content-compare <glob>` given
    on the same command line (t_a59843f4) and no container is exempt. See
    PORT-NOTE(parity-runner/content-compare) in parity_common.py.
  * **ignore** -- files that may differ or be absent without failing, listed as
    `IGNORED` with a count. With vision on that is `run/movie.pmv`; it is still
    hashed in the manifest, so the evidence is kept either way.

PORT-NOTE(parity-runner/excludes): `--scenario NAME` supplies the ignore list and
the scenario's own content-compare rules (documented in parity_common.py). A
registry-level rule -- the *global* list, empty as shipped -- applies with or
without `--scenario`, so the direct `--golden oracle/<scenario> --candidate <dir>`
form of the DoD line behaves exactly like the wrapper's.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_common as pc  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description="candidate run tree vs golden manifest")
    parser.add_argument("--golden", help="golden dir: either oracle/<scenario> or its run/ tree")
    parser.add_argument("--scenario", help="scenario name; fills in --golden and the ignore list")
    parser.add_argument("--candidate", required=True, help="candidate dir containing run/, or the run tree")
    parser.add_argument("--ignore", action="append", default=[], help="extra rel-path prefix to ignore (repeatable)")
    parser.add_argument("--content-compare", action="append", default=[],
                        help="extra run/-relative glob compared by gunzipped content instead of container "
                             "bytes (repeatable; the registry rule applies anyway)")
    parser.add_argument("--no-content-compare", action="store_true",
                        help="disable every content_compare rule, including a --content-compare glob "
                             "given on the same command line: require byte-identical gzip containers")
    parser.add_argument("--no-scenario-defaults", action="store_true",
                        help="do not apply the registry's ignore list (only --ignore/--exclude apply)")
    parser.add_argument("--max-detail", type=int, default=10, help="max rows shown per category (default 10)")
    parser.add_argument("--max-diffs", type=int, default=5, help="max line-level divergence reports (default 5)")
    parser.add_argument("--include-stdout", action="store_true",
                        help="also compare stdout.txt (NOT part of the frozen contract, informational)")
    parser.add_argument("--json", action="store_true", help="machine-readable result on stdout")
    parser.add_argument("--quiet", action="store_true", help="only the summary, the content-compare line and the verdict")
    parser.add_argument("--web", help="override the web repo root (default: this repo)")
    return parser.parse_args(argv)


def classify(rel_values, patterns):
    """Split rel paths into (failures, ignored) by pattern."""
    failing, ignored = [], []
    for rel in rel_values:
        (ignored if pc.is_ignored(rel, patterns) else failing).append(rel)
    return failing, ignored


def diff_detail(golden_run, candidate_run, rel, max_chars=160):
    golden_path = golden_run / rel[len(pc.RUN_PREFIX):]
    candidate_path = pc.candidate_path(candidate_run, rel)
    if not golden_path.is_file() or not candidate_path.is_file():
        return None
    detail = pc.first_line_diff(golden_path, candidate_path, max_line_len=max_chars)
    if detail is None:
        return None
    detail["file"] = rel
    detail["mode"] = "bytes"
    return detail


def content_diff_detail(golden_run, candidate_run, rel, rule, max_chars=160):
    """Divergence report for a content-compared file whose payload differs."""
    entry = {"file": rel, "mode": "gzip-content", "rule": rule}
    golden_path = golden_run / rel[len(pc.RUN_PREFIX):]
    candidate_path = pc.candidate_path(candidate_run, rel)
    try:
        golden_payload, golden_header = pc.read_gzip_payload(golden_path)
        candidate_payload, candidate_header = pc.read_gzip_payload(candidate_path)
    except pc.ParityError as exc:
        entry["reason"] = str(exc)
        return entry
    entry["payload_bytes"] = [len(golden_payload), len(candidate_payload)]
    entry["payload_sha256"] = [pc.payload_digest(golden_payload)[:16], pc.payload_digest(candidate_payload)[:16]]
    entry["container_header"] = [golden_header.hex(), candidate_header.hex()]
    line_detail = pc.first_line_diff_bytes(golden_payload, candidate_payload, max_line_len=max_chars)
    if line_detail:
        entry.update(line_detail)
    else:
        entry["reason"] = "binary or oversized payload; the decompressed payload sha256 differs"
    return entry


def main(argv):
    args = parse_args(argv)
    web = pc.resolve_web(args.web)

    patterns = list(args.ignore)
    scenario = None
    try:
        reg = pc.load_registry(web)
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    if args.scenario:
        scenario = reg["scenarios"].get(args.scenario)
        if scenario is None:
            print("parity: error: unknown scenario %r (try `./oracle/run_parity.sh list`)" % args.scenario,
                  file=sys.stderr)
            return 2
        if not args.no_scenario_defaults:
            for pat in pc.compare_ignores(scenario, reg):
                if pat not in patterns:
                    patterns.append(pat)

    cc_patterns = [] if args.no_content_compare else pc.content_compare_patterns(scenario, reg)
    try:
        for pat in args.content_compare or []:
            pc.check_content_compare_pattern(pat, "--content-compare")
            if pat not in cc_patterns:
                cc_patterns.append(pat)
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    # t_a59843f4: `--no-content-compare` is absolute -- it disables *every* content_compare rule,
    # so it also wins over a `--content-compare <glob>` given on the same command line. The globs
    # are validated above (a malformed one stays a usage error, exit 2) and dropped here. Appending
    # them after the reset above made the pair *select* the glob and run the check in
    # content-compare mode, which is the opposite of what the flag's help says it does: with the
    # flag, no manifested file is exempt and every `.gz` is byte-compared.
    if args.no_content_compare:
        cc_patterns = []

    # t_37bf7212: the frozen golden is never a candidate. Refused here, before anything is read,
    # for both spellings (`oracle/<scenario>` and `oracle/<scenario>/run`) and for a candidate
    # that only *reaches* a golden through a symlink (a lane worktree's oracle).
    try:
        pc.refuse_golden_candidate(args.candidate, "check --candidate", web)
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    golden = Path(args.golden).expanduser() if args.golden else None
    if golden is None:
        if not args.scenario:
            print("parity: error: pass --golden <dir> or --scenario <name>", file=sys.stderr)
            return 2
        golden = pc.golden_dir(args.scenario, web)
    golden = golden if golden.is_absolute() else (web / golden)
    if not golden.exists():
        print("parity: error: no golden at %s -- record one with "
              "`./oracle/run_parity.sh %s --record`" % (golden, args.scenario or "<scenario>"), file=sys.stderr)
        return 2

    try:
        expected, manifest_path = pc.read_manifest(golden)
        golden_run_dir, _ = pc.locate_run_tree(golden)
        candidate_run_dir, candidate_style = pc.locate_run_tree(args.candidate)
    except pc.ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2

    missing, differing, matched = [], [], []
    content = {
        "files": 0,
        "payload_identical": 0,
        "container_identical": 0,
        "container_differing": [],
        "payload_failing": [],
        "unreadable": [],
    }

    for rel in sorted(expected):
        path = pc.candidate_path(candidate_run_dir, rel)
        rule = pc.content_compare_rule(rel, cc_patterns)
        if not path.exists():
            missing.append(rel)
        elif pc.sha256_file(path) == expected[rel]:
            if rule:
                content["files"] += 1
                content["payload_identical"] += 1
                content["container_identical"] += 1
            matched.append(rel)
        elif not rule:
            differing.append(rel)
        else:
            # content-compare: the container is free, the decompressed payload is the contract
            content["files"] += 1
            golden_path = golden_run_dir / rel[len(pc.RUN_PREFIX):]
            try:
                golden_payload, _ = pc.read_gzip_payload(golden_path)
                candidate_payload, _ = pc.read_gzip_payload(path)
            except pc.ParityError as exc:
                content["unreadable"].append({"file": rel, "rule": rule, "reason": str(exc)})
                differing.append(rel)
                continue
            if pc.payload_digest(candidate_payload) == pc.payload_digest(golden_payload):
                content["payload_identical"] += 1
                content["container_differing"].append(rel)
                matched.append(rel)
            else:
                content["payload_failing"].append(rel)
                differing.append(rel)

    present = {pc.RUN_PREFIX + str(p.relative_to(candidate_run_dir))
               for p in candidate_run_dir.rglob("*") if p.is_file() and p.name not in pc.HARNESS_ARTIFACTS}
    extra = sorted(present - set(expected))

    fail_missing, ignore_missing = classify(missing, patterns)
    fail_differ, ignore_differ = classify(differing, patterns)
    fail_extra, ignore_extra = classify(extra, patterns)
    failures = sorted(fail_missing + fail_differ + fail_extra)

    unreadable = {row["file"]: row for row in content["unreadable"]}
    details = []
    for rel in sorted(fail_differ)[: max(args.max_diffs, 0)]:
        if rel in unreadable:
            details.append({"file": rel, "mode": "gzip-content",
                            "rule": unreadable[rel]["rule"], "reason": unreadable[rel]["reason"]})
            continue
        rule = pc.content_compare_rule(rel, cc_patterns)
        if rule:
            details.append(content_diff_detail(golden_run_dir, candidate_run_dir, rel, rule))
            continue
        detail = diff_detail(golden_run_dir, candidate_run_dir, rel)
        if detail:
            details.append(detail)

    stdout_note = None
    if args.include_stdout:
        golden_stdout = golden / "stdout.txt"
        candidate_stdout = Path(args.candidate) / "stdout.txt"
        if golden_stdout.is_file() and candidate_stdout.is_file():
            same = pc.sha256_file(golden_stdout) == pc.sha256_file(candidate_stdout)
            stdout_note = {"compared": True, "identical": same}
            if not same:
                # informational only: PORT_SPEC freezes run/**, not the UI text
                pass
        else:
            stdout_note = {"compared": False}

    total = len(expected)
    content_report = {
        "patterns": cc_patterns,
        "contract": "gzip container free; decompressed payload byte-equal",
        "files": content["files"],
        "payload_identical": content["payload_identical"],
        "container_identical": content["container_identical"],
        "container_differing": len(content["container_differing"]),
        "container_differing_files": content["container_differing"],
        "payload_failing": content["payload_failing"],
        "unreadable": content["unreadable"],
    }
    result = {
        "scenario": args.scenario,
        "golden": str(golden),
        "manifest": str(manifest_path),
        "candidate": str(Path(args.candidate).resolve()),
        "candidate_style": candidate_style,
        "manifest_files": total,
        "matched": len(matched),
        "failed": len(failures),
        "ignored": sorted(ignore_missing + ignore_differ + ignore_extra),
        "missing": sorted(fail_missing),
        "differing": sorted(fail_differ),
        "extra": sorted(fail_extra),
        "ignored_missing": sorted(ignore_missing),
        "ignored_differing": sorted(ignore_differ),
        "ignored_extra": sorted(ignore_extra),
        "ignore_patterns": patterns,
        "content_compare": content_report,
        "divergence": details,
        "stdout": stdout_note,
        "verdict": "PASS" if not failures else "FAIL",
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        label = args.scenario or str(golden)
        print("parity: %s  candidate=%s%s" % (label, result["candidate"],
                                              "" if candidate_style == "parent" else " (run tree given directly)"))
        print("  manifest %s: %d files; ignoring %s"
              % (manifest_path, total, ", ".join(patterns) if patterns else "nothing"))
        print("  match %d/%d  differing=%d  missing=%d  extra=%d  ignored=%d"
              % (len(matched), total, len(fail_differ), len(fail_missing), len(fail_extra),
                 len(result["ignored"])))
        if cc_patterns:
            print("  content-compared %d file(s) [%s]: payload identical %d (container byte-identical %d, "
                  "container differs %d), payload differs %d, unreadable %d"
                  % (content_report["files"], ", ".join(cc_patterns), content_report["payload_identical"],
                     content_report["container_identical"], content_report["container_differing"],
                     len(content_report["payload_failing"]), len(content_report["unreadable"])))
        if not args.quiet:
            for head, items in (("MISSING", fail_missing), ("DIFFERS", fail_differ), ("EXTRA", fail_extra)):
                for rel in sorted(items)[: max(args.max_detail, 0)]:
                    print("  %-7s %s" % (head, rel))
                if len(items) > args.max_detail:
                    print("  %-7s ... and %d more" % (head, len(items) - args.max_detail))
            shown = content_report["container_differing_files"][: max(args.max_detail, 0)]
            for rel in shown:
                print("  %-7s %s  (gzip container differs, payload identical)" % ("CONTENT", rel))
            if len(content_report["container_differing_files"]) > len(shown):
                print("  %-7s ... and %d more (container-only differences)"
                      % ("CONTENT", len(content_report["container_differing_files"]) - len(shown)))
            for detail in details:
                if detail.get("mode") == "gzip-content":
                    print("  CONTENT DIFFERS in %s [content-compare rule %s]"
                          % (detail["file"], detail.get("rule") or "?"))
                    if detail.get("reason"):
                        print("      reason   : %s" % detail["reason"])
                    if detail.get("payload_bytes"):
                        print("      payload  : golden %d B vs candidate %d B (sha256 %s vs %s)"
                              % (detail["payload_bytes"][0], detail["payload_bytes"][1],
                                 detail["payload_sha256"][0], detail["payload_sha256"][1]))
                    if detail.get("line") is not None:
                        where = "line %d" % detail["line"]
                        if detail.get("step") is not None:
                            where += " (step %s)" % detail["step"]
                        if detail.get("column"):
                            where += ", column %s" % detail["column"]
                        print("      payload first divergence at %s" % where)
                        print("      golden   : %s" % detail["golden_line"])
                        print("      candidate: %s" % detail["candidate_line"])
                        if detail.get("note"):
                            print("      note     : %s" % detail["note"])
                    continue
                where = "line %d" % detail["line"]
                if detail.get("step") is not None:
                    where += " (step %s)" % detail["step"]
                if detail.get("column"):
                    where += ", column %s" % detail["column"]
                print("  FIRST DIVERGENCE in %s at %s" % (detail["file"], where))
                print("      golden   : %s" % detail["golden_line"])
                print("      candidate: %s" % detail["candidate_line"])
                if detail.get("note"):
                    print("      note     : %s" % detail["note"])
            if result["ignored"]:
                shown_ignored = result["ignored"][: max(args.max_detail, 0)]
                print("  IGNORED (%d, not part of the contract): %s%s"
                      % (len(result["ignored"]), ", ".join(shown_ignored),
                         " ..." if len(result["ignored"]) > len(shown_ignored) else ""))
            if stdout_note and stdout_note.get("compared"):
                print("  stdout.txt: %s (informational, not frozen)"
                      % ("identical" if stdout_note["identical"] else "differs"))
        print("parity: %s  (%d/%d files)" % (result["verdict"], len(matched) + len(result["ignored"]), total))

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
