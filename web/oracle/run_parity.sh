#!/usr/bin/env bash
# oracle/run_parity.sh -- the per-lane parity entry point (owned by lane W1f).
#
#   ./oracle/run_parity.sh <scenario> --candidate <dir>     check a candidate run tree
#   ./oracle/run_parity.sh <scenario> --record [--force]    record/re-record the golden (native)
#   ./oracle/run_parity.sh <scenario> --selfcheck           re-run native, compare to its own golden
#   ./oracle/run_parity.sh add <name> --worldfile <wf> ...  register a new worldfile + args
#   ./oracle/run_parity.sh list [--json]                    registered scenarios + golden status
#   ./oracle/run_parity.sh --help
#
# `<candidate>` is either a directory containing run/ (what a lane's TS build
# writes) or the run tree itself. Either spelling is refused (exit 2) when it
# resolves into a frozen golden -- the run-tree spelling included, so
# `--candidate <worktree>/oracle/<scenario>/run` (a symlink at the canonical
# golden) can never be graded as a copy of itself (t_f049065c: it printed
# `PASS (225/225 files)`); a copy to perturb belongs under $TMPDIR or
# oracle/_t_*. Exit 0 = the candidate matches the golden
# byte-for-byte modulo the scenario's ignore patterns; 1 = parity failure;
# 2 = usage/environment error.
#
# PORT-NOTE(parity-runner/thin-wrapper): all logic lives in tools/parity_common.py,
# tools/check_parity.py, tools/record_oracle.py and tools/add_scenario.py. This
# script resolves the scenario, dispatches, and composes selfcheck. Flags are
# forwarded verbatim, so the tools keep their own CLIs -- including the exact
# command PORT_SPEC.md's definition of done names:
#   python3 tools/check_parity.py --golden oracle/<scenario> --candidate <dir>
#
# PORT-NOTE(parity-runner/selfcheck-staging): --selfcheck records a fresh native
# run into oracle/_t_selfcheck_<scenario>_<pid>/ (the .gitignore reserves
# oracle/_t_*/ for staged candidates), compares it against the recorded golden and
# removes only its own staging directory. It answers "did my change break it, or is
# the golden flaky?" -- required before trusting a diff on a vision-on scenario.
# With --keep-stage the staged native tree is left in place for inspection.
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "$HERE/.." && pwd)"
TOOLS="$WEB_ROOT/tools"
PY="${PARITY_PYTHON:-python3}"
# PORT-NOTE(parity-runner/oracle-root): oracle/*/run/** is gitignored, so a lane
# in its own git worktree has no goldens. Point at the canonical ones instead of
# re-recording: POLYWORLD_ORACLE_ROOT=<path-to-oracle>.
ORACLE_ROOT="${POLYWORLD_ORACLE_ROOT:-$WEB_ROOT/oracle}"

die() { printf 'run_parity: %s\n' "$*" >&2; exit 2; }

