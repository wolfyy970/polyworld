#!/usr/bin/env python3
"""Shared plumbing for the per-lane parity harness (owned by lane W1f).

PORT-NOTE(parity-runner): read PORT_SPEC.md before changing any comparison rule
in this file. The contract is byte-exactness of `run/**` for a recorded
scenario; everything here exists to make that checkable by 10-20 lanes that
share one native tree, one native `run/` directory, and one oracle.

What this module holds
----------------------
  * where the native tree and the web tree are            -> resolve_native/_web
  * the scenario registry: oracle/scenarios/scenarios.json (base, read-only)
      + tools/scenarios.d/*.json (lane overlays, one file per scenario)
  * manifest-relative paths <-> filesystem paths           -> locate_run_tree
  * the lock that serialises native `Polyworld` runs       -> native_lock
  * the never-delete rule: displaced artifacts are moved aside, never removed
                                                           -> displace

PORT-NOTE(parity-runner/excludes): there are two different exclusion lists.
  * RECORD excludes (`exclude_from_manifest`) keep volatile files out of the
    manifest when a golden is recorded: run/.cppprops/ (the run-time compiled
    props dylib embeds a build UUID, so its bytes are meaningless).
  * COMPARE ignores (`ignore`) are applied when a candidate is checked against a
    manifest, because a file deliberately left out of the manifest would
    otherwise be reported EXTRA in every candidate that does write it.
    Every tier ignores run/movie.pmv: PORT_SPEC.md's *Frozen surface* declares it
    NOT frozen (free) -- "delta-compressed, incrementally written", and the
    browser version is meant to make recording deterministic by construction
    rather than reproduce the native sampling jitter.
    Measured 2026-09-28 (t_588c28e1): it is written incrementally with frame-delta
    compression on a sampling path that is not pinned to step boundaries, so even
    two native runs of the SAME scenario on this machine can differ in it -- three
    fresh native runs of minitest_voff gave one byte-identical to the golden and
    two differing only in movie.pmv. Comparing it turns the oracle into a coin
    flip at any tier. It is still hashed at record time (the manifest keeps the
    evidence) and the checker reports such files as `ignored` rather than
    silently dropping them; a scenario may still opt out with `no_default_ignore`.
    PORT-NOTE(parity-runner/movie-is-free): this used to be tier-B only, on the
    narrower theory that the irreproducibility came from turning vision on. It
    does not -- the movie is free by construction (PORT_SPEC.md), so it is never
    part of a byte-exact number. Amends the W1f tier-B deviation row; see
    PARITY.md -> Deviations -> *The movie is not a frozen artifact*.
  Harness artifacts (run/manifest.sha256, .DS_Store) are never part of the
  compared file set, so `cp -R oracle/<scenario> <candidate>` is a clean copy
  that must pass.

PORT-NOTE(parity-runner/content-compare): a third mode beside byte-compare and
  `ignore`, for gzip containers only -- and **opt-in: nothing ships using it**.
  The registry's global `content_compare` rule list is **empty** since 2026-09-29
  (the amendment was reverted, task `t_9c9fa3de`), so by default every `.gz` is
  compared by container bytes and no `content-compared` line is printed;
  `run/**/*.gz` is only what a scenario opts into with its own
  `content_compare` globs, or what `--content-compare <glob>` supplies for one
  check. `content_compare` patterns (declared in the
  registry: top level = every scenario, or per scenario) select files that are
  compared by their **decompressed payload**, not by container bytes: the
  candidate must gunzip to the golden's payload byte-for-byte, while the deflate
  stream inside is free. Measured 2026-09-28 (t_091ec5b8): the recorded goldens
  are **upstream zlib** level-6 raw deflate (reproduced byte-for-byte by apple
  libz 1.2.12, vanilla zlib 1.2.12 and vanilla zlib 1.3.1 -- all 1317 recorded
  containers: 150 microtest_voff + 1167 minitest_voff), while the runtimes that
  must write those files here normally write through a zlib that is **not**
  upstream. Which zlib that is, is a property of the **binary's own link** (a
  build-time choice), not of node or Chrome as such -- the counts are per-engine:
  node 22.22.2 and nvm v24.21.0 link Google's patched "motley" fork
  (`1.3.1-e00f703`, `1.3.2.1-motley-8002e91`: 25/150 and 25/1167 containers) and
  cannot speak upstream's stream, Chrome 153
  `CompressionStream('deflate-raw'|'gzip')` neither (26/190), but a node linked
  against upstream zlib 1.2.12 (`/opt/homebrew/opt/node@24` v24.16.0) reproduces
  **150/150** and **1167/1167** with the same `node:zlib` call (measured
  2026-09-29, t_16ac7810/t_ceaf2128). So the container is a property of the
  compression library, not of the ported model -- the *content* is the
  contract. A content-compared file is counted and reported (`content-compared
  N`, plus container-only differences) and never silently dropped: an unreadable
  container, a missing file or a payload difference is still a failure.
  `--no-content-compare` restores strict byte-compare for a specific check -- and it
  is absolute: it wins over an explicit `--content-compare <glob>` passed on the same
  command line (t_a59843f4), because "disable every content_compare rule" has to
  include the rules named on that line. The check then runs with **no**
  content_compare rule at all, so every manifested file is byte-compared. The globs
  are still validated (`--content-compare` must name a `run/`-relative glob), so a
  typo stays a usage error instead of being swallowed by the flag.
  The durable fix (byte-exact containers from a version-pinned JS deflate) is no
  longer a separate lane: it **landed** (t_431ed2f0, 2026-09-28) as
  `src/model/compress/zlibDeflate.ts`, which is why the amendment was reverted;
  see PARITY.md -> Deviations and PORT_SPEC.md -> Frozen surface.
"""
from __future__ import annotations

