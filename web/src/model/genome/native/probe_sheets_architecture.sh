#!/bin/sh
# Lane L5/L6 — the `BrainArchitecture Sheets` probe: what the shipped native build
# actually does with the Sheets architecture.
#
#   ./src/model/genome/native/probe_sheets_architecture.sh [normalized-worldfile]
#
# Why this exists. `BrainArchitecture` is an Enum (`etc/worldfile.wfs:1903`) with two
# values and the shipped library exports the whole Sheets implementation (`SheetsBrain*`,
# `SheetsModel*`, `SheetsGenomeSchema*`, `SheetsCrossover*` in `lib/libpolyworld.dylib`).
# No shipped worldfile uses it, and the port refuses it (`GenomeUtil.createSchema` throws
# for `Sheets`, PORT-NOTE `genome/create-brain-stub`), so PARITY.md's *Gaps* table carried
# "port `genome/sheets/**`" as outstanding work. This probe measures the target before
# anyone transcribes it — and the target is not a run worth reproducing.
#
# What it runs (native runs in an isolated copy of the native tree's *runtime* pieces —
# the native repo itself is never written to and no `run/` there is touched):
#
#   A1 A2  a minimal worldfile, `BrainArchitecture Sheets`, `GenomeLayout` left at the
#          worldfile schema's own default (`NeurGroup if … Groups else None` → `None` for
#          Sheets, `etc/worldfile.wfs:91`), `MaxSteps 1` — run twice, because such a
#          worldfile's gene pool is unseeded (`Seed 0` means "do not seed"), so the two
#          runs are the reproducibility check the harness asks of any new scenario
#   B      a *fully specified* worldfile (a recorded run's own `normalized.wf`) with
#          `BrainArchitecture Sheets` and its Sheets parameters raised far above the schema
#          defaults (brain sizes 8–16, internal sheets 1–5), 60 steps — the same `None` layout
#   C      B with `GenomeLayout NeurGroup` (the only container layout the shipped build has,
#          `GenomeLayout.cc:57`) written out explicitly
#
# Measured verdict (2026-09-29, macOS/arm64, the shipped `libpolyworld.dylib`):
#
#   A1 A2  exit 0, 25 agents, and **every** per-agent brain dump empty in a typical run —
#          anatomy `numneurons+1=1`, synapses `numsynapses=0` — but not always: across 17
#          repeats 846 of 850 anatomy dumps read 0 neurons and 4 read **15** (one run,
#          agents 1–2), and one repeat died with `SIGABRT` (exit 134). A worldfile whose
#          brains are 0 or 15 neurons depending on an unseeded gene pool is not an oracle.
#          stderr always carries `IMPLEMENT INDEX-BASED WEIGHT` (`SheetsGenomeSchema.cc:937`).
#   B      exit 0, 25 agents, 0 neurons / 0 synapses in every dump — the Sheets `config`
#          parameters change nothing; `CurNeurons` at step 60 reads `0.0 ± 0.0 [0, 0]`.
#   C      **SIGSEGV (exit 139)** before the first dump.
#
# Two readings on the way that are worth not repeating: the step-1 `CurNeurons` line is *not*
# a neuron count for Sheets (`1.2 ± 4.1 [0, 15]` on one run whose 50 anatomy dumps all read
# 0 neurons) — the architecture never fills the shared brain-stat accumulator, so that line is
# uninitialised memory — and the emptiness is structural, not a parameter problem: the schema's
# own `GenomeLayout` default gives Sheets the **flat** layout, and
# `SheetsGenomeSchema::createSheetsModel` (`SheetsGenomeSchema.cc:678`) builds the sheet model
# out of the `InputSheets` / `OutputSheets` / `InternalSheets` container genes, which the flat
# layout leaves empty. That is why PARITY.md records Sheets as *not owed* rather than deferred:
# there is no reproducible native brain behaviour to reproduce and no worldfile the oracle can
# complete, so no `sheets_*` golden can be recorded. Re-run this probe if the native tree is
# rebuilt or Sheets is repaired upstream — it prints PASS/FAIL against these verdicts.
#
# Note on the interpreter: the probe copies `src/library` as well as `etc/` and `worldfiles/`,
# because `proplib` execs `python3 <Resources::getInterpreterScript()>` for every
# expression-valued worldfile key (`interpreter.cc:170`) and that path resolves against the cwd.
#
# Note on bounds: each of the four runs is launched in its own process group and killed by
# `run()` if it outlives `SHEETS_PROBE_TIMEOUT` (default 300 s) — a native `Polyworld` that
# wedges must not outlive the probe (W1j measured one spinning at 83.5 % of a core for 14 h).
#
# Note on the native lock: this probe needs none. Every run below has cwd `$WORK`, a copy of the
# native tree's runtime pieces (`Polyworld`, `lib/`, `etc/`, `worldfiles/`, `scripts/`,
# `src/library/`), so it writes `$WORK/run` and never touches the shared `<native>/run` that
# `tools/native_lock.sh` and `tools/record_oracle.py` serialise on -- nothing here execs the
# shared `<native>/Polyworld`. Measured 2026-09-29 (t_547883e1): the shared lock file stays free
# for a whole probe run, and `<native>/run` (and its `run.previous.*` count) is unchanged by it.
#
# Note on isolation (what `$WORK` is, and where the generated worldfiles land): `$WORK` must be a
# *real* copy of those pieces, never a farm of symlinks, because the three worldfiles below are
# written into `<work>/worldfiles` and a symlink there puts them wherever it points. `cp -R` does
# not give that on macOS -- it copies a symlink to a directory as a symlink -- so when `$NATIVE`
# is itself a symlink farm (`$NATIVE/worldfiles -> <native>/worldfiles`, the shape the
# t_e1a5d852 lock-verification runs of this probe used) `cp -R "$NATIVE/worldfiles"
# "$WORK/worldfiles"` left the symlink and the writes went *through* it into the native tree:
# measured 2026-09-29 06:01:20, three untracked `worldfiles/sheets_{a_minimal,b_full,c_neurgroup}.wf`
# appeared in `polyworld` (byte-identical to this probe's cache copies,
# and to a re-run of it against a symlink farm). The copy is `cp -RL` now, every piece is checked
# to be a real path inside `$WORK`, and the probe exits 2 on anything else -- and the generator
# refuses a symlinked `worldfiles` as well, so neither half can write into `$NATIVE`.

