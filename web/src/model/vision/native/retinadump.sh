#!/usr/bin/env bash
# Build and run the W1j/L16 native retina-row dumper (src/model/vision/native/retinadump.cpp).
#
#   src/model/vision/native/retinadump.sh [--scenario <name>] [--out <file.jsonl>]
#                                         [--worldfile <wf>] [--keep-run] [--timeout N]
#
# `--timeout N` (default 1800 s) bounds the native run: the process is started in its own
# process group and the group is killed on expiry (`retinadump: native run timed out after
# N s`, non-zero exit), and it is reaped as soon as the shim reports its own end of work —
# `./Polyworld --ui term` is not something to wait on. Without this, a wedged run outlives
# the probe: one spun at 83.5 % of a core for 14 h 28 m.
#
# `Polyworld` always writes `<native>/run`, so this probe also serialises with every other
# native writer on `<native>/.parity-native.lock`: before it builds anything it re-execs itself
# under `tools/native_lock.sh` -- fcntl.flock, bounded wait (`RETINADUMP_LOCK_WAIT`, default
# 1800 s) -- so the lock covers the shim build, the displacement and the whole run, and is
# released however the run ends, the deadline included. macOS ships no `flock(1)`, which is why
# the shell probes need that helper: the `flock 9` this used to do never locked anything here.
#
# The native tree is the oracle and is READ-ONLY: this script includes its headers, links its
# already-built libpolyworld.dylib and inserts a shim dylib at run time. It never writes inside
# the native tree (the native binary itself writes its `run/` output, which is displaced first
# exactly as tools/record_oracle.py does), never touches oracle/**, and adds no dependency the
# port itself depends on — it is a probe, not part of the shipped model.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(cd "$here/../../../.." && pwd)"
native="${POLYWORLD_NATIVE:-$(cd "$web_root/../polyworld" && pwd)}"

scenario="minitest_von"
out=""
worldfile=""
keep_run=0
timeout=1800
build_only=0
shim_out=""
native_pgid=""

orig_args=("$@")                     # the re-exec below needs argv *before* the parse loop eats it

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) scenario="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --worldfile) worldfile="$2"; shift 2 ;;
    --keep-run) keep_run=1; shift ;;
    --timeout) timeout="$2"; shift 2 ;;
    --build-only) build_only=1; shift ;;
    --shim-out) shim_out="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "retinadump: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$native/lib/libpolyworld.dylib" ]; then
  echo "retinadump: no native build at $native (set POLYWORLD_NATIVE)" >&2
  exit 2
fi

case "$timeout" in
  ''|*[!0-9]*)
    echo "retinadump: --timeout takes whole seconds (got '$timeout')" >&2
    exit 2 ;;
esac

if [ -z "$worldfile" ]; then
  case "$scenario" in
    minitest_von) worldfile="worldfiles/tests/low-spec-pc/minitest.wf" ;;
    microtest_von) worldfile="worldfiles/tests/low-spec-pc/microtest.wf" ;;
    *) echo "retinadump: no default worldfile for $scenario (pass --worldfile)" >&2; exit 2 ;;
  esac
fi

if [ -z "$out" ]; then
  out="$here/$scenario.retina.jsonl"
fi

work="${TMPDIR:-/tmp}/retinadump.$$"
if [ -n "$shim_out" ]; then
  shim="$shim_out"
else
  shim="$work/libretinadump.dylib"
fi