import contextlib
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zlib
from pathlib import Path
from typing import Optional

WEB_ROOT = Path(__file__).resolve().parent.parent
BASE_REGISTRY = WEB_ROOT / "oracle" / "scenarios" / "scenarios.json"
OVERLAY_DIR = WEB_ROOT / "tools" / "scenarios.d"
ORACLE_DIR = WEB_ROOT / "oracle"
DISPLACED_DIR = ORACLE_DIR / "_native_previous"
DEFAULT_NATIVE_DIR = WEB_ROOT.parent / "polyworld"

NATIVE_BINARY = "Polyworld"
NATIVE_LOCK_NAME = ".parity-native.lock"
NATIVE_RUN_DIRNAME = "run"
RUN_PREFIX = "run/"
MANIFEST_NAME = "manifest.sha256"
HARNESS_ARTIFACTS = {MANIFEST_NAME, ".DS_Store"}
#: Artifacts PORT_SPEC.md declares *free* rather than frozen. The movie is written
#: incrementally on a sampling path that is not pinned to step boundaries, so even
#: two native runs of the same scenario on one machine can differ in it (measured
#: 2026-09-28, t_588c28e1). It is therefore never part of a byte-exact number, at
#: any tier -- see PORT-NOTE(parity-runner/movie-is-free) and PARITY.md.
FREE_ARTIFACTS = ["run/movie.pmv"]
#: Tier-keyed compare defaults. Every tier ignores the free artifacts; the dict
#: stays keyed so a future tier can carry its own defaults and so registrations
#: written by tools/add_scenario.py record what their tier defaults to.
TIER_DEFAULT_IGNORE = {"A": list(FREE_ARTIFACTS), "B": list(FREE_ARTIFACTS)}
DEFAULT_TIMEOUT_SEC = 1800
DEFAULT_LOCK_TIMEOUT_SEC = 3600

try:  # POSIX only; see native_lock() for the degraded path
    import fcntl
except ImportError:  # pragma: no cover - macOS/Linux always have fcntl
    fcntl = None


class ParityError(Exception):
    """A usage/environment problem, distinct from a parity failure.

    Exit code 2, so a lane can tell "my run tree disagrees with the golden"
    (1) from "you pointed the harness at nothing" (2).
    """


# --------------------------------------------------------------------------- #
# locations
# --------------------------------------------------------------------------- #
def resolve_web(explicit=None) -> Path:
    env = os.environ.get("POLYWORLD_WEB")
    if env:
        return Path(env).expanduser().resolve()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return WEB_ROOT


def _config_file(web=None) -> Path:
    return resolve_web(web) / "tools" / "parity.config.json"


def _config_value(key, web=None):
    cfg = _config_file(web)
    if not cfg.is_file():
        return None
    try:
        doc = json.loads(cfg.read_text())
    except ValueError as exc:
        raise ParityError("%s is not valid JSON: %s" % (cfg, exc))
    value = doc.get(key)
    return str(value) if value else None