set -eu

# A native run is bounded: every `<label>` run below is killed after this many seconds
# (override with SHEETS_PROBE_TIMEOUT). See `run()` for why.
TIMEOUT=${SHEETS_PROBE_TIMEOUT:-300}
NATIVE_PGID=""
reap_native() {
    if [ -n "$NATIVE_PGID" ]; then
        kill -TERM -"$NATIVE_PGID" 2>/dev/null || true
    fi
}
trap 'reap_native' EXIT
trap 'reap_native; exit 130' INT
trap 'reap_native; exit 143' TERM HUP

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)

NATIVE=${POLYWORLD_NATIVE:-}
if [ -z "$NATIVE" ] && [ -f "$REPO_DIR/tools/parity.config.json" ]; then
    NATIVE=$(python3 -c "import json;print(json.load(open('$REPO_DIR/tools/parity.config.json')).get('native_dir',''))" 2>/dev/null || true)
fi
if [ -z "$NATIVE" ]; then
    NATIVE="$REPO_DIR/../polyworld"
fi
if [ ! -f "$NATIVE/lib/libpolyworld.dylib" ]; then
    echo "probe_sheets: '$NATIVE/lib/libpolyworld.dylib' is missing; build the native tree first" >&2
    exit 2
fi

NORMALIZED=${1:-$REPO_DIR/oracle/minitest_voff/run/normalized.wf}
if [ ! -f "$NORMALIZED" ]; then
    echo "probe_sheets: no normalized worldfile at '$NORMALIZED' (pass one as \$1)" >&2
    exit 2
fi

OUT=${SHEETS_PROBE_OUT:-$REPO_DIR/node_modules/.cache/sheets-probe}
WORK="$OUT/work"

die() {  # die <message...>
    echo "probe_sheets: $*" >&2
    exit 2
}

# `realpath` without coreutils: `$NATIVE` and `$WORK` are compared as resolved paths, so that a
# symlinked `$WORK` (or a `$NATIVE` reached through one) cannot hide the containment checks below.
realpath_of() {
    python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"
}

