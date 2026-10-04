/**
 * Lane W1e — can the wedge limit land on a differing `atan2f` point?
 *
 *   npx tsx tools/witness_atan2f_wedge.ts [native.txt]
 *
 * The census (`tools/measure_atan2f.ts`) shows the **pre-transcription stand-in** — the deleted
 * `f32(Math.atan2)` + two +-pi values, reconstructed below as `preTranscriptionStandin` so this
 * tool stays the evidence it was — agreeing with the shipped `atan2f` on the whole +-pi family
 * but differing by 1 ulp on ~2 % of the model's own reachable argument pairs (460/20,050).
 * Since `t_4bb10112` `nativeAtan2f` *is* the transcription and no longer differs at all, so this
 * tool keeps measuring the stand-in's residue (that is what it witnesses) and reports at the end
 * that the transcription agrees with the shipped function on every one of those rows.
 *
 * A 1-ulp difference in `ang` can only change a `frustumXZ::Inside` verdict if a wedge limit sits
 * exactly on one of the two adjacent floats, because the comparison is `ang < angmin` /
 * `ang > angmax` on floats that are already rounded.  This tool answers that with witnesses
 * rather than with an argument: for each differing argument pair it searches the model's own
 * wedge domain — `fov ∈ [MinHorizontalFieldOfView, MaxHorizontalFieldOfView] = [20, 140]`,
 * `yaw ∈ [0, 360)` — for a configuration whose `angmin`/`angmax` (computed by the ported
 * `FrustumXZ`, which the `frustumQ.*` goldens pin to `gmisc.cc`'s arithmetic) lands on either of
 * the two values, and then evaluates the native verdict (with the shipped `atan2f`'s angle) and
 * the port's verdict (with the stand-in's) side by side.
 *
 * The apex/position pair is reconstructed so that `Inside` really receives that argument pair:
 * `atan2(x0 - p[0], z0 - p[2])` with apex `(12.5, 12.5)` — the centre of a WorldSize-25 world —
 * and `p = (12.5 - y, 0, 12.5 - x)`, which stays inside the world for the pairs this tool picks
 * (`|y|, |x| <= 12.5`).  Every witness printed is a configuration the model can build, not a
 * synthetic float outside the world.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEGTORAD, f32, f32Bits } from '../src/model/geometry/float';
import { FrustumXZ } from '../src/model/geometry/frustum';
import { atan2f } from '../src/model/rng/libm';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, '..', 'src', 'model', 'geometry', 'native', 'raw');

/**
 * The **pre-transcription** stand-in, verbatim: `f32(Math.atan2)` with the two +-pi values
 * corrected (PORT-NOTE(W1e/atan2f-pi), deleted by `t_4bb10112`).  It is reconstructed here so
 * this tool keeps witnessing what it witnessed; the port itself is now `atan2f`.
 */
function preTranscriptionStandin(y: number, x: number): number {
  const v = f32(Math.atan2(y, x));
  const bits = f32Bits(v);
  if (bits === 0x40490fdb) return 3.1415925025939941;
  if (bits === 0xc0490fdb) return -3.1415925025939941;
  return v;
}

/** The model's wedge domain (`utils/config.h` defaults, `agentConfig.ts:331-332`). */
const MIN_FOV = 20;
const MAX_FOV = 140;
const APEX = 12.5;
const WORLD_HALF = 12.5;

function fromBits(u: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u >>> 0, 0);
  return b.readFloatLE(0);
}

function hex(u: number): string {
  return (u >>> 0).toString(16).padStart(8, '0');
}

/** Ordered float32 distance (0 = identical). */
function ulp(a: number, b: number): number {
  const order = (u: number): number => (u & 0x80000000 ? 0x80000000 - (u & 0x7fffffff) : u);
  return Math.abs(order(f32Bits(a)) - order(f32Bits(b)));
}

/** `v` moved `k` float32 ulps towards +inf (k may be negative). */
function ulpShift(v: number, k: number): number {
  const u = f32Bits(v);
  const stepped = (v >= 0 ? u : 0x80000000 - (u & 0x7fffffff)) + k;
  return fromBits(stepped < 0 ? 0 : stepped >>> 0);
}

/** The native `Inside` body, with the angle supplied instead of computed. */
function verdict(angmin: number, angmax: number, ang: number): 0 | 1 {
  if (angmin < angmax) {
    if (ang < angmin) return 0;
    if (ang > angmax) return 0;
    return 1;
  }
  if (ang > angmin) return 1;
  if (ang < angmax) return 1;
  return 0;
}

interface Row {
  y: number;
  x: number;
  native: number;
  port: number;
}

interface Witness {
  row: Row;
  yaw: number;
  fov: number;
  angmin: number;
  angmax: number;
  limitTouched: string;
  nativeVerdict: 0 | 1;
  portVerdict: 0 | 1;
  position: [number, number, number];
}