def resolve_oracle_root(web=None) -> Path:
    """Where the goldens live: $POLYWORLD_ORACLE_ROOT > parity.config.json
    "oracle_dir" > <web>/oracle.

    PORT-NOTE(parity-runner/oracle-root): `oracle/*/run/**` is gitignored (it is
    ~35 MB of generated goldens), so a lane working in its own git worktree does
    not get them and every check would say "no golden". The canonical goldens are
    the ones recorded on this machine; pointing lanes at them with one env var is
    cheaper and more honest than re-recording per worktree.
    """
    env = os.environ.get("POLYWORLD_ORACLE_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    configured = _config_value("oracle_dir", web)
    if configured:
        return Path(configured).expanduser().resolve()
    return resolve_web(web) / "oracle"


def native_candidates(explicit=None, web=None):
    out = []
    env = os.environ.get("POLYWORLD_NATIVE")
    if env:
        out.append(Path(env).expanduser())
    if explicit:
        out.append(Path(explicit).expanduser())
    configured = _config_value("native_dir", web)
    if configured:
        out.append(Path(configured).expanduser())
    out.append(resolve_web(web).parent / "polyworld")
    return out


def resolve_native(explicit=None, web=None, required=True) -> Optional[Path]:
    """Native Polyworld tree: $POLYWORLD_NATIVE > --native > parity.config.json
    > <web>/../polyworld. Must contain the built `Polyworld` binary."""
    looked = []
    for cand in native_candidates(explicit, web):
        looked.append(str(cand))
        if (cand / NATIVE_BINARY).is_file():
            return cand.resolve()
    if required:
        raise ParityError(
            "no native Polyworld tree found (looked for a `%s` binary in: %s). "
            "Set $POLYWORLD_NATIVE or add {\"native_dir\": ...} to tools/parity.config.json."
            % (NATIVE_BINARY, ", ".join(looked))
        )
    return None


def golden_dir(name, web=None) -> Path:
    return resolve_oracle_root(web) / name


def displaced_dir(web=None) -> Path:
    return resolve_oracle_root(web) / "_native_previous"


def staging_dir(name, web=None) -> Path:
    """The stage a recording is built in: `oracle/_t_record_<scenario>_<pid>`.

    `oracle/_t_*` is the prefix .gitignore reserves for staged candidates, so a recording in
    flight never looks like a golden to a concurrent lane (and a crashed one leaves a
    gitignored directory, not a half-built golden).
    """
    return resolve_oracle_root(web) / ("_t_record_%s_%d" % (name, os.getpid()))


# --------------------------------------------------------------------------- #
# the frozen-golden write guard (the python half of src/oracle/guard.ts, t_37bf7212)
# --------------------------------------------------------------------------- #
#: The staging prefix `oracle/_t_*` that .gitignore reserves for candidate trees.
STAGING_PREFIX = "_t_"

# PORT-NOTE(parity-runner/golden-is-frozen): `oracle/<scenario>/run/**` is the frozen contract;
# only the recorder (`--record`, i.e. tools/record_oracle.py) may write a byte of it, and it
# installs by stage -> verify -> move, never in place. Everything else -- a candidate for
# `--candidate`, a `--candidate-out` staging root, a lane's tree -- lives under `oracle/_t_*`
# or `$TMPDIR`.
#
# Why the guard is symlink-aware (measured, task t_37bf7212, 2026-09-29): a lane's acceptance
# pass ran vitest in a git worktree whose `oracle/<scenario>/run` was a *symlink* into the
# canonical golden (that is how a worktree gets the gitignored goldens).
# `tests/parity-runner.test.ts` copies the golden and perturbs the copy; `cpSync` does not
# dereference, so the copy was a tree of links and the perturbations landed in the golden:
# 97/225 files verified afterwards, three manifested files gone (`events/carry.log`,
# `stats/stat.1`, `brain/anatomy/brainAnatomy_10_birth.txt.gz`), and 15 false reds in six
# unrelated test files. A path is therefore judged by the real path it resolves to, not by its
# spelling.
#
# Why the marker decides and not only the oracle root (t_f049065c, measured at d150ac6 and
# d0231eb): the symlinked `run/` *resolves outside* the root a bare worktree hands the guard
# (`POLYWORLD_ORACLE_ROOT` unset -> `<worktree>/oracle`), so an oracle-relative test cannot see
# it -- and that is exactly where the rule "the frozen golden is never a candidate" has to hold:
# `run_parity.sh <s> --candidate <worktree>/oracle/<s>/run` reported `PASS (225/225 files)` for
# the golden against itself (the scenario-dir spelling was refused, the run-dir spelling was
# not). `run/manifest.sha256` is the harness's own listing of a golden, so a resolved `run/` dir
# that holds one is a golden wherever it lives. Same predicate as `goldenWriteTarget`/
# `resolvedGoldenRunDir` in src/oracle/guard.ts (which closed this shape in t_37bf7212 round 2),
# so the two halves of the net now agree on it. Deliberately staged trees -- any `oracle/_t_*`
# path or anything under `$TMPDIR` -- stay candidates a lane may perturb freely.


def _real_existing(path: Path) -> Path:
    """`os.path.realpath` of the longest existing prefix, plus the rest as written.

    `realpath` alone resolves nothing that does not exist yet, and the interesting
    target is a *file inside* a directory that does exist -- typically a `run` symlinked
    into the golden.
    """
    target = Path(os.path.expanduser(str(path)))
    if not target.is_absolute():
        target = Path.cwd() / target
    target = Path(os.path.normpath(str(target)))
    tail = []
    current = target
    while True:
        if current.exists():
            return Path(os.path.realpath(str(current))).joinpath(*reversed(tail))
        parent = current.parent
        if parent == current:
            return current.joinpath(*reversed(tail))
        tail.append(current.name)
        current = parent


def _inside(child: Path, parent: Path) -> bool:
    """Is `child` `parent` itself, or below it? (`isInside` of src/oracle/guard.ts.)"""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _tmpdir_real() -> Path:
    return _real_existing(Path(os.environ.get("TMPDIR") or "/tmp"))


def _holds_manifest(path: Path) -> bool:
    """Does `path` hold the harness's own listing of a golden?"""
    try:
        return (path / MANIFEST_NAME).is_file()
    except OSError:
        return False


def _resolved_golden_run_dir(resolved: Path) -> Optional[Path]:
    """The golden `run/` dir a **resolved** path lives in, found by the manifest marker.

    The mirror of `resolvedGoldenRunDir` in src/oracle/guard.ts, bounded the same way (only paths
    a segment at a time, and only an ancestor literally named `run` is ever stat'd).
    """
    if resolved.name == NATIVE_RUN_DIRNAME and _holds_manifest(resolved):
        return resolved
    current = resolved.parent
    for _ in range(8):
        if current.name == NATIVE_RUN_DIRNAME and _holds_manifest(current):
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def oracle_relative(path, web=None) -> list:
    """`path`'s segments below the oracle root ([] when it is outside, or the root itself)."""
    real = _real_existing(Path(path))
    oracle = _real_existing(resolve_oracle_root(web))
    try:
        return list(real.relative_to(oracle).parts)
    except ValueError:
        return []


def is_staged_path(path, web=None) -> bool:
    """Is `path` under an `oracle/_t_*` staging dir, or under `$TMPDIR`?"""
    segments = oracle_relative(path, web)
    if segments:
        return segments[0].startswith(STAGING_PREFIX)
    try:
        _real_existing(Path(path)).relative_to(_real_existing(Path(os.environ.get("TMPDIR", "/tmp"))))
        return True
    except ValueError:
        return False


def golden_write_target(path, web=None):
    """`(scenario, rel, scenario_dir, run_dir)` when `path` is a golden write target, else None."""
    segments = oracle_relative(path, web)
    if segments:
        scenario = segments[0]
        if scenario.startswith(STAGING_PREFIX):
            return None
        if len(segments) < 2 or segments[1] != NATIVE_RUN_DIRNAME:
            return None
        scenario_dir = resolve_oracle_root(web) / scenario
        return (scenario, "/".join(segments[2:]), scenario_dir, scenario_dir / NATIVE_RUN_DIRNAME)

    # Not inside the configured oracle root -- but it may still be a golden, and that is the whole
    # point of the rule (t_f049065c): a lane's worktree reaches the canonical goldens by symlinking
    # the per-scenario `run` dirs, which resolves *outside* the root that worktree hands the guard
    # (`POLYWORLD_ORACLE_ROOT` unset), so the oracle-relative test above cannot see it. The harness
    # then compared the golden against itself and reported `PASS (225/225 files)`. Same predicate as
    # `goldenWriteTarget` in src/oracle/guard.ts: a `run/` dir holding the manifest *is* a golden
    # wherever it lives. Deliberately staged trees -- any `_t_*` segment, or anything under
    # `$TMPDIR` -- are candidates a lane may perturb freely.
    resolved = _real_existing(Path(path))
    if _inside(resolved, _tmpdir_real()):
        return None
    if any(segment.startswith(STAGING_PREFIX) for segment in resolved.parts):
        return None
    run_dir = _resolved_golden_run_dir(resolved)
    if run_dir is None:
        return None
    scenario_dir = run_dir.parent
    try:
        rel = "/".join(resolved.relative_to(run_dir).parts)
    except ValueError:  # pragma: no cover -- _resolved_golden_run_dir only returns run_dir's of `resolved`
        return None
    return (scenario_dir.name, rel, scenario_dir, run_dir)


def _golden_refusal(path, what, web=None):
    """The refusal message for `path`, or None when the path is usable."""
    target = Path(path)
    resolved = _real_existing(target)
    oracle = _real_existing(resolve_oracle_root(web))
    segments = oracle_relative(target, web)
    hit = golden_write_target(target, web)
    in_oracle_namespace = bool(segments) and not segments[0].startswith(STAGING_PREFIX)
    # A root whose `run/` child resolves into a golden is the worktree shape this guard exists for
    # (`<worktree>/oracle/<scenario>/run` -> the canonical golden): the root itself is an ordinary
    # directory, but everything written "under it" lands in the frozen tree.
    run_child = resolved / NATIVE_RUN_DIRNAME
    child_segments = oracle_relative(run_child, web)
    child_is_golden = golden_write_target(run_child, web) is not None or (
        bool(child_segments) and not child_segments[0].startswith(STAGING_PREFIX)
    )
    if hit is not None or in_oracle_namespace or resolved == oracle or child_is_golden:
        return ("%s: refusing %s -- it resolves into the frozen goldens (oracle/<scenario>/run/** "
                "is the contract; only `--record` may write it). A candidate or staging root must "
                "not be the oracle, a scenario dir, a run tree, or a directory whose run/ is a "
                "symlink into one; use oracle/_t_* or $TMPDIR (src/oracle/guard.ts)."
                % (what, path))
    return None


def refuse_golden_candidate(path, what, web=None):
    """Raise ParityError when `path` may not be used as a candidate / staging root."""
    message = _golden_refusal(path, what, web)
    if message is not None:
        raise ParityError(message)
    return Path(path)


def refuse_golden_write(path, what, web=None):
    """Raise ParityError when `path` is itself a write target inside a golden."""
    hit = golden_write_target(path, web)
    if hit is not None:
        scenario, rel, _, run_dir = hit
        where = str(run_dir / rel) if rel else str(run_dir)
        raise ParityError(
            "%s: refusing to write the frozen golden %s (oracle/%s/run/** is the contract and "
            "only `--record` may write it). Stage under oracle/_t_* or $TMPDIR instead "
            "(src/oracle/guard.ts)." % (what, where, scenario)
        )
    return Path(path)


def verify_manifest_tree(run_dir) -> int:
    """Re-hash every file a staged tree's manifest lists; raise ParityError on any mismatch.

    The install step of a recording runs this *before* the tree is moved into place, so a
    golden is never published half-copied (t_37bf7212).
    """
    run_dir = Path(run_dir)
    manifest = run_dir / MANIFEST_NAME
    if not manifest.is_file():
        raise ParityError("staged tree %s has no %s" % (run_dir, MANIFEST_NAME))
    entries = []
    for line in manifest.read_text().splitlines():
        if not line.strip():
            continue
        digest, _, rel = line.partition("  ")
        entries.append((digest.strip(), rel.strip()))
    if not entries:
        raise ParityError("staged tree %s has an empty %s" % (run_dir, MANIFEST_NAME))
    for digest, rel in entries:
        path = candidate_path(run_dir, rel)
        if not path.is_file():
            raise ParityError("staged tree %s is missing %s" % (run_dir, rel))
        actual = sha256_file(path)
        if actual != digest:
            raise ParityError("staged tree %s: %s does not hash to its manifest (%s != %s)"
                              % (run_dir, rel, actual[:16], digest[:16]))
    return len(entries)


def install_staged_golden(stage_dir, golden, log=None) -> None:
    """Move a verified staged tree into `oracle/<scenario>/` atomically (stage -> verify -> move).

    `os.replace` on the staged `run/` is the publish: a concurrent reader (another lane's
    parity check) sees either nothing or the complete tree, never a half-copied one.
    """
    stage_dir = Path(stage_dir)
    golden = Path(golden)
    verify_manifest_tree(stage_dir / NATIVE_RUN_DIRNAME)
    golden.mkdir(parents=True, exist_ok=True)
    dest_run = golden / NATIVE_RUN_DIRNAME
    if dest_run.exists():
        raise ParityError("%s already has a %s -- displace the golden first (record_oracle.py does)"
                          % (golden, NATIVE_RUN_DIRNAME))
    os.replace(str(stage_dir / NATIVE_RUN_DIRNAME), str(dest_run))
    for name in ("stdout.txt", "stderr.txt", "meta.json"):
        staged = stage_dir / name
        if staged.exists():
            os.replace(str(staged), str(golden / name))
    if log is not None:
        log.write("parity: installed %s (stage -> verify -> move)\n" % dest_run)
    shutil.rmtree(str(stage_dir), ignore_errors=True)


# --------------------------------------------------------------------------- #
# scenario registry
# --------------------------------------------------------------------------- #
def load_registry(web=None) -> dict:
    """Merge the read-only base registry with the lane overlays.

    Overlays load after the base, so a lane file may shadow a base scenario
    name (add_scenario.py refuses to do that without --force).
    """
    web = resolve_web(web)
    reg = {"exclude_from_manifest": [], "content_compare": [], "scenarios": {}}
    sources = [web / "oracle" / "scenarios" / "scenarios.json"]
    sources += sorted((web / "tools" / "scenarios.d").glob("*.json"))
    for path in sources:
        if not path.is_file():
            continue
        try:
            doc = json.loads(path.read_text())
        except ValueError as exc:
            raise ParityError("scenario registry %s is not valid JSON: %s" % (path, exc))
        for pat in doc.get("exclude_from_manifest", []) or []:
            if pat not in reg["exclude_from_manifest"]:
                reg["exclude_from_manifest"].append(pat)
        for pat in doc.get("content_compare", []) or []:
            check_content_compare_pattern(pat, path)
            if pat not in reg["content_compare"]:
                reg["content_compare"].append(pat)
        for sc in doc.get("scenarios", []) or []:
            name = sc.get("name")
            if not name:
                raise ParityError("%s declares a scenario without a name" % path)
            merged = dict(sc)
            merged["_source"] = str(path)
            reg["scenarios"][name] = merged
    return reg


def get_scenario(name, web=None) -> dict:
    reg = load_registry(web)
    sc = reg["scenarios"].get(name)
    if sc is None:
        known = ", ".join(sorted(reg["scenarios"])) or "(none)"
        raise ParityError(
            "unknown scenario %r. Registered: %s. Register a new one with "
            "`./oracle/run_parity.sh add %s --worldfile <path-in-native-tree> [--args ...]`."
            % (name, known, name)
        )
    return sc


def record_excludes(scenario, reg) -> list:
    """Patterns skipped when snapshotting a native run/ into a golden."""
    out = list(reg["exclude_from_manifest"])
    for pat in scenario.get("record_exclude", []) or []:
        if pat not in out:
            out.append(pat)
    return out


def tier_default_ignore(tier) -> list:
    """The compare-time defaults a tier carries (any tier ignores the free artifacts)."""
    return list(TIER_DEFAULT_IGNORE.get(str(tier or "").upper(), []))


def compare_ignores(scenario, reg) -> list:
    """Patterns that may differ/be absent in a candidate without failing it."""
    out = []
    for pat in list(reg["exclude_from_manifest"]):
        if pat not in out:
            out.append(pat)
    if not scenario.get("no_default_ignore"):
        for pat in tier_default_ignore(scenario.get("tier")):
            if pat not in out:
                out.append(pat)
    for pat in scenario.get("ignore", []) or []:
        if pat not in out:
            out.append(pat)
    return out


# --------------------------------------------------------------------------- #
# content-compare rules (see PORT-NOTE(parity-runner/content-compare))
# --------------------------------------------------------------------------- #
#: Glob syntax for content_compare patterns: `**` crosses `/`, `*`/`?` do not.
#: `run/**/*.gz` therefore matches `run/genome_1.txt.gz` and
#: `run/brain/anatomy/brainAnatomy_10_birth.txt.gz` alike.
_GLOB_CACHE = {}
_GZIP_MAGIC = b"\x1f\x8b"


def check_content_compare_pattern(pattern, source=None):
    """A compare-time pattern must be able to match a manifest rel path."""
    if not isinstance(pattern, str) or not pattern.startswith(RUN_PREFIX):
        raise ParityError(
            "content_compare pattern %r%s must be a run/-relative glob (manifest paths look "
            "like `run/genome/agents/genome_1.txt.gz`)" % (pattern, (" in %s" % source) if source else "")
        )
    return pattern


def _glob_regex(pattern):
    compiled = _GLOB_CACHE.get(pattern)
    if compiled is not None:
        return compiled
    out = ["^"]
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern.startswith("**", i):
                out.append(".*")
                i += 2
                if pattern.startswith("/", i):
                    out.append("/?")
                    i += 1
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        elif char in ".+()|^$[]{}\\":
            out.append("\\" + char)
        else:
            out.append(char)
        i += 1
    out.append("$")
    compiled = re.compile("".join(out))
    _GLOB_CACHE[pattern] = compiled
    return compiled


def content_compare_patterns(scenario, reg) -> list:
    """Compare-time patterns for which the decompressed content is the contract.

    Global rules (`content_compare` at the top level of any registry document,
    e.g. tools/scenarios.d/content-compare.json) apply to every scenario;
    `"content_compare": [...]` on a scenario adds to them, `"no_content_compare":
    true` opts that scenario out of the global rule.
    """
    out = []
    if not (scenario or {}).get("no_content_compare"):
        for pat in (reg or {}).get("content_compare", []) or []:
            if pat not in out:
                out.append(pat)
    for pat in (scenario or {}).get("content_compare", []) or []:
        if pat not in out:
            out.append(pat)
    return out


def content_compare_rule(rel, patterns):
    """First pattern matching `rel`, or None. `rel` is a manifest path (`run/...`)."""
    for pat in patterns or []:
        if _glob_regex(pat).match(rel):
            return pat
    return None


def read_gzip_payload(path):
    """(payload_bytes, header_bytes) for a gzip container, or ParityError.

    Multi-member streams (what `gzopen( path, "a" )` produces) are concatenated,
    which is exactly what `gzip -d` and `AbstractFile`'s reader see. Anything
    that is not a complete gzip stream is a hard error -- a container the
    harness cannot read must never look like a pass.
    """
    path = Path(path)
    try:
        blob = path.read_bytes()
    except OSError as exc:
        raise ParityError("cannot read %s (%s)" % (path, exc))
    if not blob.startswith(_GZIP_MAGIC):
        raise ParityError("not a gzip container (magic %s): %s" % (blob[:2].hex() or "(empty)", path))
    try:
        payload = gzip.decompress(blob)
    except (OSError, EOFError, zlib.error, ValueError) as exc:
        raise ParityError("unreadable gzip stream: %s (%s)" % (path, exc))
    return payload, blob[:10]


def payload_digest(payload) -> str:
    return hashlib.sha256(payload).hexdigest()


def validate_native_worldfile(worldfile, native, web=None):
    """A scenario's worldfile must live inside the native tree: that is the tree
    the oracle records from, and relative paths are what the native binary is
    invoked with (its cwd is the native root)."""
    native = resolve_native(native, web)
    if native is None:  # resolve_native(required=True) never returns None
        raise ParityError("no native tree")
    rel = Path(worldfile)
    absolute = (native / rel) if not rel.is_absolute() else rel
    if not absolute.is_file():
        raise ParityError("worldfile not found in the native tree: %s" % absolute)
    try:
        inside = absolute.resolve().relative_to(native.resolve())
    except ValueError:
        raise ParityError(
            "worldfile must live inside the native tree (%s); got %s" % (native, absolute)
        )
    return str(inside)


# --------------------------------------------------------------------------- #
# run trees and manifests
# --------------------------------------------------------------------------- #
def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_ignored(rel, patterns) -> bool:
    return any(rel.startswith(pat) for pat in patterns)


def iter_run_files(run_dir, excludes=()):
    """(rel, path) for every comparable file under a native/candidate run tree.

    Deterministic order (sorted) -- the manifest is a byte-comparable artifact.
    """
    run_dir = Path(run_dir)
    out = []
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name in HARNESS_ARTIFACTS:
            continue
        rel = RUN_PREFIX + str(path.relative_to(run_dir))
        if is_ignored(rel, excludes):
            continue
        out.append((rel, path))
    return out


def write_manifest(dest_run_dir, run_dir, excludes=()):
    """Copy `run_dir` into `dest_run_dir` and write its sha256 manifest.

    Returns (file_count, [(rel, digest)]). The manifest itself is never listed.
    """
    dest_run_dir = Path(dest_run_dir)
    dest_run_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for rel, path in iter_run_files(run_dir, excludes):
        target = dest_run_dir / rel[len(RUN_PREFIX):]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(path), str(target))
        entries.append((rel, sha256_file(path)))
    (dest_run_dir / MANIFEST_NAME).write_text(
        "\n".join("%s  %s" % (digest, rel) for rel, digest in entries) + ("\n" if entries else "")
    )
    return len(entries), entries


