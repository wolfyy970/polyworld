# Gzipped run artifacts: what the `.gz` goldens are, and what is frozen

Task `t_091ec5b8` (2026-09-28). Every measurement below was run on this machine in
that task's workspace; the scripts are quoted so anyone can re-run them.

**Status: the amendment this task landed was reverted the next day (2026-09-29,
task `t_9c9fa3de`).** `tools/scenarios.d/content-compare.json` ships an **empty**
`content_compare` rule list, so no path is content-compared and every `.gz`
under `run/` is compared by its **container** bytes again, like every other
manifested file — which is what the shipped port writes
(`src/model/compress/zlibDeflate.ts`, `t_431ed2f0`, landed 2026-09-28). Nothing
below is retracted: the 1317 upstream-zlib containers, the motley/Chrome counts
(engine counts, not counts of "node" — see the table) and the "the payload is
the model's output, the container is the compression
library's fingerprint" reading are all still this document's point. What is
undone is only the *contract* they argued for, because the durable fix they named
has landed. §*The decision* and §*Reproduce* read in that past tense.

## The measurement

`tools/check_parity.py` hashes every manifested file. For a `.gz` artifact that
means the **container** (10-byte gzip header, deflate stream, 8-byte trailer) had
to be byte-identical. It is not, for most files:

