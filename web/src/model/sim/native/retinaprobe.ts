/*
 * Lane L11 probe — the retina's prebirth buffer, from the port's own RNG, against the golden.
 *
 * Pipeline (native): `agent::getfreeagent` seeds the CNS RNG with the 1-based `agentsEver`
 * (`agent.cc:353`); `Brain::prebirth` runs `PreBirthCycles` (25) cycles of
 * `NervousSystem::prebirthSignal` + `update` (`Brain.cc:266-278`). `prebirthSignal` walks the
 * sensors in registration order (`agent.cc:570-583`), and only three exist in microtest:
 *   Retina (88 draws: `Retina.cc:45-53`), EnergySensor (1), RandomSensor (1)
 * — `EnableMateWaitFeedback`/`EnableSpeedFeedback`/`EnableCarry` are all False, which is why the
 * golden's input nerves are exactly 29 = 27 retina + Random + Energy (`redinput=2-10`).
 *
 * So the buffer the model sees is the *last* cycle's window, drawn after
 * `(25 - 1) * 90` draws. The golden values are agent 10's input nerves, neurons 2-28, from
 * `run/brain/function/incomplete_brainFunction_10.txt.gz`.
 *
 * Run: npx tsx src/model/sim/native/retinaprobe.ts
 */
import { RandomNumberGenerator } from '../../rng';
import { RngRole, RngType } from '../../types';
import { ChannelIndex, channelGeometry, encodeChannel } from '../../vision';

const WIDTH = 22;
const CYCLES = 25;
const OTHER_DRAWS = 2; // EnergySensor + RandomSensor

const GOLD = {
  red: [0.75205, 0.328521, 0.737077, 0.783423, 0.468628, 0.274153, 0.835829, 0.656863, 0.322816],
  green: [0.627986, 0.666667, 0.597326, 0.770232, 0.340107, 0.47041, 0.867202, 0.452763, 0.32656],
  blue: [0.608021, 0.37754, 0.62139, 0.235294, 0.390731, 0.561675, 0.512121, 0.2123, 0.196435],
};

function buffer(seed: number, cycles: number, otherDraws: number): Uint8Array {
  // Native `Simulation.cc:3866`: `StaticTimestepGeometry` True selects the LOCAL stream for the
  // NERVOUS_SYSTEM role (`microtest.wf` leaves it at the schema default, True).
  RandomNumberGenerator.set(RngRole.NERVOUS_SYSTEM, RngType.LOCAL as never);
  const rng = RandomNumberGenerator.create(RngRole.NERVOUS_SYSTEM as never);
  rng.seedIfLocal(seed);
  const buf = new Uint8Array(WIDTH * 4);
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < WIDTH * 4; i++) buf[i] = Math.trunc(rng.range(0.0, 255.0)) & 0xff;
    for (let k = 0; k < otherDraws; k++) rng.drand();
  }
  return buf;
}

function encode(buf: Uint8Array, index: ChannelIndex, neurons: number): number[] {
  channelGeometry(WIDTH, neurons);
  return Array.from(encodeChannel(buf, index, neurons, WIDTH), (v) => Number(v.toFixed(6)));
}

console.log('=== seed 1, first cycle, no other draws (the port run\'s first agent, first cycle) ===');
const b1 = buffer(1, 1, 0);
console.log('bytes', Array.from(b1.slice(0, 12)).join(','));
console.log('red  ', encode(b1, ChannelIndex.Red, 9).join(' '));

console.log('=== seed 10, 9 neurons, last prebirth cycle ===');
const b10 = buffer(10, CYCLES, OTHER_DRAWS);
console.log('cand red  ', encode(b10, ChannelIndex.Red, 9).join(' '));
console.log('gold red  ', GOLD.red.join(' '));
console.log('cand green', encode(b10, ChannelIndex.Green, 9).join(' '));
console.log('gold green', GOLD.green.join(' '));
console.log('cand blue ', encode(b10, ChannelIndex.Blue, 9).join(' '));
console.log('gold blue ', GOLD.blue.join(' '));

console.log('=== seed search (9 neurons, last cycle, 2 other draws) ===');
const channels: [keyof typeof GOLD, ChannelIndex][] = [
  ['red', ChannelIndex.Red],
  ['green', ChannelIndex.Green],
  ['blue', ChannelIndex.Blue],
];
for (let seed = 0; seed <= 30; seed++) {
  const b = buffer(seed, CYCLES, OTHER_DRAWS);
  for (const [name, index] of channels) {
    const vals = encode(b, index, 9);
    const gold = GOLD[name];
    if (vals.every((v, i) => Math.abs(v - gold[i]!) < 1e-6)) console.log('MATCH', name, 'seed', seed);
  }
}
console.log('search done');