def manifest_candidates(golden):
    golden = Path(golden)
    return [golden / RUN_PREFIX.rstrip("/") / MANIFEST_NAME, golden / MANIFEST_NAME]


def read_manifest(golden):
    """(rel -> digest, manifest_path) for a golden scenario dir or run tree."""
    for path in manifest_candidates(golden):
        if path.is_file():
            expected = {}
            for line in path.read_text().splitlines():
                if line.strip():
                    digest, _, rel = line.partition("  ")
                    expected[rel.strip()] = digest.strip()
            return expected, path
    raise ParityError(
        "no %s under %s -- is this a recorded golden? (record one with "
        "`./oracle/run_parity.sh <scenario> --record`)" % (MANIFEST_NAME, golden)
    )


def locate_run_tree(root):
    """Return (run_dir, style) so both `--candidate <dir-with-run/>` and
    `--candidate <the-run-tree>` work. Manifest rel paths are always `run/...`,
    so the caller strips that prefix to build candidate paths."""
    root = Path(root)
    if not root.exists():
        raise ParityError("candidate path does not exist: %s" % root)
    if (root / NATIVE_RUN_DIRNAME).is_dir():
        return root / NATIVE_RUN_DIRNAME, "parent"
    run_markers = ("endReason.txt", "population.txt", "lifespans.txt", "normalized.wf", "BirthsDeaths.log", "endStep.txt")
    if any((root / marker).exists() for marker in run_markers):
        return root, "run-tree"
    raise ParityError(
        "%s is neither a directory containing run/ nor a run tree itself "
        "(looked for %s)" % (root, ", ".join(run_markers))
    )


