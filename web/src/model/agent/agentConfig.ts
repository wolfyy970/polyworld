/**
 * Lane L8 — `agent::config` and the agent class's statics (native `agent.h` / `agent.cc`).
 *
 * Native keeps this as a static struct inside the `agent` class, written once by
 * `agent::processWorldfile( doc )` and read as `agent::config.<field>` from every part of
 * the model. The port keeps the same shape and the same single writer, but in its own module
 * so the sensors and the agent body can read it without an import cycle.
 *
 * PORT-NOTE(L8/config-singleton): native's statics are zero-initialized (float 0 / bool
 * false / enum 0) and only *overwritten* by `processWorldfile`, so the port starts at zeros
 * and has no per-field default. A field the worldfile never sets therefore reads as 0 in
 * both, which is exactly what the recorded runs do.
 *
 * PORT-NOTE(L8/config-error-is-a-throw): the two `assert(false)` paths in
 * `processWorldfile` (an unknown `YawEncoding`) and the `default:` arms of the body-colour
 * switches are ported as thrown `AgentConfigError`s: native aborts the run, and a port that
 * silently picked a branch would diverge without a message.
 */

import { Config, type PropertyNode } from '../types';
import { INT_MAX } from './numeric';

/** Native `agent::BodyRedChannel`. */
export const BodyRedChannel = {
  BRC_FIGHT: 0,
  BRC_CONST: 1,
  BRC_GIVE: 2,
} as const;

export type BodyRedChannel = (typeof BodyRedChannel)[keyof typeof BodyRedChannel];

/** Native `agent::BodyGreenChannel`. */
export const BodyGreenChannel = {
  BGC_ID: 0,
  BGC_LIGHT: 1,
  BGC_EAT: 2,
  BGC_FOOD: 3,
  BGC_CONST: 4,
} as const;

export type BodyGreenChannel = (typeof BodyGreenChannel)[keyof typeof BodyGreenChannel];

/** Native `agent::BodyBlueChannel`. */
export const BodyBlueChannel = {
  BBC_MATE: 0,
  BBC_CONST: 1,
  BBC_ENERGY: 2,
} as const;

export type BodyBlueChannel = (typeof BodyBlueChannel)[keyof typeof BodyBlueChannel];

/** Native `agent::NoseColor`. */
export const NoseColor = {
  NC_LIGHT: 0,
  NC_BODY: 1,
  NC_CONST: 2,
} as const;

export type NoseColor = (typeof NoseColor)[keyof typeof NoseColor];

/** Native `agent::YawEncoding`. */
export const YawEncoding = {
  YE_SQUASH: 0,
  YE_OPPOSE: 1,
} as const;

export type YawEncoding = (typeof YawEncoding)[keyof typeof YawEncoding];

/** Native `agent::Configuration` — field names and declaration order preserved. */
export interface AgentConfiguration {
  agentHeight: number;
  minAgentSize: number;
  maxAgentSize: number;
  minLifeSpan: number;
  maxLifeSpan: number;
  minStrength: number;
  maxStrength: number;
  minmaxspeed: number;
  maxmaxspeed: number;
  minmateenergy: number;
  maxmateenergy: number;
  eat2Energy: number;
  mate2Energy: number;
  fight2Energy: number;
  give2Energy: number;
  minSizePenalty: number;
  maxSizePenalty: number;
  speed2Energy: number;
  yaw2Energy: number;
  light2Energy: number;
  focus2Energy: number;
  pickup2Energy: number;
  drop2Energy: number;
  carryAgent2Energy: number;
  carryAgentSize2Energy: number;
  fixedEnergyDrain: number;
  maxCarries: number;
  vision: boolean;
  initMateWait: number;
  randomSeedMateWait: boolean;
  speed2DPosition: number;
  maxRadius: number;
  maxVelocity: number;
  minMaxEnergy: number;
  maxMaxEnergy: number;
  yaw2DYaw: number;
  yawEncoding: YawEncoding;
  minFocus: number;
  maxFocus: number;
  agentFOV: number;
  minVisionPitch: number;
  maxVisionPitch: number;
  minVisionYaw: number;
  maxVisionYaw: number;
  eyeHeight: number;
  maxSizeAdvantage: number;
  bodyRedChannel: BodyRedChannel;
  bodyRedChannelConstValue: number;
  bodyGreenChannel: BodyGreenChannel;
  bodyGreenChannelConstValue: number;
  bodyBlueChannel: BodyBlueChannel;
  bodyBlueChannelConstValue: number;
  noseColor: NoseColor;
  noseColorConstValue: number;
  hasLightBehavior: boolean;
  maxSeedEnergy: number;
  randomSeedEnergy: boolean;
  energyUseMultiplier: number;
  ageEnergyMultiplier: number;
  dieAtMaxAge: boolean;
  starvationEnergyFraction: number;
  starvationWait: number;

