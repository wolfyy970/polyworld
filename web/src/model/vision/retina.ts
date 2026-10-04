/**
 * Lane W1j/L16 — the retina: the buffer, its three channels and the prebirth noise.
 *
 * Native source: `agent/Retina.{h,cc}` — the ctor (`Retina.cc:22-31`), `sensor_grow`
 * (`:33-43`), `sensor_prebirth_signal` (`:45-53`), `sensor_update` (`:55-90`),
 * `updateBuffer` (`:108-146`) and `Retina::Channel::init/update` (`:153-240`).
 * Spec: `docs/specs/vision-spec.md` §3, §7, §9.
 *
 * PORT_PLAN.md gives lane L9 (`agent/Retina.*` + vision encoding) the Retina object and this
 * lane the raster; the acceptance arithmetic lives in `encoder.ts` (this lane's spec §11.5).
 * Whichever lane lands the Retina first, there must be **one** implementation: this file is
 * that one, and it delegates every encoded value to `encoder.ts`.
 *
 * PORT-NOTE(vision/retina-owns-the-buffer): the native retina *is* the readback target —
 * `updateBuffer` calls `glReadPixels(…, buf)` into its own 88-byte array (`Retina.cc:116-122`).
 * In this port the readback is batched (one `glReadPixels` per step, `raster.ts`), so the
 * retina is fed a *row slice* of the atlas readback instead (`updateRow`). The bytes are the
 * same bytes; only who copies them changed.
 */

import {
  ChannelIndex,
  VisionError,
  channelGeometry,
  encodeChannel,
  type ChannelBinding,
  type NerveTarget,
} from './encoder';

/** The three channel names, in the order `Retina::sensor_grow` binds them (`Retina.cc:38-43`). */
export const CHANNEL_NAMES = ['Red', 'Green', 'Blue'] as const;

/** What the retina needs of the nervous system: `cns->getNerve( name )` (`Retina.cc:166`). */
export interface NerveSource {
  getNerve(name: string): NerveTarget | null;
}

/** Native `RandomNumberGenerator::range( lo, hi )` (`RandomNumberGenerator.cc:128-134`). */
export interface RangeRng {
  range(lo: number, hi: number): number;
}

export class VisionRetina {
  /** `retinaWidth` — `Brain::config.retinaWidth` (`agent.cc:570`). */
  readonly width: number;
  /** `unsigned char *buf`, `width * 4` bytes, RGBA (`Retina.cc:22-31`). */
  readonly buf: Uint8Array;
  /** The three channels' cached geometry, in `Retina::sensor_grow` order. */
  private readonly channels: ReadonlyArray<{
    readonly index: ChannelIndex;
    readonly name: string;
    nerve: NerveTarget | null;
  }>;

  constructor(width: number) {
    this.width = width;
    this.buf = new Uint8Array(width * 4);
    this.channels = [
      { index: ChannelIndex.Red, name: CHANNEL_NAMES[0], nerve: null },
      { index: ChannelIndex.Green, name: CHANNEL_NAMES[1], nerve: null },
      { index: ChannelIndex.Blue, name: CHANNEL_NAMES[2], nerve: null },
    ];
  }

  /** `Retina::sensor_grow` — bind `Red`/`Green`/`Blue` nerves by name (`Retina.cc:38-43`). */
  sensorGrow(cns: NerveSource): void {
    for (const channel of this.channels) {
      channel.nerve = cns.getNerve(channel.name);
      if (!channel.nerve) {
        // Native would segfault in `Channel::init`'s `nerve->getNeuronCount()`. Fail loudly.
        throw new VisionError(`retina channel '${channel.name}': nervous system has no such nerve`);
      }
      // `Channel::init` caching — the neuron count is read once, per channel (`Retina.cc:164`).
      channelGeometry(this.width, channel.nerve.getNeuronCount());
    }
  }

  /** The channels' bindings, for `encodeRetina` (or a caller that wants all three at once). */
  bindings(): ChannelBinding[] {
    return this.channels.map((channel) => ({ index: channel.index, nerve: channel.nerve! }));
  }

  /** The per-channel neuron counts (`nerve->getNeuronCount()`), in channel order. */
  neuronCounts(): [number, number, number] {
    return [
      this.channels[0]!.nerve!.getNeuronCount(),
      this.channels[1]!.nerve!.getNeuronCount(),
      this.channels[2]!.nerve!.getNeuronCount(),
    ];
  }

  /**
   * `Retina::sensor_prebirth_signal` (`Retina.cc:45-53`): `width*4` draws of
   * `range(0.0, 255.0)`, each truncated to a byte (a C `(unsigned char)` cast, i.e. toward
   * zero — the value is in [0,255) so it is a floor), then one encode.
   *
   * The draw *count* is part of the contract (§9): the retina is the first sensor registered,
   * so it consumes the first 88 draws of every prebirth cycle before any other sensor on that
   * stream — 2200 draws per agent at `PreBirthCycles 25`.
   */
  sensorPrebirthSignal(rng: RangeRng): void {
    for (let i = 0; i < this.width * 4; i++) {
      const value = rng.range(0.0, 255.0);
      this.buf[i] = Math.trunc(value) & 0xff;
    }
    this.sensorUpdate();
  }

  /**
   * `Retina::updateBuffer` (`Retina.cc:108-146`) — the readback, with the batched readback's
   * row slice in place of a per-agent `glReadPixels`. Only the sampled row is ever copied:
   * `width` pixels of RGBA (`height` is 1 in the native call, `:119`).
   */
  updateRow(row: Uint8Array | Uint8ClampedArray): void {
    if (row.length < this.width * 4) {
      throw new VisionError(`retina row too short: ${row.length} bytes, need ${this.width * 4}`);
    }
    this.buf.set(row.subarray(0, this.width * 4));
  }

  /** `Retina::sensor_update` (`Retina.cc:55-90`): encode all three channels, in order 0,1,2. */
  sensorUpdate(): void {
    for (const channel of this.channels) {
      const nerve = channel.nerve;
      if (!nerve) continue;
      const numneurons = nerve.getNeuronCount();
      if (numneurons === 0) continue; // `Channel::update` returns early (`Retina.cc:182-183`)
      const values = encodeChannel(this.buf, channel.index, numneurons, this.width);
      for (let i = 0; i < numneurons; i++) nerve.set(i, values[i]!);
    }
  }

  /** `Retina::getBuffer()` — the raw RGBA row, for debugging/diffing. */
  getBuffer(): Uint8Array {
    return this.buf;
  }
}