def candidate_path(run_dir, rel):
    if rel.startswith(RUN_PREFIX):
        return Path(run_dir) / rel[len(RUN_PREFIX):]
    return Path(run_dir) / rel


# --------------------------------------------------------------------------- #
# text diff assistance
# --------------------------------------------------------------------------- #
TEXT_DIFF_MAX_BYTES = 8 << 20


def read_text_lines(path):
    try:
        if Path(path).stat().st_size > TEXT_DIFF_MAX_BYTES:
            return None
    except OSError:
        return None
    try:
        blob = Path(path).read_bytes()
    except OSError:
        return None
    if b"\x00" in blob[:4096]:
        return None
    return blob.decode("latin-1").splitlines()


def parse_column_names(lines):
    """datalib single-schema logs carry a `#@L <name padded> <name padded>` row."""
    if not lines:
        return None
    for line in lines[:12]:
        if line.startswith("#@L "):
            names = [n.strip() for n in line[len("#@L "):].split("  ") if n.strip()]
            return names or None
    return None


def first_line_diff(golden_path, candidate_path, max_line_len=160):
    """(line_no, golden_line, candidate_line, column_index) of the first difference.

    PORT-NOTE(parity-runner/step-localized-diff): PORT_PLAN.md point 5 leans on
    the per-step logs to name the broken subsystem. The logs are TSV whose first
    column is the step, so line number -> step is free; the `#@L` header row gives
    column names when the row shape matches.
    """
    a = read_text_lines(golden_path)
    b = read_text_lines(candidate_path)
    if a is None or b is None:
        return None
    return line_diff_from_lines(a, b, max_line_len=max_line_len)