  enableMateWaitFeedback: boolean;
  invertMateWaitFeedback: boolean;
  enableSpeedFeedback: boolean;
  enableGive: boolean;
  enableCarry: boolean;
  invertFocus: boolean;
  enableVisionPitch: boolean;
  enableVisionYaw: boolean;
}

/** Native `agent::config`, zero-initialized exactly like the native statics. */
export const agentConfig: AgentConfiguration = {
  agentHeight: 0,
  minAgentSize: 0,
  maxAgentSize: 0,
  minLifeSpan: 0,
  maxLifeSpan: 0,
  minStrength: 0,
  maxStrength: 0,
  minmaxspeed: 0,
  maxmaxspeed: 0,
  minmateenergy: 0,
  maxmateenergy: 0,
  eat2Energy: 0,
  mate2Energy: 0,
  fight2Energy: 0,
  give2Energy: 0,
  minSizePenalty: 0,
  maxSizePenalty: 0,
  speed2Energy: 0,
  yaw2Energy: 0,
  light2Energy: 0,
  focus2Energy: 0,
  pickup2Energy: 0,
  drop2Energy: 0,
  carryAgent2Energy: 0,
  carryAgentSize2Energy: 0,
  fixedEnergyDrain: 0,
  maxCarries: 0,
  vision: false,
  initMateWait: 0,
  randomSeedMateWait: false,
  speed2DPosition: 0,
  maxRadius: 0,
  maxVelocity: 0,
  minMaxEnergy: 0,
  maxMaxEnergy: 0,
  yaw2DYaw: 0,
  yawEncoding: YawEncoding.YE_SQUASH,
  minFocus: 0,
  maxFocus: 0,
  agentFOV: 0,
  minVisionPitch: 0,
  maxVisionPitch: 0,
  minVisionYaw: 0,
  maxVisionYaw: 0,
  eyeHeight: 0,
  maxSizeAdvantage: 0,
  bodyRedChannel: BodyRedChannel.BRC_FIGHT,
  bodyRedChannelConstValue: 0,
  bodyGreenChannel: BodyGreenChannel.BGC_ID,
  bodyGreenChannelConstValue: 0,
  bodyBlueChannel: BodyBlueChannel.BBC_MATE,
  bodyBlueChannelConstValue: 0,
  noseColor: NoseColor.NC_LIGHT,
  noseColorConstValue: 0,
  hasLightBehavior: false,
  maxSeedEnergy: 0,
  randomSeedEnergy: false,
  energyUseMultiplier: 0,
  ageEnergyMultiplier: 0,
  dieAtMaxAge: false,
  starvationEnergyFraction: 0,
  starvationWait: 0,

  enableMateWaitFeedback: false,
  invertMateWaitFeedback: false,
  enableSpeedFeedback: false,
  enableGive: false,
  enableCarry: false,
  invertFocus: false,
  enableVisionPitch: false,
  enableVisionYaw: false,
};

