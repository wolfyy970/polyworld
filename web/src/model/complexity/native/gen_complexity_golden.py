#!/usr/bin/env python3
"""Copy the native probe's output into the lane's committed goldens.

`native/run_complexityprobe.sh` writes `brain.txt` and `pieces-*.txt` into a scratch directory;
`tests/complexity.test.ts` reads them from `../golden/`. This script is the one step between the
two, and it rewrites the absolute fixture paths the probe prints (they name the recording
machine's tree) into the repo-relative form the test resolves:

    ./src/model/complexity/native/run_complexityprobe.sh
    python3 src/model/complexity/native/gen_complexity_golden.py

The `oracle/**` tree is read-only for lane agents: the probe only ever reads the fixtures, and
this script only copies the probe's output into the lane's own directory.
"""

import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LANE = os.path.dirname(HERE)
GOLDEN = os.path.join(LANE, 'golden')
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))

PATH_RE = re.compile(r'^file (\S+) (.*)$')


def rewrite(line: str) -> str:
    m = PATH_RE.match(line)
    if not m:
        return line
    path = m.group(1)
    i = path.find('oracle/')
    if i < 0:
        sys.exit(f'golden: probe path {path} is not under oracle/')
    return f'file {path[i:]} {m.group(2)}'


def main() -> None:
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        REPO, 'node_modules', '.cache', 'complexityprobe')
    if not os.path.isdir(outdir):
        sys.exit(f'golden: {outdir} does not exist; run run_complexityprobe.sh first')

    os.makedirs(GOLDEN, exist_ok=True)
    written = []
    for name in sorted(os.listdir(outdir)):
        if not name.endswith('.txt') or name == 'pieces.txt':
            continue
        with open(os.path.join(outdir, name)) as f:
            text = f.read()
        text = '\n'.join(rewrite(line) for line in text.split('\n'))
        dest = os.path.join(GOLDEN, name)
        with open(dest, 'w') as f:
            f.write(text)
        written.append((name, text.count('\n')))

    for name, lines in written:
        print(f'wrote golden/{name} ({lines} lines)')


if __name__ == '__main__':
    main()