def first_line_diff_bytes(golden_bytes, candidate_bytes, max_line_len=160):
    """Same, for two in-memory blobs (a content-compared `.gz`'s payloads).

    PORT-NOTE(parity-runner/content-compare-diff): the payload of a gzipped log is
    the same text the byte path would have diffed, so the step/column
    localization works unchanged -- the harness decompresses both sides and diffs
    the payload lines instead of staying silent about a `DIFFERS` row.
    """
    a = text_lines_from_bytes(golden_bytes)
    b = text_lines_from_bytes(candidate_bytes)
    if a is None or b is None:
        return None
    return line_diff_from_lines(a, b, max_line_len=max_line_len)


def text_lines_from_bytes(blob):
    if len(blob) > TEXT_DIFF_MAX_BYTES or b"\x00" in blob[:4096]:
        return None
    return blob.decode("latin-1").splitlines()


def line_diff_from_lines(a, b, max_line_len=160):
    names = parse_column_names(a)
    limit = min(len(a), len(b))
    for i in range(limit):
        if a[i] != b[i]:
            column_index = common_prefix_columns(a[i], b[i])
            return {
                "line": i + 1,
                "golden_line": a[i][:max_line_len],
                "candidate_line": b[i][:max_line_len],
                "column_index": column_index,
                "column": names[column_index] if names and column_index is not None and 0 <= column_index < len(names) else None,
                "step": first_field(a[i]),
            }
    if len(a) != len(b):
        longer, shorter = (a, b) if len(a) > len(b) else (b, a)
        where = len(shorter)
        return {
            "line": where + 1,
            "golden_line": (a[where] if len(a) > where else "<EOF>")[:max_line_len],
            "candidate_line": (b[where] if len(b) > where else "<EOF>")[:max_line_len],
            "column_index": None,
            "column": None,
            "step": None,
            "note": "file lengths differ (%d vs %d lines)" % (len(a), len(b)),
        }
    return None


