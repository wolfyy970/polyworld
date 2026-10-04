#!/usr/bin/env bash
# tools/parity_candidate.sh -- one command, one scenario: run the port end to end and grade it.
#
#   tools/parity_candidate.sh microtest_voff
#   tools/parity_candidate.sh minitest_voff
#   tools/parity_candidate.sh microtest_voff --json          # harness flags are forwarded verbatim
#   tools/parity_candidate.sh microtest_voff --steps 3       # stop early: localizing, NOT a verdict
#   tools/parity_candidate.sh microtest_voff --out /tmp/parity-micro   # candidate root override
#
# It (1) wipes and rebuilds the candidate root, (2) drives `tests/parity-candidate.test.ts` through
# vitest — the port's own pinned TypeScript runner — with `runScenario({ scenario, outDir,
# documentFrom: 'port-boot' })`, so the tree is written from the *recorded* worldfile by the port
# itself, and (3) grades that tree with the frozen entry point:
#
#   ./oracle/run_parity.sh <scenario> --candidate <root>
#
# The harness's output is printed **verbatim** and teed to `<root>.parity.log`; its exit code is
# this script's exit code (0 = byte-parity, 1 = parity failure, 2 = usage/environment error).
# `run/movie.pmv` is not compared: every tier ignores it by default (t_588c28e1), which
# `./oracle/run_parity.sh list` shows per scenario.
#
# PORT-NOTE(parity-candidate/why-vitest): the port has no pinned TS runner (`package.json` pins
# `vite`/`vitest` only; the sources import extensionlessly), so `npx tsx src/model/sim/runner.ts`
# — the command PARITY.md's status prose names — downloads an unpinned package on every call. A
# verdict has to be reproducible from the lockfile, so this script runs the tree-writing phase
# through `npx vitest run`, exactly as `tools/perf/l19-bench.sh` does for lane L19's phases.
#
# PORT-NOTE(parity-candidate/one-run-per-process): one vitest process per scenario, so exactly one
# `runScenario` per process — the port's model registries are process-global statics
# (see tests/parity-candidate.test.ts).
#
# Default candidate root: .candidate/parity/pid-<pid>/<scenario> (gitignored; `pid-<pid>` is this
# script's own pid). The key is the point, not a decoration: a root shared by two graded runs of one
# scenario lets either run grade a tree the other is still writing (`EXTRA ...`/`MISSING ...` from a
# half-built tree → false FAIL) or wipe a file out from under the other's rename (`ENOENT ... rename
# 'run/brain/function/incomplete_brainFunction_N.txt.gz'` → false "no usable run tree"), so the tree
# is never a fixed path here. **Two concurrent runs of one scenario must not share a root**: the
# default already does not, and an explicit `--out <dir>` is the caller's own root — pass a distinct
# one per concurrent run (the tool cannot key a path it was handed, and deliberately does not try).
# PORT-NOTE(parity-candidate/root-keyed-per-process): the same false-red class t_1ce9957f closed for
# the browser lane's candidate root (key the default per process, honour an explicit pin verbatim).
# Keying leaves one tree per run under .candidate/parity/pid-<pid>/: scratch, regenerable in seconds
# from the lockfile, and a `pid-*` dir whose run is over can be deleted freely (`rm -rf`). It no
# longer has to be: `tools/tmp_prune.ts` reclaims these trees unattended — owner pid gone **and**
# untouched for `--min-age` — because the supervisor cannot `rm -rf` (t_4f775095).
#
# Any root outside the oracle's own namespace works — `$TMPDIR`, `oracle/_t_*`, `.candidate/**`; a
# root inside `oracle/` (a frozen golden, but also the oracle root itself) never does. The root is
# refused *before* anything is wiped, by the same predicate the runner uses (`src/oracle/guard.ts`);
# this script refuses the spelling up front so the misuse does not even start a vitest run.
set -u -o pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/.." && pwd)"

usage() {
	sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

[ $# -gt 0 ] || { usage; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; esac

scenario="$1"
shift

out=""
steps="full"
forward=()
while [ $# -gt 0 ]; do
	case "$1" in
		--out)     out="$2"; shift 2 ;;
		--steps)   steps="$2"; shift 2 ;;
		*)         forward+=("$1"); shift ;;
	esac
done

case "$out" in
	"") out="$web_root/.candidate/parity/pid-$$/$scenario" ;;
	/*) : ;;
	*)  out="$web_root/$out" ;;
esac

# Refuse an oracle-namespace root before vitest starts. This is the *spelling* of the root this
# script was handed (relative roots are joined to the web root just above), so it fails loudly and
# for free; the authoritative, symlink-resolving decision is `assertUsableStagingRoot`, which the
# tree-writing phase runs before it wipes anything (`tests/parity-candidate.test.ts`).
case "$out" in
	"$web_root/oracle"|"$web_root/oracle/")
		printf 'parity_candidate: refusing %s as a candidate root — that is the oracle root, and only `run_parity.sh <scenario> --record` writes there (src/oracle/guard.ts)\n' "$out" >&2
		exit 2 ;;
	"$web_root/oracle/_t_"*) : ;;
	"$web_root/oracle/"*)
		printf 'parity_candidate: refusing %s as a candidate root — under the oracle namespace, where only oracle/_t_* is a candidate root and oracle/<scenario> is a frozen golden (src/oracle/guard.ts)\n' "$out" >&2
		exit 2 ;;
esac

# `--steps` is part of the tool's contract (`full` = the recorded configuration, the only value a
# verdict may be taken from), so a typo must not silently run the full scenario and call it
# localized evidence.
case "$steps" in
	full) : ;;
	''|*[!0-9]*)
		printf 'parity_candidate: --steps expects "full" (the graded configuration) or a step count (got %s)\n' "$steps" >&2
		exit 2 ;;
esac

mkdir -p "$(dirname "$out")"
log="$out.parity.log"
report="$out.run.json"

cd "$web_root" || exit 2

printf 'parity_candidate: scenario=%s steps=%s\n' "$scenario" "$steps"
printf 'parity_candidate: candidate root %s (HEAD %s)\n' "$out" "$(git rev-parse --short HEAD 2>/dev/null || echo '?')"

# (1)+(2) the port writes the tree. `--reporter=default` keeps the phase's own stdout (the tree,
# the step count, why a short run stopped) in the log this script leaves behind.
PARITY_CANDIDATE_SCENARIO="$scenario" \
PARITY_CANDIDATE_OUT="$out" \
PARITY_CANDIDATE_STEPS="$steps" \
PARITY_CANDIDATE_REPORT="$report" \
	npx vitest run tests/parity-candidate.test.ts --reporter=default
run_rc=$?
if [ "$run_rc" -ne 0 ]; then
	printf 'parity_candidate: the port did not write a usable run tree for %s (vitest exit %s); not grading a partial tree\n' "$scenario" "$run_rc" >&2
	exit "$run_rc"
fi

# (3) the verdict. Forwarded verbatim; the log holds the harness's own words.
printf '\nparity_candidate: grading %s\n' "$out"
"$web_root/oracle/run_parity.sh" "$scenario" --candidate "$out" ${forward[@]+"${forward[@]}"} 2>&1 | tee "$log"
verdict=${PIPESTATUS[0]}

printf '\nparity_candidate: %s verdict=%s (exit %s) log=%s report=%s\n' \
	"$scenario" "$([ "$verdict" -eq 0 ] && echo PASS || echo FAIL)" "$verdict" "$log" "$report"
exit "$verdict"