/** Raised where native `assert(false)`s in the agent configuration path. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/** Restore the pre-`processWorldfile` (zero-initialized) state. Tests only. */
export function resetAgentConfig(): void {
  Object.assign(agentConfig, {
    agentHeight: 0, minAgentSize: 0, maxAgentSize: 0, minLifeSpan: 0, maxLifeSpan: 0,
    minStrength: 0, maxStrength: 0, minmaxspeed: 0, maxmaxspeed: 0, minmateenergy: 0,
    maxmateenergy: 0, eat2Energy: 0, mate2Energy: 0, fight2Energy: 0, give2Energy: 0,
    minSizePenalty: 0, maxSizePenalty: 0, speed2Energy: 0, yaw2Energy: 0, light2Energy: 0,
    focus2Energy: 0, pickup2Energy: 0, drop2Energy: 0, carryAgent2Energy: 0,
    carryAgentSize2Energy: 0, fixedEnergyDrain: 0, maxCarries: 0, vision: false,
    initMateWait: 0, randomSeedMateWait: false, speed2DPosition: 0, maxRadius: 0,
    maxVelocity: 0, minMaxEnergy: 0, maxMaxEnergy: 0, yaw2DYaw: 0,
    yawEncoding: YawEncoding.YE_SQUASH, minFocus: 0, maxFocus: 0, agentFOV: 0,
    minVisionPitch: 0, maxVisionPitch: 0, minVisionYaw: 0, maxVisionYaw: 0, eyeHeight: 0,
    maxSizeAdvantage: 0, bodyRedChannel: BodyRedChannel.BRC_FIGHT,
    bodyRedChannelConstValue: 0, bodyGreenChannel: BodyGreenChannel.BGC_ID,
    bodyGreenChannelConstValue: 0, bodyBlueChannel: BodyBlueChannel.BBC_MATE,
    bodyBlueChannelConstValue: 0, noseColor: NoseColor.NC_LIGHT, noseColorConstValue: 0,
    hasLightBehavior: false, maxSeedEnergy: 0, randomSeedEnergy: false,
    energyUseMultiplier: 0, ageEnergyMultiplier: 0, dieAtMaxAge: false,
    starvationEnergyFraction: 0, starvationWait: 0,
    enableMateWaitFeedback: false, invertMateWaitFeedback: false, enableSpeedFeedback: false,
    enableGive: false, enableCarry: false, invertFocus: false, enableVisionPitch: false,
    enableVisionYaw: false,
  });
}

/** Native `agent`'s non-config statics (the class-level counters and flags). */
export const AgentStatics = {
  /** Native `agent::gClassInited`. */
  classInited: false,
  /** Native `agent::agentsEver` — 1-based, assigned in `getfreeagent`. */
  agentsEver: 0,
  /** Native `agent::agentsliving`. */
  agentsLiving: 0,
  /** Native `agent::fSeedSynapsesFromFile`. */
  seedSynapsesFromFile: false,
  /** Native `agent::fSeedSynapseFilePaths`. */
  seedSynapseFilePaths: [] as string[],
  /** Native `agent::fFreezeSeededSynapses`. */
  freezeSeededSynapses: false,
};

/** Restore the statics (tests only; native has no equivalent). */
export function resetAgentStatics(): void {
  AgentStatics.classInited = false;
  AgentStatics.agentsEver = 0;
  AgentStatics.agentsLiving = 0;
  AgentStatics.seedSynapsesFromFile = false;
  AgentStatics.seedSynapseFilePaths = [];
  AgentStatics.freezeSeededSynapses = false;
}

/**
 * Native `agent::processWorldfile( proplib::Document &doc )` — start of `agent.cc`.
 *
 * Every read is native's: the same key, the same coercion (`getBool` == `operator bool`,
 * `getFloat` == `operator float`, `getInt` == `operator int` *and* `operator long`, which
 * native implements as the same `toInt()` call), the same order. The three string-valued
 * channels are native's exact spelling (`"Fight"`, `"Give"`, `"I"`, `"L"`, `"E"`, `"F"`,
 * `"Mate"`, `"Energy"`, `"B"`) — a case difference silently selects the float branch.
 *
 * `SeedSynapsesFromRun` also triggers `ReadSeedSynapseFilePaths()`, which in native reads
 * `synapseSeeds.txt` from the working directory and `exit(1)`s when it is missing. That is
 * file-system work: the port exposes the *result* (`AgentStatics.seedSynapseFilePaths`) and
 * leaves the loading to whoever has a file system (the browser lane reads no files at all;
 * Gaps rows name it).
 */