def common_prefix_columns(golden_line, candidate_line):
    n = 0
    limit = min(len(golden_line), len(candidate_line))
    while n < limit and golden_line[n] == candidate_line[n]:
        n += 1
    if "\t" in golden_line:
        return golden_line.count("\t", 0, n)
    return max(len(golden_line[:n].split()) - 1, 0)


def first_field(line):
    head = line.split("\t", 1)[0].strip()
    if head.isdigit():
        return int(head)
    return None


# --------------------------------------------------------------------------- #
# native run isolation
# --------------------------------------------------------------------------- #
@contextlib.contextmanager
def native_lock(native_dir, timeout=DEFAULT_LOCK_TIMEOUT_SEC, log=None, purpose=""):
    """Serialise native runs: `Polyworld` always writes to <native>/run, so two
    lanes recording at once would clobber each other's run tree."""
    log = log if log is not None else sys.stderr
    if fcntl is None:  # pragma: no cover
        log.write("parity: warning: fcntl unavailable, native runs are NOT locked\n")
        yield {"waited_sec": 0.0, "locked": False}
        return
    lock_path = Path(native_dir) / NATIVE_LOCK_NAME
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
    started = time.time()
    waited = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if not waited:
                    log.write(
                        "parity: waiting for the native-run lock %s%s\n"
                        % (lock_path, (" -- " + purpose) if purpose else "")
                    )
                    log.flush()
                    waited = True
                if timeout is not None and (time.time() - started) > timeout:
                    raise ParityError(
                        "timed out after %ss waiting for %s (holder: %s)"
                        % (timeout, lock_path, _lock_owner(lock_path))
                    )
                time.sleep(0.5)
        os.ftruncate(fd, 0)
        os.write(fd, ("%d %s %s\n" % (os.getpid(), time.strftime("%Y-%m-%dT%H:%M:%S"), purpose)).encode())
        yield {"waited_sec": round(time.time() - started, 1), "locked": True, "lock_path": str(lock_path)}
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _lock_owner(lock_path):
    try:
        return Path(lock_path).read_text().strip() or "unknown"
    except OSError:
        return "unknown"


