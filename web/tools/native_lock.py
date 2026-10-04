#!/usr/bin/env python3
"""`tools/native_lock.sh`'s engine -- flock(1) for the machines that do not have it.

PORT-NOTE(native-lock/why): `Polyworld` always writes `<native>/run`, so every native writer
must serialise on one file. The Python harness does that with
`tools/parity_common.py:native_lock` -- an `fcntl.flock` on `<native>/.parity-native.lock`,
with a bounded wait, writing the holder's pid + timestamp into the lock file -- and every
recording goes through it (`tools/record_oracle.py`). The *shell* probes did it with
`flock 9`, guarded by `if command -v flock`; macOS ships no `flock(1)`, so on this box the
guard skipped the lock entirely (`command -v flock` is empty, macOS 26.5.2) and two probes
could displace and interleave each other's `run/` tree. This helper is the shell half of
that ONE lock: same file, same mechanism, no second lock protocol.

PORT-NOTE(native-lock/exec): once the lock is taken the helper `exec`s the command instead of
supervising it, exactly as `flock(1)` does. The command therefore *is* the lock holder: the
pid written into the lock file is the pid doing the work, the command's exit status is the
helper's exit status, and no extra process or process group is added to the probe (which
matters -- `retinadump.sh` kills the native run's process group on its deadline and must not
have to tear down a supervisor as well). The lock is released when the last process holding
the descriptor is gone, so a run killed by its own deadline releases it too.

PORT-NOTE(native-lock/fd): the descriptor is moved to fd 9 and left inheritable across the
`exec` (9 is the fd the shell probes used to take this lock on: `exec 9>"$lock"`). Anything
the command forks with its descriptors intact -- a native run that survives its probe --
therefore keeps the tree locked, which is the truth: it is still writing `run/`.

Usage
    tools/native_lock.sh [--lock PATH] [--native DIR] [--wait SEC] [--purpose TEXT] -- <cmd> [args...]

`--lock` defaults to `<native>/.parity-native.lock`, with `<native>` resolved exactly as the
harness resolves it ($POLYWORLD_NATIVE > parity.config.json `native_dir` > `<repo>/../polyworld`).
`--wait SEC` bounds the wait (default 1800 s, `parity_common.DEFAULT_TIMEOUT_SEC`); 0 means
"try once and fail if it is held". `--purpose TEXT` is recorded in the lock file next to the
holder's pid (default: the command line).

Exit status
    0.. the command's own status
    1   timed out waiting for the lock -- the command never ran
    2   usage error, or the native tree / lock path could not be resolved
    130 interrupted while waiting for the lock
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_common as pc  # noqa: E402

#: The fd the lock lives on across the exec; see PORT-NOTE(native-lock/fd).
LOCK_FD = 9
#: Poll interval while waiting; `parity_common.native_lock` polls at the same rate.
POLL_SEC = 0.5

USAGE = "usage: tools/native_lock.sh [--lock PATH] [--native DIR] [--wait SEC] [--purpose TEXT] -- <cmd> [args...]"


def split_command(argv):
    """(options, command) at the first `--`, or (None, None) when there is none."""
    try:
        cut = argv.index("--")
    except ValueError:
        return None, None
    return list(argv[:cut]), list(argv[cut + 1:])


def build_parser():
    parser = argparse.ArgumentParser(
        prog="native_lock.sh", description="hold the native-run lock (fcntl.flock) across a command",
        epilog=USAGE, add_help=True)
    parser.add_argument("--lock", help="lock file (default: <native>/.parity-native.lock)")
    parser.add_argument("--native", help="native Polyworld tree the lock belongs to")
    parser.add_argument("--wait", type=int, default=pc.DEFAULT_TIMEOUT_SEC,
                        help="seconds to wait for the lock (default: %(default)s; 0 = do not wait)")
    parser.add_argument("--purpose", default="", help="what is about to run (recorded in the lock file)")
    return parser


def resolve_lock(explicit, native_arg):
    """The lock file to take: `--lock`, else `<native>/.parity-native.lock`."""
    if explicit:
        return Path(explicit).expanduser()
    native = pc.resolve_native(native_arg, required=False)
    if native is None:
        raise pc.ParityError(
            "no native Polyworld tree found to lock (pass --lock <file> or --native <dir>, "
            "or set $POLYWORLD_NATIVE / tools/parity.config.json's native_dir)")
    return Path(native) / pc.NATIVE_LOCK_NAME


def _holder(lock_path):
    try:
        return Path(lock_path).read_text().strip() or "unknown"
    except OSError:
        return "unknown"


def acquire(lock_path, wait, purpose, command):
    """Take `lock_path` (blocking up to `wait` s) and hand it to `command` via exec.

    Never returns on success: the process image is replaced by the command, which inherits
    the lock on fd 9. Returns an exit status when the lock could not be taken.
    """
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
    except OSError as exc:
        sys.stderr.write("native_lock: cannot open the lock file %s (%s)\n" % (lock_path, exc))
        return 2

    started = time.time()
    waited = False
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
                sys.stderr.write("native_lock: cannot lock %s (%s)\n" % (lock_path, exc))
                os.close(fd)
                return 2
            if not waited:
                # The same wording tools/parity_common.py:native_lock prints, so one grep
                # over a lane's log finds every waiter whatever language it is written in.
                sys.stderr.write("parity: waiting for the native-run lock %s%s\n"
                                 % (lock_path, (" -- " + purpose) if purpose else ""))
                sys.stderr.flush()
                waited = True
            if wait <= 0 or (time.time() - started) > wait:
                sys.stderr.write(
                    "parity: error: timed out after %ss waiting for %s (holder: %s); "
                    "the command was not run\n" % (wait, lock_path, _holder(lock_path)))
                os.close(fd)
                return 1
            time.sleep(POLL_SEC)

    waited_sec = time.time() - started
    # The holder's pid + timestamp + purpose, exactly the three fields native_lock writes.
    os.ftruncate(fd, 0)
    os.write(fd, ("%d %s %s\n" % (os.getpid(), time.strftime("%Y-%m-%dT%H:%M:%S"), purpose)).encode())
    if fd != LOCK_FD:
        os.dup2(fd, LOCK_FD)  # inheritable across the exec: this fd *is* the lock's lifetime
        os.close(fd)
    os.set_inheritable(LOCK_FD, True)
    if waited:
        sys.stderr.write("parity: acquired the native-run lock %s after %.1fs\n" % (lock_path, waited_sec))
        sys.stderr.flush()

    try:
        os.execvp(command[0], command)
    except OSError as exc:
        sys.stderr.write("native_lock: cannot run %r (%s)\n" % (command[0], exc))
        return 2
    return 0  # not reached: execvp only returns on failure


def main(argv):
    options, command = split_command(argv)
    if options is None:
        sys.stderr.write("native_lock: missing `--` before the command\n%s\n" % USAGE)
        return 2
    args = build_parser().parse_args(options)
    if not command:
        sys.stderr.write("native_lock: no command after `--`\n%s\n" % USAGE)
        return 2
    if args.wait < 0:
        sys.stderr.write("native_lock: --wait takes a whole number of seconds (got %d)\n" % args.wait)
        return 2
    purpose = " ".join((args.purpose or " ".join(command)).split())
    try:
        lock_path = resolve_lock(args.lock, args.native)
    except pc.ParityError as exc:
        sys.stderr.write("native_lock: %s\n" % exc)
        return 2
    try:
        return acquire(lock_path, args.wait, purpose, command)
    except KeyboardInterrupt:
        sys.stderr.write("\nnative_lock: interrupted while waiting for %s; nothing was run\n" % lock_path)
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
