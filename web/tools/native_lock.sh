#!/usr/bin/env bash
# tools/native_lock.sh -- hold the native-run lock across a command, on a box with no flock(1).
#
#   tools/native_lock.sh [--lock PATH] [--native DIR] [--wait SEC] [--purpose TEXT] -- <cmd> [args...]
#
# Why this exists: `Polyworld` always writes `<native>/run`, so every native writer has to
# serialise on `<native>/.parity-native.lock`. The Python harness does it with
# `tools/parity_common.py:native_lock` (fcntl.flock); the shell probes did it with `flock 9`
# under `if command -v flock`, and macOS ships no `flock(1)` -- so the probes took no lock at
# all and two of them could displace and interleave each other's `run/` tree. This is the
# shell half of that one lock: same file, same `fcntl.flock`, no second lock protocol.
#
# It execs the command once the lock is held (flock(1)'s own semantics), so the command is the
# lock holder: no extra process, no extra process group, and the effective exit status is the
# command's. The lock is released when the last process holding the descriptor is gone --
# including a native run killed by its own deadline. See tools/native_lock.py for the details.
#
#   retinadump.sh          re-execs itself under this helper around the native run
#   tools/record_oracle.py takes the same lock through tools/parity_common.py
#
# Exit status: the command's, or 1 (lock timed out, nothing ran) / 2 (usage, no native tree)
# / 130 (interrupted while waiting).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$here/native_lock.py" "$@"