export function processWorldfile(doc: PropertyNode): void {
  const cfg = new Config(doc);

  AgentStatics.seedSynapsesFromFile = cfg.getBool('SeedSynapsesFromRun');
  AgentStatics.freezeSeededSynapses = cfg.getBool('FreezeSeededSynapses');

  agentConfig.agentHeight = cfg.getFloat('AgentHeight');
  agentConfig.vision = cfg.getBool('Vision');
  agentConfig.maxVelocity = cfg.getFloat('MaxVelocity');
  agentConfig.maxCarries = cfg.getFloat('MaxCarries');
  agentConfig.minVisionPitch = cfg.getFloat('MinVisionPitch');
  agentConfig.maxVisionPitch = cfg.getFloat('MaxVisionPitch');
  agentConfig.minVisionYaw = cfg.getFloat('MinVisionYaw');
  agentConfig.maxVisionYaw = cfg.getFloat('MaxVisionYaw');
  agentConfig.eyeHeight = cfg.getFloat('EyeHeight');
  agentConfig.initMateWait = cfg.getInt('InitMateWait');
  agentConfig.randomSeedMateWait = cfg.getBool('RandomSeedMateWait');
  agentConfig.minAgentSize = cfg.getFloat('MinAgentSize');
  agentConfig.maxAgentSize = cfg.getFloat('MaxAgentSize');
  agentConfig.minLifeSpan = cfg.getInt('MinLifeSpan');
  agentConfig.maxLifeSpan = cfg.getInt('MaxLifeSpan');
  agentConfig.minStrength = cfg.getFloat('MinAgentStrength');
  agentConfig.maxStrength = cfg.getFloat('MaxAgentStrength');
  agentConfig.minmaxspeed = cfg.getFloat('MinAgentMaxSpeed');
  agentConfig.maxmaxspeed = cfg.getFloat('MaxAgentMaxSpeed');
  agentConfig.minmateenergy = cfg.getFloat('MinEnergyFractionToOffspring');
  agentConfig.maxmateenergy = cfg.getFloat('MaxEnergyFractionToOffspring');
  agentConfig.minMaxEnergy = cfg.getFloat('MinAgentMaxEnergy');
  agentConfig.maxMaxEnergy = cfg.getFloat('MaxAgentMaxEnergy');
  agentConfig.speed2DPosition = cfg.getFloat('MotionRate');
  agentConfig.yaw2DYaw = cfg.getFloat('YawRate');

  const encoding = cfg.getString('YawEncoding');
  if (encoding === 'Oppose') agentConfig.yawEncoding = YawEncoding.YE_OPPOSE;
  else if (encoding === 'Squash') agentConfig.yawEncoding = YawEncoding.YE_SQUASH;
  else throw new AgentConfigError(`agent: unknown YawEncoding '${encoding}'`);

  agentConfig.minFocus = cfg.getFloat('MinHorizontalFieldOfView');
  agentConfig.maxFocus = cfg.getFloat('MaxHorizontalFieldOfView');
  agentConfig.agentFOV = cfg.getFloat('VerticalFieldOfView');
  agentConfig.maxSizeAdvantage = cfg.getFloat('MaxSizeFightAdvantage');

  {
    // Native reads the same property twice: once as a string (to recognise the keyword) and,
    // only when that fails, as the constant value.
    const text = cfg.getString('BodyRedChannel');
    if (text === 'Fight') agentConfig.bodyRedChannel = BodyRedChannel.BRC_FIGHT;
    else if (text === 'Give') agentConfig.bodyRedChannel = BodyRedChannel.BRC_GIVE;
    else {
      agentConfig.bodyRedChannel = BodyRedChannel.BRC_CONST;
      agentConfig.bodyRedChannelConstValue = cfg.getFloat('BodyRedChannel');
    }
  }
  {
    const text = cfg.getString('BodyGreenChannel');
    if (text === 'I') agentConfig.bodyGreenChannel = BodyGreenChannel.BGC_ID;
    else if (text === 'L') agentConfig.bodyGreenChannel = BodyGreenChannel.BGC_LIGHT;
    else if (text === 'E') agentConfig.bodyGreenChannel = BodyGreenChannel.BGC_EAT;
    else if (text === 'F') agentConfig.bodyGreenChannel = BodyGreenChannel.BGC_FOOD;
    else {
      agentConfig.bodyGreenChannel = BodyGreenChannel.BGC_CONST;
      agentConfig.bodyGreenChannelConstValue = cfg.getFloat('BodyGreenChannel');
    }
  }
  {
    const text = cfg.getString('BodyBlueChannel');
    if (text === 'Mate') agentConfig.bodyBlueChannel = BodyBlueChannel.BBC_MATE;
    else if (text === 'Energy') agentConfig.bodyBlueChannel = BodyBlueChannel.BBC_ENERGY;
    else {
      agentConfig.bodyBlueChannel = BodyBlueChannel.BBC_CONST;
      agentConfig.bodyBlueChannelConstValue = cfg.getFloat('BodyBlueChannel');
    }
  }
  {
    const text = cfg.getString('NoseColor');
    if (text === 'L') agentConfig.noseColor = NoseColor.NC_LIGHT;
    else if (text === 'B') agentConfig.noseColor = NoseColor.NC_BODY;
    else {
      agentConfig.noseColor = NoseColor.NC_CONST;
      agentConfig.noseColorConstValue = cfg.getFloat('NoseColor');
    }
  }

  agentConfig.hasLightBehavior =
    agentConfig.bodyGreenChannel === BodyGreenChannel.BGC_LIGHT ||
    agentConfig.noseColor === NoseColor.NC_LIGHT;

  agentConfig.maxSeedEnergy = cfg.getFloat('MaxSeedEnergy');
  agentConfig.randomSeedEnergy = cfg.getBool('RandomSeedEnergy');
  agentConfig.energyUseMultiplier = cfg.getFloat('EnergyUseMultiplier');
  agentConfig.ageEnergyMultiplier = cfg.getFloat('AgeEnergyMultiplier');
  agentConfig.dieAtMaxAge = cfg.getBool('DieAtMaxAge');
  agentConfig.starvationEnergyFraction = cfg.getFloat('StarvationEnergyFraction');
  agentConfig.starvationWait = cfg.getInt('StarvationWait');

  agentConfig.eat2Energy = cfg.getFloat('EnergyUseEat');
  agentConfig.mate2Energy = cfg.getFloat('EnergyUseMate');
  agentConfig.fight2Energy = cfg.getFloat('EnergyUseFight');
  agentConfig.give2Energy = cfg.getFloat('EnergyUseGive');
  agentConfig.minSizePenalty = cfg.getFloat('MinSizeEnergyPenalty');
  agentConfig.maxSizePenalty = cfg.getFloat('MaxSizeEnergyPenalty');
  agentConfig.speed2Energy = cfg.getFloat('EnergyUseMove');
  agentConfig.yaw2Energy = cfg.getFloat('EnergyUseTurn');
  agentConfig.light2Energy = cfg.getFloat('EnergyUseLight');
  agentConfig.focus2Energy = cfg.getFloat('EnergyUseFocus');
  agentConfig.pickup2Energy = cfg.getFloat('EnergyUsePickup');
  agentConfig.drop2Energy = cfg.getFloat('EnergyUseDrop');
  agentConfig.carryAgent2Energy = cfg.getFloat('EnergyUseCarryAgent');
  agentConfig.carryAgentSize2Energy = cfg.getFloat('EnergyUseCarryAgentSize');
  agentConfig.fixedEnergyDrain = cfg.getFloat('EnergyUseFixed');

  agentConfig.enableMateWaitFeedback = cfg.getBool('EnableMateWaitFeedback');
  agentConfig.invertMateWaitFeedback = cfg.getBool('InvertMateWaitFeedback');
  agentConfig.enableSpeedFeedback = cfg.getBool('EnableSpeedFeedback');
  agentConfig.enableGive = cfg.getBool('EnableGive');
  agentConfig.enableCarry = cfg.getBool('EnableCarry');
  agentConfig.invertFocus = cfg.getBool('InvertFocus');
  agentConfig.enableVisionPitch = cfg.getBool('EnableVisionPitch');
  agentConfig.enableVisionYaw = cfg.getBool('EnableVisionYaw');
}

/** Native `agent::InitGeneCache()`'s lifespan fallback (`INT_MAX` when age is not fatal). */
export function defaultGeneLifespan(): number {
  return INT_MAX;
}