# A wedged native run must not outlive this script: the trap kills its process group (see
# "the native run, bounded" below) as well as removing the scratch directory.
cleanup() {
  if [ -n "$native_pgid" ] && [ ! -f "$work/exit_code" ]; then
    kill -TERM -"$native_pgid" 2>/dev/null || true
    sleep 0.5
    kill -KILL -"$native_pgid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# Built by whichever pass is holding the lock (below), so nothing -- not even the scratch
# directory -- exists before the native lock is taken.
build_shim() {
  mkdir -p "$work"
  mkdir -p "$(dirname "$shim")"
  sdk="$(xcrun --show-sdk-path)"
  clang++ -std=c++17 -O1 -dynamiclib -DGL_SILENCE_DEPRECATION \
    -I"$sdk/System/Library/Frameworks/OpenGL.framework/Headers" \
    -I"$native/src/library" \
    -I"$native/src/library/graphics" \
    "$here/retinadump.cpp" \
    -L"$native/lib" -lpolyworld \
    -framework OpenGL \
    -Wl,-rpath,"$native/lib" \
    -Wl,-rpath,/opt/homebrew/opt/gsl/lib \
    -Wl,-rpath,/opt/homebrew/opt/libomp/lib \
    -o "$shim"
  echo "retinadump: built $shim"
}

if [ "$build_only" = 1 ]; then
  build_shim                      # a build runs no native, so it takes no lock
  exit 0
fi

# --- serialise with every other native writer ---------------------------------------------
#
# The native binary always writes to `<native>/run`, so two native writers must not overlap.
# The whole harness serialises on one file, `<native>/.parity-native.lock`, taken with
# `fcntl.flock`: tools/parity_common.py:native_lock (and tools/record_oracle.py, which holds it
# for a whole recording). This script used to take the same lock with `flock 9` guarded by
# `if command -v flock` -- and macOS ships no `flock(1)` (verified: `command -v flock` prints
# nothing on macOS 26.5.2), so the guard skipped it and two probes could displace and interleave
# each other's run tree. The lock is now taken by tools/native_lock.sh (python3 fcntl.flock,
# bounded wait) and this script re-execs itself under it *before it builds anything*, so one
# mechanism on one path covers the shim build, the displacement and the whole run -- and a lock
# timeout, or a failed exec, cannot leave a half-built probe behind in $TMPDIR (bash does not run
# an EXIT trap when `exec` itself fails; measured). One process, one process group: the helper
# execs the command rather than supervising it, so the bounded-run block below still has exactly
# one group to kill, and killing it (or exiting, or dying) is what releases the lock.
lock="$native/.parity-native.lock"
if [ "${RETINADUMP_LOCKED:-0}" != 1 ]; then
  exec env RETINADUMP_LOCKED=1 \
    "$web_root/tools/native_lock.sh" \
      --lock "$lock" \
      --wait "${RETINADUMP_LOCK_WAIT:-1800}" \
      --purpose "retinadump ${scenario}" \
      -- bash "$here/${BASH_SOURCE[0]##*/}" "${orig_args[@]+"${orig_args[@]}"}"
fi

# Locked from here on: this is the pass that builds, displaces and runs.
echo "retinadump: holding the native lock $lock"
build_shim

if [ "$keep_run" = 0 ] && [ -d "$native/run" ]; then
  moved="$native/run.previous.$(date +%s)"
  mv "$native/run" "$moved"
  echo "retinadump: displaced native run/ -> $(basename "$moved")"
fi

echo "retinadump: running native under the shim ($scenario)"

# --- the native run, bounded -------------------------------------------------------------
#
# `./Polyworld --ui term` is not safe to wait on:
#
#   * a run can wedge. The orphan this bound was written for (W1j, 2026-09-28) had no
#     `run/endReason.txt` — it never finished a single step — and spun at 83.5 % of a core
#     for 14 h 28 m until the supervisor killed it. Nothing in the run itself ends that.
#   * and a *finished* run can outlive its own work. This shim is inserted into a process
#     that has Qt mapped (native maps `libqcocoa`/`QtGui`; `--ui term` still spins an event
#     loop after the simulation stops), so waiting for the process to exit waits on the GUI,
#     not on the model.
#
# So the native process gets its *own process group*, its own end of work is read from the
# shim, and the group is killed both then and on the deadline (`timeout(1)` is not on macOS,
# so the deadline is enforced here): the shim's destructor prints `pwvision: <n> rows (…)`
# (`retinadump.cpp:322-330`) *after* `fclose`-ing the dump, which is exactly the point at
# which the rows on disk stop moving. Until that line appears (or the process exits) the run
# is still doing work, so it is only ever killed by the deadline.
native_pgid=""
: >"$work/pgid"                              # the wrapper publishes the child pid here
# `$work/exit_code` is *not* pre-created: its existence is the watchdog's "the run is over"
# signal, and the wrapper writes it when `wait` on the native child returns.

(
  set -m                                    # the background job becomes its own process group
  (
    cd "$native"
    exec env DYLD_INSERT_LIBRARIES="$shim" \
             VISION_DUMP_OUT="$out" \
             VISION_NATIVE_LIB="$native/lib/libpolyworld.dylib" \
             ./Polyworld --ui term "$worldfile"
  ) >"$work/stdout.txt" 2>"$work/stderr.txt" &
  native_child=$!
  echo "$native_child" >"$work/pgid"
  code=0
  wait "$native_child" || code=$?            # `set -e` is on: a non-zero wait must not kill this
  echo "$code" >"$work/exit_code"
) 2>/dev/null &
run_wrapper=$!

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [ -s "$work/pgid" ] && break
  sleep 0.2
done
if [ ! -s "$work/pgid" ]; then
  echo "retinadump: could not start the native run; stderr:" >&2
  tail -20 "$work/stderr.txt" >&2
  exit 1
fi
native_pgid="$(cat "$work/pgid")"

# Kill the whole group, not just its leader, and give it a moment to flush before SIGKILL.
reap_group() {
  kill -TERM -"$native_pgid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$native_pgid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL -"$native_pgid" 2>/dev/null || true
  return 0
}

deadline=$((SECONDS + timeout))
outcome=exit                                  # exit | work | timeout
settled_size=-1
settled_at=$SECONDS
while [ ! -f "$work/exit_code" ]; do
  if [ -f "$out" ] && [ -f "$work/stderr.txt" ] &&
     grep -q '^pwvision: [0-9][0-9]* rows (' "$work/stderr.txt"; then
    size=$(wc -c <"$out" | tr -d ' ')
    if [ "$size" = "$settled_size" ]; then
      if [ $((SECONDS - settled_at)) -ge 1 ]; then
        outcome=work                          # the shim closed the dump and stopped writing
        break
      fi
    else
      settled_size="$size"
      settled_at=$SECONDS
    fi
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    outcome=timeout
    break
  fi
  sleep 1
done

if [ "$outcome" = timeout ]; then
  reap_group
  wait "$run_wrapper" 2>/dev/null || true
  echo "retinadump: native run timed out after ${timeout}s" >&2
  echo "retinadump: killed native process group $native_pgid; any dump at $out is partial" >&2
  exit 1
fi

if [ "$outcome" = work ]; then
  reap_group
  wait "$run_wrapper" 2>/dev/null || true
  echo "retinadump: native run reached its own end of work; reaped process group $native_pgid" >&2
else
  wait "$run_wrapper" 2>/dev/null || true
fi

code="$(cat "$work/exit_code" 2>/dev/null || true)"
[ -n "$code" ] || code=0
if [ "$outcome" = exit ] && [ "$code" != 0 ]; then
  echo "retinadump: native run failed (exit $code); stderr:" >&2
  tail -20 "$work/stderr.txt" >&2
  exit 1
fi

grep -E "pwvision:" "$work/stderr.txt" >&2 || true
if [ ! -f "$out" ]; then
  echo "retinadump: the run produced no dump at $out" >&2
  exit 1
fi
rows=$(wc -l <"$out" | tr -d ' ')
echo "retinadump: $rows rows -> $out"