| implementation | how | `.gz` containers reproduced: `microtest_voff` / `minitest_voff` |
|---|---|---|
| apple `libz` 1.2.12 (macOS system zlib; what the native binary links, and what `python3`'s `zlib` is) | `zlib.compressobj(6, DEFLATED, -15)`, single shot | **150 / 150** and **1167 / 1167** |
| vanilla zlib **1.2.12**, built from source | `deflateInit2(6, DEFLATED, -15, 8, Z_DEFAULT_STRATEGY)` + `Z_FINISH` | **150 / 150** and **1167 / 1167** |
| vanilla zlib **1.3.1**, built from source | same | **150 / 150** and **1167 / 1167** |
| node 22.22.2 (`process.versions.zlib` = `1.3.1-e00f703`, Google's "motley" fork) | `zlib.deflateRawSync(payload, {level: 6, memLevel: 8})` | 25 / 150 and 25 / 1167 |
| node v24.16.0 (`process.versions.zlib` = `1.2.12`, **upstream**) — the `/opt/homebrew/opt/node@24/bin/node` build | `zlib.gzipSync( zlib.gunzipSync(golden), { level: 6 } )` compared to the golden bytes | **150 / 150** and **1167 / 1167** |
| Chrome 153 | `CompressionStream('deflate-raw')` and `('gzip')`, both measured | 26 / 190 (150 microtest + 40 minitest) |
| fflate 0.8.3 (already in `node_modules`, transitively) | `deflateSync(payload, {level, mem: 8})`, levels 0–9 | 0 / 150 |

That is the whole frozen `.gz` surface: **1317 of 1317 containers reproduced byte-for-byte by
upstream zlib**, 25 of them by the zlib the node builds measured here are linked against. (Transcript:
`deflate-comparison.txt`, attached to the task.) The two node rows are the same
`node:zlib`, i.e. the same call with the same arguments: what differs between them is **the zlib
the binary is linked against**, not node — node's `deps/zlib` is a build-time choice, so a node
linked against upstream 1.2.12 (the `/opt/homebrew/opt/node@24` build above, 2026-09-29,
t_16ac7810/t_ceaf2128) reproduces every container the motley builds cannot, and the 25/150 figure
is a fact about that engine, not about "node". Two things this corrects from the original
card:

1. **It is not a zlib version boundary.** Upstream zlib 1.3.1 reproduces every golden
   container exactly; upstream 1.2.12 and 1.3.1 agree byte-for-byte on this content. A lane
   that "downgrades zlib" or pins a version is chasing a phantom.
2. **It is not `CompressionStream` being "unversioned" either** — measured: the
   browser fails on 164 of 190 files at level 6, with the same signature as node
   (smaller streams, first difference 2 bytes into the deflate stream).

The real cause is that **the zlib these runtimes are built against is Google's patched fork of
zlib**: node's `deps/zlib` and Chromium both carry the "motley" line (`1.3.2.1-motley-…`),
whose deflate chooses different matches and therefore emits a different — and
slightly smaller — stream for identical content. The goldens were written by
*upstream* zlib. The container bytes are a fingerprint of the compression
library, not of the model — and for node, "the compression library" is decided
when the binary is built, not by node: the same `gzipSync` call on a node linked
against upstream 1.2.12 reproduces **all 150** golden containers (the
`/opt/homebrew/opt/node@24` row above).

The gzip header (`1f 8b 08 00 00000000 00 13`) and the trailer are identical
everywhere; only the deflate stream differs. Chrome writes exactly that header
too, so the wrapper was never the problem.

## The decision

* **Then (2026-09-28 – 2026-09-29): content was the contract for gzipped
  artifacts — reverted.** The registry declared a `content_compare` rule
  (`tools/scenarios.d/content-compare.json`: every `.gz` under `run/`), and
  `tools/check_parity.py` compared those files by their **decompressed payload**,
  counting and printing every one of them. The goldens were never touched and no
  artifact was ignored. **Shipped state now (reverted 2026-09-29, task
  `t_9c9fa3de`):** that rule list is **empty**, so no path is content-compared and
  every `.gz` under `run/` is byte-compared by its **container**, exactly like
  every other manifested file — which is what the port writes (next bullet). The
  mechanism is left intact for a future case (a scenario opts in with its own
  `content_compare` globs, `--content-compare <glob>` re-selects a path for a
  single check, `--no-content-compare` forces strict bytes); nothing ships using
  it. `PORT_SPEC.md` → *Frozen surface* carries the amendment and its revert.
* **Durable: a version-pinned JS deflate — landed, and it is the shipped
  answer.** Transcribing upstream zlib's `deflate_slow` + `trees.c` (level 6,
  memLevel 8, windowBits −15, single shot, `Z_FINISH`) into dependency-free TS is
  the only way to keep byte-exact containers *and* work in the browser. The target
  algorithm was unambiguous — upstream 1.2.12 and 1.3.1 agree, so there was
  nothing to guess about versions — and the 1317 recorded `.gz` containers are a
  complete byte-oracle. Filed as lane card `t_431ed2f0`, which landed 2026-09-28:
  `src/model/compress/zlibDeflate.ts` is that transcription, the node gzip sinks
  write through it, and `tests/gzip-deflate.test.ts` rebuilds **2581/2581**
  recorded `.gz` containers byte-for-byte across all five scenarios. That is why
  the amendment above could be reverted — and was, with the single registry file
  it promised.
* **Rejected: writing the containers with a sidecar zlib implementation.**
  It unblocks a node-side run tree but not the browser page export that L20's
  acceptance names, and `src/model/logs/nodeFiles.ts` / `src/model/datalib/nodeFile.ts`
  are the sinks a lane would have to keep in sync.

## Reproduce

```
# 1. what the goldens are (apple libz 1.2.12 reproduces them exactly)
python3 -c "
import gzip, zlib
p='oracle/microtest_voff/run/brain/anatomy/brainAnatomy_10_birth.txt.gz'
g=open(p,'rb').read(); raw=gzip.decompress(g)
co=zlib.compressobj(6, zlib.DEFLATED, -15)
print(zlib.ZLIB_RUNTIME_VERSION, g[10:-8]==co.compress(raw)+co.flush())"
# -> 1.2.12 True

# 2. this machine's `node` (a build linked against Google's "motley" zlib) cannot
#    (raw deflate at level 6, the call the node sinks make)
node -e "
const {readFileSync}=require('node:fs'); const z=require('node:zlib');
const p='oracle/microtest_voff/run/brain/anatomy/brainAnatomy_10_birth.txt.gz';
const g=readFileSync(p); const raw=z.gunzipSync(g);
const out=z.deflateRawSync(raw,{level:6,memLevel:8});
console.log(process.versions.zlib, out.length, 'vs golden', g.length-18);"
# -> 1.3.1-e00f703 422 vs golden 426

# 2b. a node linked against upstream zlib 1.2.12 can -- over the whole golden set,
#     the same call the node log sinks make. `process.versions.zlib` decides, not
#     the node version: 25/150 on the motley builds, 150/150 here (2026-09-29).
/opt/homebrew/opt/node@24/bin/node -e "
const {readdirSync,readFileSync}=require('node:fs');
const {gunzipSync,gzipSync}=require('node:zlib');
function walk(d,o=[]){for(const e of readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;
  e.isDirectory()?walk(p,o):e.name.endsWith('.gz')&&o.push(p);}return o;}
const f=walk('oracle/microtest_voff/run');
const n=f.filter(p=>{const g=readFileSync(p);return gzipSync(gunzipSync(g),{level:6}).equals(g);}).length;
console.log(process.versions.zlib, n+'/'+f.length);"
# -> 1.2.12 150/150      (node v22.22.2 / zlib 1.3.1-e00f703 -> 25/150)

# 3. vanilla zlib from source does (the lane's reference build)
curl -sO https://github.com/madler/zlib/archive/refs/tags/v1.2.12.tar.gz   # and v1.3.1
#   build with -DZ_SOLO (no stdio needed for deflate-only) and supply
#   strm->zalloc/strm->zfree yourself -- with Z_SOLO, deflateInit2_ returns
#   Z_STREAM_ERROR (-2) unless the caller provides them:
clang -O2 -DZ_SOLO -Wno-deprecated-non-prototype -c deflate.c trees.c zutil.c adler32.c crc32.c
#   then deflateInit2(&s, 6, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) + Z_FINISH
#   -> byte-identical to all 150 golden deflate streams

# 4. the harness' verdict on a candidate whose containers node wrote (the
#    t_091ec5b8 measurement). The `content-compared` line only prints when a
#    content_compare rule is selected, so it has to be asked for explicitly:
#    the shipped rule list is empty (t_9c9fa3de, 2026-09-29) and a default run
#    prints no `content-compared` line at all (4b). The `container byte-identical
#    25, container differs 125` split below is a property of the *candidate*: it
#    was written by a node whose linked zlib is Google's "motley" fork (v22.22.2 /
#    v24.21.0 here). A candidate written by a node linked against upstream zlib
#    1.2.12 -- which reproduces the golden containers (2b) -- gives `container
#    byte-identical 150, container differs 0`: nothing for the rule to rescue,
#    which is why it is not shipped.
python3 tools/check_parity.py --scenario microtest_voff --candidate <tree> \
    --content-compare 'run/**/*.gz'
#   content-compared 150 file(s) [run/**/*.gz]: payload identical 150
#     (container byte-identical 25, container differs 125), payload differs 0, unreadable 0
#   parity: PASS  (225/225 files)

# 4b. the same tree, no flags: what ships. Container bytes are the contract
#     again, so the 125 node-written containers are ordinary byte differences
#     and nothing is content-compared. On the upstream-1.2.12 engine the
#     candidate is byte-identical to the golden here and this is `parity: PASS`.
python3 tools/check_parity.py --scenario microtest_voff --candidate <tree>
#   match 100/225  differing=125  missing=0  extra=0  ignored=0
#   parity: FAIL  (100/225 files)
```

Evidence runs (both scenarios, six cases each: clean copy, node-written
containers, the same tree under `--no-content-compare`, a flipped payload byte, a
non-gzip file at a content-compared path, a missing `.gz`) are attached to task
`t_091ec5b8` in `harness_content_compare_evidence.json`, and encoded in the
`oracle/run_parity.sh -- content-compared gzip containers` block of
`tests/parity-runner.test.ts` — in that block the rule is selected explicitly
(`--content-compare 'run/**/*.gz'`) wherever the mechanism is exercised, and one
test pins the strict default that ships since `t_9c9fa3de`.