# The native tree is the oracle and is READ-ONLY, so native must never run with a cwd inside it:
# a `Polyworld` started there writes `<native>/run`, displaces `<native>/run.previous.*` and reads
# whatever worldfiles happen to be there -- none of which this probe may do (PORT_SPEC ground
# rule 8; the shared `<native>/run` belongs to the lock-holding recordings). Checked before the
# first `mkdir -p "$WORK"`, so a mis-set SHEETS_PROBE_OUT cannot create anything in there either.
NATIVE_REAL=$(realpath_of "$NATIVE")
WORK_REAL=$(realpath_of "$WORK")
case "$WORK_REAL/" in
    "$NATIVE_REAL"/*)
        die "the work tree '$WORK' resolves inside the native tree ('$NATIVE_REAL'); refusing to run native with a cwd there (use SHEETS_PROBE_OUT to point it elsewhere)" ;;
esac
mkdir -p "$WORK"

# The runtime pieces this probe needs, copied (never linked) into `$WORK`. `cp -RL` dereferences
# the piece itself: on macOS a plain `cp -R` copies a symlink to a directory as a symlink, so a
# symlink-farm `$NATIVE` used to leave `$WORK/worldfiles` pointing at the native tree and the
# generated worldfiles were written into it. See the isolation note in the header.
for piece in Polyworld lib etc worldfiles scripts src/library; do
    if [ ! -e "$WORK/$piece" ]; then
        mkdir -p "$(dirname "$WORK/$piece")"
        cp -RL "$NATIVE/$piece" "$WORK/$piece" || die "cannot copy '$NATIVE/$piece' into the work tree"
    fi
done

# ... and then proved to be copies. Nothing below may run (or write) through a link into `$NATIVE`.
for piece in Polyworld lib etc worldfiles scripts src/library; do
    [ -e "$WORK/$piece" ] || die "the work tree is incomplete: '$WORK/$piece' is missing (remove '$OUT' and re-run)"
    if [ -L "$WORK/$piece" ]; then
        die "'$WORK/$piece' is a symlink (to '$(readlink "$WORK/$piece")'), so this probe's writes would land outside the work tree; remove '$OUT' and re-run"
    fi
    PIECE_REAL=$(realpath_of "$WORK/$piece")
    case "$PIECE_REAL" in
        "$WORK_REAL"/*) ;;
        *) die "'$WORK/$piece' resolves to '$PIECE_REAL', outside the work tree '$WORK_REAL'; refusing" ;;
    esac
done

python3 - "$WORK" "$NORMALIZED" <<'PY'
import re, sys
from pathlib import Path

work = Path(sys.argv[1])
normalized = Path(sys.argv[2]).read_text()

# The three worldfiles below are this probe's inputs and `$WORK` is a copy of the native tree:
# refuse to write them through a link. A symlinked `worldfiles` (what a symlink-farm `$NATIVE`
# used to leave behind, see the header's isolation note) would put them wherever it points --
# measured 2026-09-29 06:01:20, that was the read-only native tree.
wf_dir = work / "worldfiles"
if wf_dir.is_symlink() or wf_dir.resolve().parent != work.resolve():
    raise SystemExit(
        "probe_sheets: refusing to write the generated worldfiles into %s: it is not a real "
        "directory directly inside the work tree %s (a link there would write them outside it, "
        "into whatever it points at)." % (wf_dir, work))

MINIMAL = """@version 2

RecordFrequency 100
RecordAll True

MaxSteps 1

MinAgents 20
MaxAgents 25
InitAgents MaxAgents

MinFood 10
MaxFood 30

MaxInternalNeuralGroups 5

BrainArchitecture Sheets

WorldSize 25
"""

full = normalized.replace("BrainArchitecture Groups", "BrainArchitecture Sheets")
assert "BrainArchitecture Sheets" in full, "the normalized worldfile no longer names the architecture"
full = re.sub(r"MaxSteps\s+\d+", "MaxSteps 60", full)
assert "Sheets {" in full, "the normalized worldfile no longer carries the Sheets block"

# The normalized worldfile spells the whole `Sheets { … }` block out, at the schema's own
# defaults (`MinBrainSize X 1.0 / Y 0.1 / Z 0.1`, `MaxBrainSize 1.0`,
# `MinInternalSheetsCount 0`). Run B raises them well above those defaults, so "the
# parameters were too small" cannot be the explanation for an empty brain.
RAISED = [
    ("MinBrainSize {\n          X 1.0\n          Y 0.1\n          Z 0.1}",
     "MinBrainSize {\n          X 8.0\n          Y 8.0\n          Z 4.0}"),
    ("MaxBrainSize {\n          X 1.0\n          Y 1.0\n          Z 1.0}",
     "MaxBrainSize {\n          X 16.0\n          Y 16.0\n          Z 8.0}"),
    ("MinInternalSheetsCount 0", "MinInternalSheetsCount 1"),
]
full_params = full
for old, new in RAISED:
    assert old in full_params, "the normalized Sheets defaults moved: %r" % old
    full_params = full_params.replace(old, new)

full_neurgroup = full_params.replace(
    "GenomeLayout NeurGroup if BrainArchitecture == BrainArchitecture.Groups else None",
    "GenomeLayout NeurGroup",
)
assert full_neurgroup != full_params, "the normalized worldfile no longer carries the GenomeLayout expression"

(wf_dir / "sheets_a_minimal.wf").write_text(MINIMAL)
(wf_dir / "sheets_b_full.wf").write_text(full_params)
(wf_dir / "sheets_c_neurgroup.wf").write_text(full_neurgroup)
PY

run() {  # run <label> <worldfile>
    label=$1
    wf=$2
    out="$WORK/out-$label"
    mkdir -p "$out"
    code=0
    # Each label owns its own run tree: without this, a second probe into the same cache nests
    # `run/run` (and the verdicts then read the *previous* run's tree), and the `mv` fails
    # outright when the nested directory is already there.
    rm -rf "$out/run" "$WORK/run"
    # Native `Polyworld` is not safe to wait on unbounded — a run can wedge and outlive the
    # probe (W1j measured one spinning at 83.5 % of a core for 14 h 28 m). Run it in its own
    # process group so the whole group can be killed on the deadline; `timeout(1)` is not on
    # macOS by default, so the deadline is enforced here.
    pgid_file="$out/_pgid"
    code_file="$out/_code"
    rm -f "$pgid_file" "$code_file"
    (
        set -m
        ( cd "$WORK" && exec ./Polyworld --ui term --Vision False "worldfiles/$wf" ) \
            > "$out/stdout.txt" 2> "$out/stderr.txt" &
        child=$!
        echo "$child" > "$pgid_file"
        rc=0
        wait "$child" || rc=$?
        echo "$rc" > "$code_file"
    ) 2>/dev/null &
    wrapper=$!

    i=0
    while [ ! -s "$pgid_file" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.2; done
    if [ ! -s "$pgid_file" ]; then
        echo "probe_sheets: $label: the native run never started" >&2
        wait "$wrapper" 2>/dev/null || true
        code=127
    else
        NATIVE_PGID=$(cat "$pgid_file")
        deadline=$(( $(date +%s) + TIMEOUT ))
        timed_out=0
        while [ ! -f "$code_file" ]; do
            if [ "$(date +%s)" -ge "$deadline" ]; then timed_out=1; break; fi
            sleep 1
        done
        if [ "$timed_out" = 1 ]; then
            echo "probe_sheets: $label: native run timed out after ${TIMEOUT}s; killing the process group" >&2
            kill -TERM -"$NATIVE_PGID" 2>/dev/null || true
            j=0
            while [ "$j" -lt 5 ] && kill -0 "$NATIVE_PGID" 2>/dev/null; do j=$((j + 1)); sleep 0.2; done
            kill -KILL -"$NATIVE_PGID" 2>/dev/null || true
        fi
        wait "$wrapper" 2>/dev/null || true
        code=$(cat "$code_file" 2>/dev/null || echo 124)
        NATIVE_PGID=""
    fi
    echo "$code" > "$out/exit_code"
    if [ -d "$WORK/run" ]; then mv "$WORK/run" "$out/run"; fi
    return 0
}

echo "probe_sheets: native=$NATIVE work=$WORK"
run a1 sheets_a_minimal.wf
run a2 sheets_a_minimal.wf
run b sheets_b_full.wf
run c sheets_c_neurgroup.wf

python3 - "$WORK" <<'PY'
import gzip, hashlib, re, sys
from pathlib import Path

work = Path(sys.argv[1])
ANATOMY = re.compile(r"numneurons\+1=(\d+)")
SYNAPSES = re.compile(r"numsynapses=(\d+)")


def head(path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", errors="replace").readline()
    return path.read_text(errors="replace").split("\n")[0]


def measure(run_dir, kind, pattern, minus):
    values = []
    for f in sorted((run_dir / "brain" / kind).glob("*")):
        m = pattern.search(head(f))
        if m:
            values.append(int(m.group(1)) - minus)
    return values


def brain_digest(run_dir):
    """sha256 over the payloads of every `run/brain/**` file — byte-wise reproducibility."""
    h = hashlib.sha256()
    files = sorted(p for p in (run_dir / "brain").rglob("*") if p.is_file())
    for f in files:
        payload = gzip.open(f, "rb").read() if f.suffix == ".gz" else f.read_bytes()
        h.update(str(f.relative_to(run_dir)).encode())
        h.update(hashlib.sha256(payload).digest())
    return h.hexdigest()[:16], len(files)


rows = {}
for label in ("a1", "a2", "b", "c"):
    out = work / ("out-%s" % label)
    code = int((out / "exit_code").read_text().strip() or 0)
    run_dir = out / "run"
    has_brain = (run_dir / "brain").is_dir()
    neurons = measure(run_dir, "anatomy", ANATOMY, 1) if has_brain else []
    synapses = measure(run_dir, "synapses", SYNAPSES, 0) if has_brain else []
    m = re.search(r"CurNeurons\s*=\s*([^\n]*)", (out / "stdout.txt").read_text(errors="replace"))
    digest = brain_digest(run_dir) if has_brain else (None, 0)
    rows[label] = {
        "code": code, "dumps": len(neurons), "zero": sum(1 for n in neurons if n == 0),
        "max": max(neurons) if neurons else None,
        "maxsyn": max(synapses) if synapses else None,
        "cur": (m.group(1).strip() if m else "") or "-",
        "warn": "IMPLEMENT INDEX-BASED WEIGHT" in (out / "stderr.txt").read_text(errors="replace"),
        "digest": digest,
    }

print()
for label in ("a1", "a2", "b", "c"):
    r = rows[label]
    print("%-3s exit=%-4d anatomy dumps=%-4d zero=%-4d max neurons=%-5s max synapses=%-5s CurNeurons=%s"
          % (label, r["code"], r["dumps"], r["zero"], r["max"], r["maxsyn"], r["cur"]))
    if r["digest"][0]:
        print("    run/brain digest=%s over %d files%s"
              % (r["digest"][0], r["digest"][1], "  <- stderr: IMPLEMENT INDEX-BASED WEIGHT" if r["warn"] else ""))

a1, a2, b, c = (rows[k] for k in ("a1", "a2", "b", "c"))
reproducible = a1["digest"][0] is not None and a1["digest"] == a2["digest"]
brainless = all(r["max"] in (None, 0) or r["max"] <= 16 for r in (a1, a2, b))
print()
print("A1 vs A2 (the same worldfile twice): %s"
      % ("byte-identical run/brain" if reproducible else "run/brain DIFFERS — not an oracle"))
print("C (GenomeLayout NeurGroup): exit %d%s"
      % (c["code"], " = SIGSEGV, as measured" if c["code"] == 139 else "  (expected 139)"))
ok = brainless and c["code"] == 139
print()
if ok:
    print("probe_sheets: PASS — the shipped build grows no Sheets brain (%s), so Sheets is not owed a "
          "transcription and no `sheets_*` golden can be recorded."
          % ("and two runs of a Sheets worldfile are not even byte-comparable" if not reproducible else "reproducibly empty"))
else:
    print("probe_sheets: FAIL — the native Sheets behaviour CHANGED; re-measure before trusting PARITY.md.")
sys.exit(0 if ok else 1)
PY
