"""Lane W1j/L16 — dump the *native* retina rows from a recorded oracle run.

Why this exists
---------------
`docs/specs/vision-spec.md` §11.4 defines this lane's acceptance surface as the
`3 x numneurons` nerve doubles the retina feeds the brain, but the recorded goldens only
contain them **after** `%g` (6 significant digits). To check the port against real pixels
instead of against rows reconstructed from the spec, this script drives the *native* build
under lldb and dumps, for every agent and step:

  * `Retina::updateBuffer(x, y, w, h)` — the atlas slot the renderer picked (validating the
    packing maths in `atlas.ts` against the real `QtAgentPovRenderer`), and
  * `Retina::sensor_update(bool)` — the 88 readback bytes (`Retina.cc:116-122`) that the
    encoder consumes, plus the per-channel neuron counts (`Retina::Channel::numneurons`).

The native source is **read-only**: nothing here is compiled into the native tree, no header
is patched, and the only thing that is written is the native run's own `run/` output (which
`tools/record_oracle.py` also produces; `oracle/**` is untouched). Because `PrintBrain` is a
compile-time `false` (`brain/Brain.h:20`), the retina buffer cannot be printed by the model
itself — the debugger reads it out of the `Retina` object.

`Retina`'s layout is not available as debug info, so it is mirrored here and **validated at
run time** (the three channel `name` pointers must read "Red"/"Green"/"Blue" and `width`
must match the retina width); a mismatch aborts the run rather than dumping garbage.

Usage (from the web repo):

    python3 src/model/vision/native/dump_retina.py \
        --native polyworld \
        --worldfile worldfiles/tests/low-spec-pc/minitest.wf \
        --out ~/.hermes/.../minitest_von.retina.jsonl

or, if a dump already exists, `--to-ts <file.ts>` to regenerate the TypeScript golden module
`src/model/vision/golden/nativeRetinaRows.ts` (a small, deterministic subset).

The native-run lock
-------------------
`Polyworld` always writes `<native>/run`, so this script is one of the writers that must serialise
on the harness's one lock file, `<native>/.parity-native.lock` (`tools/parity_common.py:native_lock`
-- the same file and the same `fcntl.flock` `tools/record_oracle.py` holds for a whole recording).
It takes that lock the way `retinadump.sh` does: it re-execs itself under `tools/native_lock.sh`,
which waits with a **bound** (`--lock-wait`, default 1800 s), prints the harness's
`parity: waiting for the native-run lock ...` line while it waits, names the holder when the bound
is exhausted (exit 1, lldb never launched) and then execs this script so this process *is* the lock
holder. Nothing was displaced and no lldb run was bounded by `--timeout` until the lock was taken.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))

# --- the native-run lock (see the module docstring) -----------------------------------------
# One lock file for every native writer: `<native>/.parity-native.lock`, the harness's
# `tools/parity_common.py:NATIVE_LOCK_NAME`, taken with `fcntl.flock` -- by that module's
# `native_lock`, by `tools/record_oracle.py` for a whole recording, and by `tools/native_lock.sh`
# (which `retinadump.sh` and this script re-exec themselves under). No second lock, no second
# mechanism: PORT-NOTE(parity-runner/native-lock).
NATIVE_LOCK_NAME = '.parity-native.lock'
NATIVE_LOCK_HELPER = os.path.join(WEB_ROOT, 'tools', 'native_lock.sh')
#: Set on the pass that already holds the lock (the re-exec in `reexec_under_lock`).
LOCKED_ENV = 'VISION_DUMP_LOCKED'
#: Default bound on the *wait* for the lock, in seconds (`native_lock.sh --wait`; 0 = do not wait).
#: `--timeout` keeps its own meaning: the lldb run, taken *after* the lock.
DEFAULT_LOCK_WAIT_SEC = 1800

# --- the mirrored `Retina` / `Retina::Channel` layout --------------------------------------
# class Retina : public Sensor {          // Sensor has no data members
#     unsigned char *buf;                 // vptr(8) + int width(4) + 4 pad + buf(8)
#     int width;
#     Channel channels[3];
# };
RETINA_BUF_OFFSET = 16
RETINA_WIDTH_OFFSET = 8
RETINA_CHANNELS_OFFSET = 24
CHANNEL_SIZE = 48
CHANNEL_NAME_OFFSET = 0
CHANNEL_BUF_OFFSET = 8
CHANNEL_NERVE_OFFSET = 16
CHANNEL_XWIDTH_OFFSET = 24
CHANNEL_INDEX_OFFSET = 28
CHANNEL_XINTWIDTH_OFFSET = 32
CHANNEL_NUMNEURONS_OFFSET = 40
CHANNEL_NAMES = ('Red', 'Green', 'Blue')

LLDB_SCRIPT = r'''
import json, lldb, os

class Dumper:
    def __init__(self, out_path):
        self.out = open(out_path, 'w')
        self.fresh = {}          # retina ptr -> (x, y, w, h)
        self.rows = 0
        self.steps = 0
        self.errors = []
        self.validated = False

    # --- helpers ---------------------------------------------------------------------
    def _u64(self, frame, reg):
        return frame.FindRegister(reg).GetValueAsUnsigned()

    def _i32(self, process, addr):
        err = lldb.SBError()
        return process.ReadUnsignedFromMemory(addr, 4, err)

    def _ptr(self, process, addr):
        err = lldb.SBError()
        return process.ReadPointerFromMemory(addr, err)

    # --- breakpoints -----------------------------------------------------------------
    def on_step(self, frame, bp_loc, internal):
        self.steps += 1
        return False

    def on_update_buffer(self, frame, bp_loc, internal):
        this = self._u64(frame, 'x0')
        x = self._u64(frame, 'x1') & 0xffff
        y = self._u64(frame, 'x2') & 0xffff
        w = self._u64(frame, 'x3') & 0xffff
        h = self._u64(frame, 'x4') & 0xffff
        self.fresh[this] = (x, y, w, h)
        return False

    def on_sensor_update(self, frame, bp_loc, internal):
        this = self._u64(frame, 'x0')
        info = self.fresh.pop(this, None)
        if info is None:
            return False          # prebirth noise, or an update with no fresh render
        process = frame.GetThread().GetProcess()
        err = lldb.SBError()
        width = self._i32(process, this + 8)
        buf_ptr = self._ptr(process, this + 16)
        row = process.ReadMemory(buf_ptr, width * 4, err)
        counts = []
        names = []
        for c in range(3):
            base = this + 24 + c * 48
            name_ptr = self._ptr(process, base + 0)
            name = process.ReadCStringFromMemory(name_ptr, 16, err)
            names.append(name)
            counts.append(self._i32(process, base + 40))
        if not self.validated:
            if tuple(names) != ('Red', 'Green', 'Blue') or width != 22:
                self.errors.append('layout check failed: names=%r width=%r' % (names, width))
                return True       # stop
            self.validated = True
        self.rows += 1
        self.out.write(json.dumps({
            'step': self.steps,
            'x': info[0], 'y': info[1], 'w': info[2], 'h': info[3],
            'width': width,
            'neurons': counts,
            'row': row.hex(),
        }) + '\n')
        return False

DUMPER = None

def on_step(frame, bp_loc, internal_dict):
    return DUMPER.on_step(frame, bp_loc, internal_dict)

def on_update_buffer(frame, bp_loc, internal_dict):
    return DUMPER.on_update_buffer(frame, bp_loc, internal_dict)

def on_sensor_update(frame, bp_loc, internal_dict):
    return DUMPER.on_sensor_update(frame, bp_loc, internal_dict)

def __lldb_init__(module, internal_dict):
    global DUMPER
    out_path = os.environ['VISION_DUMP_OUT']
    DUMPER = Dumper(out_path)
    target = lldb.debugger.GetSelectedTarget()
    handlers = (('TSimulation::Step()', 'on_step'),
                ('Retina::updateBuffer(short, short, short, short)', 'on_update_buffer'),
                ('Retina::sensor_update(bool)', 'on_sensor_update'))
    for name, handler in handlers:
        bp = target.BreakpointCreateByName(name)
        locations = bp.GetNumLocations()
        if locations == 0:
            bp = target.BreakpointCreateByName(name, None, lldb.eFunctionNameTypeAny)
            locations = bp.GetNumLocations()
        error = bp.SetScriptCallbackFunction('__MODULE__.' + handler)
        print('VISION-DUMP: %s -> %d location(s), callback error=%s' % (name, locations, error))
    print('VISION-DUMP: breakpoints set')
'''


def parse_args(argv):
    parser = argparse.ArgumentParser(description='dump native retina rows from an oracle run')
    parser.add_argument('--native', default=os.environ.get('POLYWORLD_NATIVE', os.path.join(WEB_ROOT, '..', 'polyworld')))
    parser.add_argument('--worldfile', default='worldfiles/tests/low-spec-pc/minitest.wf')
    parser.add_argument('--out', default=os.path.join(os.environ.get('TMPDIR', '/tmp'), 'retina-rows.jsonl'))
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--lock-wait', type=int, default=DEFAULT_LOCK_WAIT_SEC,
                        help='seconds to wait for the native-run lock before giving up; the wait is '
                             'bounded so a wedged native writer cannot wedge this script '
                             '(default: %(default)s; 0 = do not wait)')
    parser.add_argument('--keep-run', action='store_true', help='do not displace the native run/ tree')
    parser.add_argument('--to-ts', help='generate the golden TS module from an existing --out dump')
    parser.add_argument('--to-golden', help='gzip an existing --out dump into <dir>/<scenario>.retina.jsonl.gz')
    parser.add_argument('--scenario', default='minitest_von', help='scenario name (for --to-golden)')
    parser.add_argument('--max-steps', type=int, default=0, help='only keep rows from the first N steps (0 = all)')
    return parser.parse_args(argv)


def displace_run(native):
    run = os.path.join(native, 'run')
    if os.path.isdir(run):
        moved = '%s.previous.%d' % (run, int(time.time()))
        shutil.move(run, moved)
        print('dump_retina: displaced native run/ -> %s' % os.path.basename(moved))


def reexec_under_lock(args, native):
    """Take the native-run lock by re-execing this script under `tools/native_lock.sh`.

    Never returns when the lock was taken: the process image is replaced by the helper holding the
    lock, which execs this script again with `VISION_DUMP_LOCKED=1` (the pass that does the work).
    When the lock could not be taken it returns the helper's status:
      1  waited `--lock-wait` seconds with the holder never letting go -- nothing was displaced and
         lldb was never launched
      2  the helper is missing, or the lock file could not be opened
    """
    lock_path = os.path.join(native, NATIVE_LOCK_NAME)
    if not os.path.isfile(NATIVE_LOCK_HELPER):
        print('dump_retina: %s is missing; refusing to run without the native-run lock'
              % NATIVE_LOCK_HELPER, file=sys.stderr)
        return 2
    argv = [NATIVE_LOCK_HELPER,
            '--lock', lock_path,
            '--wait', str(args.lock_wait),
            '--purpose', 'dump_retina %s' % os.path.basename(args.worldfile),
            '--', sys.executable or 'python3', os.path.abspath(__file__)]
    argv += sys.argv[1:]
    env = dict(os.environ)
    env[LOCKED_ENV] = '1'
    try:
        os.execve(NATIVE_LOCK_HELPER, argv, env)
    except OSError as exc:
        print('dump_retina: cannot run %s (%s)' % (NATIVE_LOCK_HELPER, exc), file=sys.stderr)
        return 2
    return 2  # not reached: os.execve only returns when it failed


def run_lldb(args):
    native = os.path.abspath(args.native)
    binary = os.path.join(native, 'Polyworld')
    if not os.path.isfile(binary):
        print('dump_retina: no native build at %s (set --native)' % binary, file=sys.stderr)
        return 2

    # Serialise with the oracle harness: every native writer holds `<native>/.parity-native.lock`,
    # because the native binary always writes to `<native>/run`.
    #
    # This used to be a blocking `fcntl.flock(LOCK_EX)` on that file -- the right file and the right
    # mechanism, but no bound and no message, so a wedged native writer (a `Polyworld` that never
    # finishes a step and outlives its probe: the W1j shape) made this script wait *forever* before
    # it printed anything. `--timeout` did not help: it bounds the lldb `subprocess.run` below,
    # which had not started. The lock is now taken exactly as `retinadump.sh` takes it, by re-execing
    # this script under `tools/native_lock.sh`: same file, same `fcntl.flock`, but a bounded wait
    # (`--lock-wait`), the harness's waiting line while it waits, the holder named on timeout, and
    # the command exec'd so this process *is* the lock holder -- nothing extra to tear down, and the
    # lock is released whenever this process ends (exit, killed by `--timeout`, SIGINT/SIGTERM).
    # `displace_run()` and the lldb run both stay inside the locked region; `--timeout` still bounds
    # only the lldb run.
    if os.environ.get(LOCKED_ENV) != '1':
        return reexec_under_lock(args, native)
    lock_path = os.path.join(native, NATIVE_LOCK_NAME)
    print('dump_retina: holding the native-run lock %s' % lock_path, file=sys.stderr)

    if not args.keep_run:
        displace_run(native)

    script_path = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'vision_dump_%d.py' % os.getpid())
    module_name = os.path.basename(script_path)[:-3]  # `command script import` names the module after the file
    with open(script_path, 'w') as handle:
        handle.write(LLDB_SCRIPT.replace('__MODULE__', module_name))

    env = dict(os.environ)
    env['VISION_DUMP_OUT'] = os.path.abspath(args.out)
    env['PYTHONPATH'] = os.path.join(os.environ.get('TMPDIR', '/tmp')) + os.pathsep + env.get('PYTHONPATH', '')

    commands = [
        'command script import %s' % script_path,
        'run --ui term %s' % args.worldfile,
        'quit',
    ]
    argv = ['lldb', '--batch']
    for command in commands:
        argv += ['-o', command]
    argv.append(binary)
    print('dump_retina: %s' % ' '.join(argv))
    started = time.time()
    proc = subprocess.run(argv, cwd=native, env=env, capture_output=True, timeout=args.timeout)
    wall = time.time() - started
    stdout = proc.stdout.decode('utf-8', 'replace')
    stderr = proc.stderr.decode('utf-8', 'replace')
    with open(os.path.abspath(args.out) + '.log', 'w') as handle:
        handle.write(stdout + '\n=== stderr ===\n' + stderr)
    print('dump_retina: lldb exited %d after %.1fs' % (proc.returncode, wall))
    if 'layout check failed' in stdout + stderr:
        print('dump_retina: RETINA LAYOUT CHECK FAILED -- see the log', file=sys.stderr)
        return 3
    if 'breakpoints set' not in stdout + stderr:
        print('dump_retina: the lldb script did not initialise; see %s.log' % args.out, file=sys.stderr)
        return 4
    with open(os.path.abspath(args.out)) as handle:
        rows = sum(1 for line in handle if line.strip())
    print('dump_retina: %d retina rows -> %s' % (rows, args.out))
    return 0 if rows else 5


def to_ts(args):
    """Fold a dump into a compact TypeScript golden: first row of each (step, slot) plus a
    mixed-row sample, enough to replay the encoder against real native pixels."""
    with open(args.out) as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if args.max_steps:
        rows = [row for row in rows if row['step'] <= args.max_steps]
    steps = sorted({row['step'] for row in rows})
    slots = sorted({(row['x'], row['y']) for row in rows})
    sample = rows[:120]
    body = []
    body.append('/**')
    body.append(' * Lane W1j/L16 — native retina rows dumped from the recorded oracle run.')
    body.append(' *')
    body.append(' * Generated by `src/model/vision/native/dump_retina.py`, which drives the')
    body.append(' * *native* build under lldb and reads `Retina::buf` right after')
    body.append(' * `glReadPixels` filled it (`Retina.cc:116-122`). This is the only source of')
    body.append(' * real retina pixels: the goldens keep the encoded nerve values, and `PrintBrain`')
    body.append(' * is a compile-time `false` (`brain/Brain.h:20`).')
    body.append(' *')
    body.append(' * Read-only input for `tests/vision-encoder.test.ts` / `tests/vision-atlas.test.ts`.')
    body.append(' */')
    body.append('')
    body.append('export interface NativeRetinaRow {')
    body.append('  /** 1-based native step (from TSimulation::Step). */')
    body.append('  readonly step: number;')
    body.append('  /** Atlas slot viewport, as `QtAgentPovRenderer` assigned it (`Retina::updateBuffer` args). */')
    body.append('  readonly x: number;')
    body.append('  readonly y: number;')
    body.append('  /** Per-channel neuron counts (`Retina::Channel::numneurons`). */')
    body.append('  readonly neurons: readonly [number, number, number];')
    body.append('  /** The 88 readback bytes, RGBA (`width * 4`). */')
    body.append('  readonly row: readonly number[];')
    body.append('}')
    body.append('')
    body.append('/** Distinct atlas slots observed across the run (`w = h = 22`). */')
    body.append('export const NATIVE_RETINA_SLOTS: readonly { x: number; y: number }[] = [')
    for x, y in slots:
        body.append('  { x: %d, y: %d },' % (x, y))
    body.append('];')
    body.append('')
    body.append('/** Steps observed in the dump. */')
    body.append('export const NATIVE_RETINA_STEPS: readonly number[] = %s;' % json.dumps(steps))
    body.append('')
    body.append('/** A deterministic sample of real retina rows (first %d of the run). */' % len(sample))
    body.append('export const NATIVE_RETINA_ROWS: readonly NativeRetinaRow[] = [')
    for row in sample:
        row_bytes = list(bytes.fromhex(row['row']))
        neurons = row['neurons']
        body.append('  {')
        body.append('    step: %d, x: %d, y: %d,' % (row['step'], row['x'], row['y']))
        body.append('    neurons: [%d, %d, %d],' % tuple(neurons))
        body.append('    row: [%s],' % ', '.join(str(b) for b in row_bytes))
        body.append('  },')
    body.append('];')
    body.append('')
    dest = args.to_ts
    with open(dest, 'w') as handle:
        handle.write('\n'.join(body))
    print('dump_retina: wrote %s (%d rows, %d steps, %d slots)' % (dest, len(sample), len(steps), len(slots)))
    return 0


def to_golden(args):
    """Gzip a dump into the lane's golden directory, with a machine-readable provenance header.

    The dump is the lane's native *pixel* golden: 25 agents x ~292 steps x 88 bytes in
    `minitest_von`, which is what lets `tests/vision-native-rows.test.ts` hold the port's
    encoder to the recorded nerve values on real retina bytes instead of on rows reconstructed
    from the spec.
    """
    import gzip as gzip_module

    source = args.out
    dest_dir = args.to_golden
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, '%s.retina.jsonl.gz' % args.scenario)
    with open(source) as handle:
        lines = [line for line in handle if line.strip()]
    with open(dest, 'wb') as raw:
        # mtime=0 keeps the golden byte-stable across regenerations
        with gzip_module.GzipFile(fileobj=raw, mode='wb', compresslevel=9, mtime=0) as out:
            for line in lines:
                out.write((line if line.endswith('\n') else line + '\n').encode('utf-8'))
    rows = [json.loads(line) for line in lines]
    steps = sorted({row['step'] for row in rows})
    agents = sorted({row['agent'] for row in rows})
    slots = sorted({(row['x'], row['y']) for row in rows})
    print('dump_retina: wrote %s (%d rows, %d steps %s..%s, %d agents, %d atlas slots)'
          % (dest, len(rows), len(steps), steps[0], steps[-1], len(agents), len(slots)))
    print('dump_retina: %.1f KB gzipped' % (os.path.getsize(dest) / 1024.0))
    return 0


def main(argv):
    args = parse_args(argv)
    if args.to_golden:
        return to_golden(args)
    if args.to_ts:
        return to_ts(args)
    return run_lldb(args)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
