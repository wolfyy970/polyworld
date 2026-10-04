#!/usr/bin/env bash
# tools/perf/l19-bench.sh -- the L19 (WASM/perf) measurement entry point.
#
#   tools/perf/l19-bench.sh                             # minitest_voff, to its own end (301 steps), 25 agents
#   tools/perf/l19-bench.sh --steps 301 --reps 3        # the same, three timed repetitions (median)
#   tools/perf/l19-bench.sh --agents 192 --steps 301    # the plan's big world (--MaxAgents 192)
#   tools/perf/l19-bench.sh --scenario microtest_voff --steps full
#   tools/perf/l19-bench.sh --only report               # re-combine the phases already on disk
#   tools/perf/l19-bench.sh --only steps --rep 2        # one phase on its own
#   tools/perf/l19-bench.sh --clean                     # drop the transient per-run artifacts
#
# It drives tests/l19-perf.test.ts (the only TS runner in the tree: vitest transforms the
# sources, no extra toolchain) once per **phase**, because each timed run needs its own process:
# the port keeps native's model registries as process-global statics, so a second `runScenario`
# in the same process dies at `processWorldFile` with `sim: duplicate FoodType name 'Standard'`.
#
#   boot      one `maxSteps: 0` run -> the boot cost the step loop is separated from
#   steps     N timed repetitions (`--reps`, default 1) -> steps/s; the median is reported
#   profile   the same run under the V8 profiler -> the flame profile (its wall time is NOT the number)
#   contract  the recorded configuration of the contract scenario (default microtest_voff) -> the
#             byte-parity verdict any WASM boundary would have to keep at exit 0
#   report    combines the phases, asks ./oracle/run_parity.sh for the verdicts, writes the report
#             and states the card's decision ("within ~2x of native -> do NOT add WASM")
#
# Output: `.candidate/l19-perf/report-<scenario>-<agents>-<steps>steps-<stepsArg>.json`,
# `latest.md`, `phases/*.json` (one per phase, so the numbers are auditable), the raw
# `.cpuprofile.json` and the run trees under `.candidate/l19-perf/trees/`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/../.." && pwd)"

scenario="minitest_voff"
steps="full"
agents=""
reps=1
rep=1
contract_scenario="microtest_voff"
only=""

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) scenario="$2"; shift 2 ;;
    --steps)    steps="$2"; shift 2 ;;
    --agents)   agents="$2"; shift 2 ;;
    --reps)     reps="$2"; shift 2 ;;
    --rep)      rep="$2"; shift 2 ;;
    --contract-scenario) contract_scenario="$2"; shift 2 ;;
    --only)     only="$2"; shift 2 ;;
    --clean)
      # Transient artifacts only: the phase JSON, the run trees and the `.cpuprofile` are per-run
      # and cheap to regenerate; the reports and `native-runs.jsonl` are the evidence and stay.
      per_dir="$(cd "$here/../.." && pwd)/.candidate/l19-perf"
      for stale in phases trees cpuprofile.json run; do
        if [ -d "$per_dir/$stale" ]; then find "$per_dir/$stale" -mindepth 1 -delete; fi
      done
      if [ -f "$per_dir/latest.md" ]; then rm "$per_dir/latest.md"; fi
      # Also drop the artifacts of the *superseded* instrument: the ad-hoc probe run trees and the
      # `steps=0` reports written by the version that booted twice in one process (the bug the
      # phase split fixed — those reports would read as model blockers they were not).
      for probe in "$per_dir"/probe-*; do
        if [ -d "$probe" ]; then find "$probe" -mindepth 1 -delete && rmdir "$probe"; fi
      done
      rm -f "$per_dir"/report-*-0steps.json
      printf 'l19-bench: cleaned %s (phases, trees, profile, last report, probe trees; reports + native-runs.jsonl kept)\n' "$per_dir"
      exit 0 ;;
    -h|--help)
      sed -n '2,28p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "l19-bench: unknown flag $1" >&2; exit 2 ;;
  esac
done

cd "$web_root"
export L19_RUN=1
export L19_SCENARIO="$scenario"
export L19_STEPS="$steps"
export L19_REPS="$reps"
export L19_REP="$rep"
export L19_CONTRACT_SCENARIO="$contract_scenario"
if [ -n "$agents" ]; then export L19_AGENTS="$agents"; else unset L19_AGENTS; fi

per="$web_root/.candidate/l19-perf"

printf 'l19-bench: scenario=%s steps=%s agents=%s reps=%s contract=%s only=%s (repo %s)\n' \
  "$scenario" "$steps" "${agents:-<worldfile MaxAgents>}" "$reps" "$contract_scenario" \
  "${only:-all}" "$web_root"

# One phase = one `npx vitest` process = at most one `runScenario` (see the header).
phase() {
  local name="$1"
  if [ -n "$only" ] && [ "$only" != "$name" ]; then return 0; fi
  printf '\nl19-bench: phase %s (rep %s)\n' "$name" "$L19_REP"
  L19_PHASE="$name" npx vitest run tests/l19-perf.test.ts
}

if [ -z "$only" ]; then
  # A stale phase (or a stale run tree) from an earlier invocation must not leak into this
  # report: the phases are keyed by name, and a run tree that is not overwritten would be graded
  # as if this run had written it.
  find "$per/phases" -type f -delete 2>/dev/null || true
  find "$per/trees" -mindepth 1 -delete 2>/dev/null || true
fi

if [ -z "$only" ]; then
  phase boot
  rep_no=1
  while [ "$rep_no" -le "$reps" ]; do
    L19_REP="$rep_no" phase steps
    rep_no=$((rep_no + 1))
  done
  phase profile
  phase contract
fi
if [ -n "$only" ] && [ "$only" != "report" ]; then
  case "$only" in
    boot|steps|profile|contract) phase "$only" ;;
    *) echo "l19-bench: unknown phase $only" >&2; exit 2 ;;
  esac
else
  phase report
fi

report_md="$per/latest.md"
if [ "$only" = "report" ] || [ -z "$only" ]; then
  if [ -f "$report_md" ]; then
    # `latest.md` is the last run's report; keep a per-configuration copy so the 25-agent and the
    # 192-agent measurements can both be read afterwards (the phases dir is per-run). The epoch
    # suffix keeps *windows* apart too: on a shared machine two runs of the same configuration
    # differ by ~15 %, and overwriting the earlier one would hide that.
    cp "$report_md" "$per/report-${scenario}-${agents:-recorded}-${steps}-${reps}reps-$(date +%s).md"
    printf '\nl19-bench: report -> %s\n' "$report_md"
    printf 'l19-bench: phase JSON + profile + trees -> %s\n\n' "$per"
  else
    printf 'l19-bench: no report written (see output above)\n' >&2
    exit 1
  fi
fi