def unique_displaced_path(path, dest_dir=None):
    path = Path(path)
    base = Path(dest_dir) if dest_dir else path.parent
    ts = int(time.time())
    dest = base / ("%s.previous.%d" % (path.name, ts))
    if dest.exists():
        dest = base / ("%s.previous.%d.%d" % (path.name, ts, os.getpid()))
    if dest.exists():
        raise ParityError("refusing to displace %s: %s already exists" % (path, dest))
    return dest


def displace(path, dest_dir=None, log=None, reason=""):
    """Move an artifact aside. Never deletes, never overwrites.

    Used for the two things the harness must not destroy: the native tree's
    `run/` directory (-> run.previous.<epoch>, the rule in PORT_SPEC's harness
    brief) and an existing golden (-> oracle/_native_previous/<name>.previous.<epoch>).
    """
    log = log if log is not None else sys.stderr
    path = Path(path)
    if not path.exists():
        return None
    dest = unique_displaced_path(path, dest_dir)
    try:
        os.rename(str(path), str(dest))
    except OSError as exc:
        raise ParityError(
            "cannot move %s aside to %s (%s); refusing to delete it -- move it by hand and retry"
            % (path, dest, exc)
        )
    log.write("parity: moved aside %s -> %s%s\n" % (path, dest, (" (%s)" % reason) if reason else ""))
    log.flush()
    return dest


def native_run_dir(native_dir):
    return Path(native_dir) / NATIVE_RUN_DIRNAME


# --------------------------------------------------------------------------- #
# registry CLI (small; the harness shells out to this for `list`)
# --------------------------------------------------------------------------- #
def describe(scenario, reg):
    return {
        "name": scenario.get("name"),
        "tier": scenario.get("tier"),
        "worldfile": scenario.get("worldfile"),
        "args": scenario.get("args", []),
        "ignore": compare_ignores(scenario, reg),
        "content_compare": content_compare_patterns(scenario, reg),
        "source": scenario.get("_source"),
        "notes": scenario.get("notes"),
    }


def registry_cli(argv):
    import argparse

    parser = argparse.ArgumentParser(prog="parity_common.py", description="parity registry introspection")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list", help="list registered scenarios")
    p_list.add_argument("--json", action="store_true")
    p_show = sub.add_parser("show", help="show one scenario as the harness resolves it")
    p_show.add_argument("name")
    p_show.add_argument("--json", action="store_true")
    p_paths = sub.add_parser("paths", help="print resolved web/native roots")
    p_paths.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "paths":
            web = resolve_web()
            native = resolve_native(web=web, required=False)
            oracle = resolve_oracle_root(web)
            info = {"web": str(web), "native": str(native) if native else None,
                    "oracle": str(oracle), "overlay_dir": str(web / "tools" / "scenarios.d"),
                    "config": str(_config_file(web)) if _config_file(web).is_file() else "(none)"}
            if args.json:
                print(json.dumps(info, indent=2))
            else:
                for key, value in info.items():
                    print("%-11s %s" % (key, value))
            return 0

        reg = load_registry()
        if args.cmd == "show":
            sc = reg["scenarios"].get(args.name)
            if sc is None:
                raise ParityError("unknown scenario %r" % args.name)
            info = describe(sc, reg)
            info["record_excludes"] = record_excludes(sc, reg)
            info["golden"] = str(golden_dir(args.name))
            info["recorded"] = (golden_dir(args.name) / "run" / MANIFEST_NAME).is_file()
            if args.json:
                print(json.dumps(info, indent=2))
            else:
                for key, value in info.items():
                    print("%-16s %s" % (key, value))
            return 0

        rows = [describe(sc, reg) for sc in reg["scenarios"].values()]
        if args.json:
            print(json.dumps({"scenarios": rows, "exclude_from_manifest": reg["exclude_from_manifest"],
                              "content_compare": reg["content_compare"]}, indent=2))
            return 0
        for row in rows:
            golden = golden_dir(row["name"])
            recorded = "golden" if (golden / "run" / MANIFEST_NAME).is_file() else "no-golden"
            print("%-16s tier=%-2s %-10s args=%-22s ignore=%-18s content_compare=%s"
                  % (row["name"], row["tier"] or "?", recorded,
                     " ".join(row["args"]) or "-", ",".join(row["ignore"]) or "-",
                     ",".join(row["content_compare"]) or "-"))
        return 0
    except ParityError as exc:
        print("parity: error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(registry_cli(sys.argv[1:]))