usage() {
	cat <<'EOF'
oracle/run_parity.sh -- per-lane parity harness for the Polyworld TS port

  run_parity.sh <scenario> --candidate <dir>       check candidate run tree vs golden   (0 pass / 1 fail)
  run_parity.sh <scenario> --record [--force]      record the golden from the native build
  run_parity.sh <scenario> --selfcheck             re-run native and compare it to its own golden
  run_parity.sh check|record|selfcheck <scenario>  same three modes, subcommand form
  run_parity.sh add <name> --worldfile <wf> [...]  register a lane scenario, then --record
  run_parity.sh list [--json]                      registered scenarios and golden status
  run_parity.sh show <scenario> [--json]           fully resolved scenario (args, ignores, golden)
  run_parity.sh paths                              resolved web/native/oracle roots
  run_parity.sh --help

check flags   --json  --quiet  --ignore <prefix> (repeatable)  --max-detail N  --max-diffs N
              --include-stdout (informational: stdout is NOT part of the frozen contract)
record flags  --force  --timeout N  --native <dir>  --candidate-out <dir>  --json
add flags     --tier A|B  --ignore <prefix>  --arg --Key  --arg value  --notes <text>  --record [--force]
selfcheck     --keep-stage (keep the staged native run)

Environment   POLYWORLD_NATIVE       native Polyworld tree (default: ../polyworld next to this repo)
              POLYWORLD_ORACLE_ROOT  where the goldens live (default: <repo>/oracle; needed in a
                                     git worktree, since oracle/*/run/** is gitignored)
              POLYWORLD_WEB      web repo root
              PARITY_PYTHON      python for the tool scripts (default: python3)

Rules encoded here: the native tree's run/ is never deleted (it is moved aside to
run.previous.<epoch>), an existing golden is never overwritten silently (--force
moves it to oracle/_native_previous/, nothing is deleted), and native runs are
serialised with a lock on <native>/.parity-native.lock so parallel lanes cannot
interleave into one run/ tree.
EOF
}

mode=""
keep_stage=0

# --- subcommand form -------------------------------------------------------- #
case "${1:-}" in
	""|-h|--help|help) usage; exit 0 ;;
	list) shift; exec "$PY" "$TOOLS/parity_common.py" list "$@" ;;
	show) shift; exec "$PY" "$TOOLS/parity_common.py" show "$@" ;;
	paths) shift; exec "$PY" "$TOOLS/parity_common.py" paths "$@" ;;
	add) shift; exec "$PY" "$TOOLS/add_scenario.py" "$@" ;;
	check|record|selfcheck) mode="$1"; shift ;;
esac

[ $# -gt 0 ] || die "no scenario given (try --help)"
scenario="$1"
shift
golden="$ORACLE_ROOT/$scenario"

# --- collect the rest: mode flags are consumed, everything else is forwarded - #
rest=()
for arg in "$@"; do
	case "$arg" in
		--record) mode="record" ;;
		--selfcheck) mode="selfcheck" ;;
		--check) mode="check" ;;
		--keep-stage) keep_stage=1 ;;
		*) rest+=("$arg") ;;
	esac
done
[ -n "$mode" ] || mode="check"

case "$mode" in
	check)
		exec "$PY" "$TOOLS/check_parity.py" --golden "$golden" --scenario "$scenario" \
			${rest[@]+"${rest[@]}"}
		;;
	record)
		exec "$PY" "$TOOLS/record_oracle.py" --scenario "$scenario" ${rest[@]+"${rest[@]}"}
		;;
	selfcheck)
		[ -d "$golden" ] || die "no golden recorded for $scenario yet (run: ./oracle/run_parity.sh $scenario --record)"
		# split the forwarded flags: record_oracle.py and check_parity.py take
		# different sets, and neither knows about the other's.
		rec_flags=()
		chk_flags=()
		i=0
		n=${#rest[@]}
		while [ "$i" -lt "$n" ]; do
			arg="${rest[$i]}"
			case "$arg" in
				--force|--timeout|--native|--web|--candidate-out)
					rec_flags+=("$arg")
					i=$((i + 1))
					[ "$i" -lt "$n" ] && rec_flags+=("${rest[$i]}") ;;
				--json)
					rec_flags+=("$arg"); chk_flags+=("$arg") ;;
				--quiet|--include-stdout|--no-scenario-defaults)
					chk_flags+=("$arg") ;;
				--ignore|--max-detail|--max-diffs)
					chk_flags+=("$arg")
					i=$((i + 1))
					[ "$i" -lt "$n" ] && chk_flags+=("${rest[$i]}") ;;
				*) printf 'run_parity: ignoring unsupported selfcheck flag %s\n' "$arg" >&2 ;;
			esac
			i=$((i + 1))
		done
		stage="$ORACLE_ROOT/_t_selfcheck_${scenario}_$$"
		cleanup() { [ "$keep_stage" = 1 ] || rm -rf "$stage"; }
		trap cleanup EXIT
		rm -rf "$stage"
		printf 'run_parity: selfcheck %s -- re-running native into %s\n' "$scenario" "$stage"
		"$PY" "$TOOLS/record_oracle.py" --scenario "$scenario" --candidate-out "$stage" \
			${rec_flags[@]+"${rec_flags[@]}"} || exit $?
		set +e
		"$PY" "$TOOLS/check_parity.py" --golden "$golden" --scenario "$scenario" \
			--candidate "$stage" ${chk_flags[@]+"${chk_flags[@]}"}
		rc=$?
		set -e
		if [ "$keep_stage" = 1 ]; then printf 'run_parity: staged native run kept at %s\n' "$stage"; fi
		exit "$rc"
		;;
	*) die "unhandled mode: $mode" ;;
esac
