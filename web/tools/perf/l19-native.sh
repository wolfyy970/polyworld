#!/usr/bin/env bash
# tools/perf/l19-native.sh -- time the NATIVE build on this host, without touching its run tree.
#
# Why this exists: PORT_PLAN.md's published native baseline (~15 ms/step at 25 agents) is
# contradicted by the oracle's own recorded runs on this machine -- `oracle/minitest_voff/
# meta.json` says the whole 301-step native run took 1.98 s (`wall_sec`, measured by
# `tools/record_oracle.py` around the native process), and `microtest_voff` (MaxSteps 1) took
# 1.10 s. A port that lands near the card's ~2x line cannot be judged against a basis the same
# machine already contradicts, so the card's step 1 needs a first-hand native number.
#
# How: native resolves its paths relative to its cwd (`run/` lands in `<cwd>/run`), so this runs
# the binary from a scratch directory of symlinks to the real native tree. Nothing is written to
# `polyworld` -- its `run/` may belong to another lane's probe -- and no
# native lock is needed because the shared tree is never the cwd.
#
#   tools/perf/l19-native.sh                       # minitest_voff, the recorded configuration
#   tools/perf/l19-native.sh --steps 1             # `--MaxSteps 1` (the boot-equivalent run)
#   tools/perf/l19-native.sh --worldfiles microtest  --steps 1
#
# Output: one JSON line per run on stdout, appended to `.candidate/l19-perf/native-runs.jsonl`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/../.." && pwd)"
native_root="${L19_NATIVE_ROOT:-polyworld}"

world="minitest"
steps=""
reps=1
timeout_sec="${L19_NATIVE_TIMEOUT:-180}"
extra=()

while [ $# -gt 0 ]; do
  case "$1" in
    --worldfiles) world="$2"; shift 2 ;;
    --steps)      steps="$2"; shift 2 ;;
    --reps)       reps="$2"; shift 2 ;;
    --timeout-sec) timeout_sec="$2"; shift 2 ;;
    --arg)        extra+=("--$2" "$3"); shift 3 ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "l19-native: unknown flag $1" >&2; exit 2 ;;
  esac
done

farm="${L19_NATIVE_FARM:-staging/l19-natlink}"
mkdir -p "$farm"
for link in etc lib worldfiles bin src; do
  if [ ! -e "$farm/$link" ]; then ln -s "$native_root/$link" "$farm/$link"; fi
done
if [ ! -e "$farm/Polyworld" ]; then ln -s "$native_root/Polyworld" "$farm/Polyworld"; fi

# `run/` must be a real directory in the farm: native writes its whole run tree there.
if [ -L "$farm/run" ]; then rm -f "$farm/run"; fi
mkdir -p "$farm/run"

worldfile="worldfiles/tests/low-spec-pc/${world}.wf"
args=(--ui term --Vision False)
if [ -n "$steps" ]; then args+=(--MaxSteps "$steps"); fi
if [ ${#extra[@]} -gt 0 ]; then args+=("${extra[@]}"); fi
# Native's parser takes the worldfile as the one non-`--` argument (`src/app/main.cc:79-96`).
args+=("$worldfile")

rm -rf "${farm:?}/run"
mkdir -p "$farm/run"

printf 'l19-native: %s %s (cwd %s)\n' "$worldfile" "${args[*]}" "$farm" >&2

started=$(python3 -c 'import time; print(time.time())')
set +e
rep_no=1
while [ "$rep_no" -le "$reps" ]; do
  started=$(python3 -c 'import time; print(time.time())')
  ( cd "$farm" && exec env DYLD_LIBRARY_PATH="$native_root/lib" ./Polyworld "${args[@]}" >"$farm/stdout.txt" 2>"$farm/stderr.txt" ) &
  native_pid=$!
  waited=0
  while kill -0 "$native_pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$timeout_sec" ]; then
      printf 'l19-native: killing the run after %ss (watchdog)\n' "$timeout_sec" >&2
      kill -9 "$native_pid" 2>/dev/null || true
      break
    fi
  done
  wait "$native_pid"
  code=$?
  finished=$(python3 -c 'import time; print(time.time())')
  wall=$(python3 -c "print(round($finished - $started, 3))")

  end_reason=""
  if [ -f "$farm/run/endReason.txt" ]; then end_reason="$(cat "$farm/run/endReason.txt")"; fi
  end_step=""
  if [ -f "$farm/run/endStep.txt" ]; then end_step="$(cat "$farm/run/endStep.txt")"; fi
  # The agent count the run's *own* worldfile resolved, so the comparison is against the world
  # that actually ran (same rule as the TS side's `resolveAgentCount`).
  max_agents=""
  if [ -f "$farm/run/normalized.wf" ]; then
    max_agents="$(grep -m 1 -E '^[[:space:]]*MaxAgents[[:space:]]+[0-9]+' "$farm/run/normalized.wf" | tr -dc '0-9')"
  fi

  json=$(python3 - "$worldfile" "$steps" "$code" "$wall" "$end_reason" "$end_step" "$rep_no" "$max_agents" <<'PY'
import json, sys
worldfile, steps, code, wall, end_reason, end_step, rep, max_agents = sys.argv[1:9]
print(json.dumps({
    "worldfile": worldfile,
    "maxSteps": None if steps == "" else int(steps),
    "maxAgents": None if max_agents == "" else int(max_agents),
    "repetition": int(rep),
    "exitCode": int(code),
    "wallSec": float(wall),
    "endReason": end_reason,
    "endStep": end_step,
}, sort_keys=True))
PY
)
  mkdir -p "$web_root/.candidate/l19-perf"
  printf '%s\n' "$json" >> "$web_root/.candidate/l19-perf/native-runs.jsonl"
  printf '%s\n' "$json"
  rep_no=$((rep_no + 1))
done
set -e