function main(): void {
  const nativePath = process.argv[2] ?? join(RAW, 'atan2f_native.txt');
  const rows: Row[] = [];
  let agreedWithTranscription = 0;
  let differingRows = 0;
  for (const line of readFileSync(nativePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('atan2f ')) continue;
    const f = t.split(/\s+/);
    const y = fromBits(parseInt(f[1]!, 16));
    const x = fromBits(parseInt(f[2]!, 16));
    const nat = fromBits(parseInt(f[3]!, 16));
    const port = preTranscriptionStandin(y, x); // the deleted stand-in: f32(Math.atan2) + pi fix
    if ((f32Bits(nat) >>> 0) === (f32Bits(port) >>> 0)) continue;
    differingRows += 1;
    // the transcription that replaced it must agree with the shipped function on this row
    if ((f32Bits(atan2f(y, x)) >>> 0) === (f32Bits(nat) >>> 0)) agreedWithTranscription += 1;
    if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
    if ((f32Bits(nat) & 0x7fffffff) >= 0x40490fda) {
      continue; // the +-pi family: the stand-in's correction already covers it (measured 0/4130)
    }
    if (Math.abs(y) > WORLD_HALF || Math.abs(x) > WORLD_HALF) continue; // keep the witness inside the world
    rows.push({ y, x, native: nat, port });
  }

  const hValues: number[] = [];
  for (let i = 0; i <= 120; i += 1) hValues.push(f32(MIN_FOV / 2 + ((MAX_FOV - MIN_FOV) / 2) * (i / 120)));

  const witnesses: Witness[] = [];
  let searched = 0;
  for (const row of rows) {
    searched += 1;
    const targets: Array<[string, number]> = [['native', row.native], ['port', row.port]];
    let found: Witness | null = null;
    for (const [tag, target] of targets) {
      for (const h of hValues) {
        for (const arm of ['min', 'max'] as const) {
          // the double the native `Set` would form, then the float yaw that produces it
          const dNeeded = target / DEGTORAD + (arm === 'min' ? h : -h);
          const yaw0 = f32(dNeeded);
          for (let step = -2; step <= 2 && !found; step += 1) {
            const yaw = ulpShift(yaw0, step);
            if (!(yaw >= 0 && yaw < 360)) continue;
            const fov = f32(2 * h);
            const fz = new FrustumXZ();
            fz.set(APEX, APEX, yaw, fov);
            const hitMin = f32Bits(fz.angmin) === f32Bits(target) ? 'angmin' : null;
            const hitMax = f32Bits(fz.angmax) === f32Bits(target) ? 'angmax' : null;
            const hit = hitMin ?? hitMax;
            if (hit === null) continue;
            const vNative = verdict(fz.angmin, fz.angmax, row.native);
            const vPort = verdict(fz.angmin, fz.angmax, row.port);
            if (vNative === vPort) continue; // a limit touched, but the verdict is the same
            found = {
              row,
              yaw,
              fov,
              angmin: fz.angmin,
              angmax: fz.angmax,
              limitTouched: `${hit} == ${tag} (${hex(f32Bits(target))})`,
              nativeVerdict: vNative,
              portVerdict: vPort,
              position: [f32(APEX - row.y), 0, f32(APEX - row.x)],
            };
            break;
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) witnesses.push(found);
  }

  console.log(`witness search over ${searched} differing rows inside |y|,|x| <= ${WORLD_HALF}`);
  console.log(`  fov in [${MIN_FOV}, ${MAX_FOV}], yaw in [0, 360), apex (${APEX}, ${APEX})`);
  console.log(`  rows whose differing 1 ulp DOES flip an Inside verdict: ${witnesses.length}/${searched}`);
  console.log(
    `  the transcription (libm atan2f, t_4bb10112) matches the shipped atan2f on ` +
      `${agreedWithTranscription} of those ${differingRows} differing rows`,
  );
  const show = witnesses.length > 0 ? witnesses.slice(0, 4) : [];
  for (const w of show) {
    console.log(
      `  WITNESS y=${hex(f32Bits(w.row.y))} x=${hex(f32Bits(w.row.x))} ` +
        `atan2f=${hex(f32Bits(w.row.native))} port=${hex(f32Bits(w.row.port))} ` +
        `(${ulp(w.row.native, w.row.port)} ulp apart)`,
    );
    console.log(
      `    yaw=${w.yaw} fov=${w.fov} angmin=${hex(f32Bits(w.angmin))} angmax=${hex(f32Bits(w.angmax))} ` +
        `${w.limitTouched}`,
    );
    console.log(
      `    p=(${w.position[0]}, ${w.position[1]}, ${w.position[2]}) -> ` +
        `native Inside=${w.nativeVerdict}, port Inside=${w.portVerdict}`,
    );
  }
  if (witnesses.length === 0) {
    console.log('  no witness: no reachable wedge limit lands on a differing point in this sweep');
  }
}

main();
