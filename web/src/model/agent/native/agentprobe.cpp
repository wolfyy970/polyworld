/*
 * Lane L8 (agent core) — native reference probe.
 *
 * Emits differential-test vectors taken from the REAL C++ build (libpolyworld.dylib),
 * not from a re-derivation.  The lane's vitest suite replays the same inputs through
 * `src/model/agent/**` and requires the results to be equal *bit for bit* (floats are
 * emitted as their IEEE-754 bit patterns, so a comparison cannot hide a 1-ulp drift).
 *
 * PORT-NOTE(L8/native-probe): this file is oracle tooling, not model code.  It is the
 * only place in the lane that links the native tree; nothing in `src/model/**` imports
 * it.  The probe never runs a simulation and never writes into the native tree: it
 * constructs the objects it needs and calls the native functions the lane ports.
 *
 *   agentprobe collision <out.json> [count]     agent::GetCollisionFixedCoordinates
 *   agentprobe energy    <out.json> [count]     environment/Energy.{h,cc} arithmetic
 *   agentprobe config    <out.json> <worldfile> agent::processWorldfile on a real worldfile
 *   agentprobe lifespan  <out.json>             LifeSpan::BR_NAMES / DR_NAMES
 *
 * Build/run through ./agentprobe.sh (it knows the include paths, the SDK's OpenGL
 * headers, the Homebrew prefix and the rpath of the native tree).
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "agent/agent.h"
#include "environment/Energy.h"
#include "proplib/proplib.h"
#include "sim/globals.h"
#include "utils/misc.h"

// ---------------------------------------------------------------------------
// bit-exact emission helpers
// ---------------------------------------------------------------------------

static FILE *gOut = NULL;

static uint32_t fbits(float v) {
  uint32_t u;
  memcpy(&u, &v, 4);
  return u;
}

static void putf(float v) { fprintf(gOut, "%u", (unsigned)fbits(v)); }

static void putv4(const float *v) {
  fprintf(gOut, "[");
  for (int i = 0; i < 4; i++) fprintf(gOut, "%s%u", i ? "," : "", (unsigned)fbits(v[i]));
  fprintf(gOut, "]");
}

static void putString(const std::string &s) {
  fprintf(gOut, "\"");
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') fprintf(gOut, "\\%c", c);
    else if (c < 0x20 || c > 0x7e) fprintf(gOut, "\\u%04x", c);
    else fputc(c, gOut);
  }
  fprintf(gOut, "\"");
}

static void putCString(const char *s) { putString(std::string(s)); }

// ---------------------------------------------------------------------------
// deterministic probe generator (NOT one of the model's RNG streams; the model's PRNGs
// are lane L1's contract and tooling must never consume them)
// ---------------------------------------------------------------------------

static uint64_t gState = 0x243f6a8885a308d3ull;

static uint64_t next64(void) {
  gState ^= gState << 13;
  gState ^= gState >> 7;
  gState ^= gState << 17;
  return gState;
}

static double nextUnit(void) { return (double)(next64() >> 11) / 9007199254740992.0; }

static float nextFloat(float lo, float hi) { return (float)(lo + (hi - lo) * nextUnit()); }

static int nextPolarity(void) {
  uint64_t r = next64() % 3;
  return (r == 0) ? -1 : (r == 1 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// collision: agent::GetCollisionFixedCoordinates
// ---------------------------------------------------------------------------

struct CollisionCase {
  float xo, zo, xn, zn, xb, zb, rc, rb;
};

// The method reads no member state, so an unconstructed instance is safe: nothing is
// touched but the eight arguments.  (Passing NULL would be the same call, but clang is
// free to exploit the null in ways this avoids.)
static void callFixedCoordinates(const CollisionCase &c, float *xf, float *zf) {
  alignas(agent) static unsigned char storage[sizeof(agent)];
  agent *a = reinterpret_cast<agent *>(storage);
  a->GetCollisionFixedCoordinates(c.xo, c.zo, c.xn, c.zn, c.xb, c.zb, c.rc, c.rb, xf, zf);
}

static void modeCollision(const char *out, int count) {
  gOut = fopen(out, "w");
  if (!gOut) { fprintf(stderr, "agentprobe: cannot write %s\n", out); exit(2); }

  std::vector<CollisionCase> cases;

  // crafted cases: one per branch/early-out in the native code
  const float crafted[][8] = {
      {1.0f, 2.0f, 1.0f, 2.0f, 5.0f, 6.0f, 0.5f, 0.5f},   // dx == dz == 0 (early out)
      {0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f, 1.0f, 1.0f},   // pure z motion
      {0.0f, 0.0f, 1.0f, 0.0f, 5.0f, 0.0f, 1.0f, 1.0f},   // pure x motion
      {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f},   // all zero
      {1.0f, 1.0f, 3.0f, 4.0f, 5.0f, 6.0f, 0.9f, 0.9f},   // separating roots
      {1.0f, 1.0f, 2.0f, 1.0f, 1.5f, 1.0f, 0.2f, 0.2f},   // real roots, d1 < d2 (x branch)
      {1.0f, 1.0f, 1.0f, 2.0f, 1.0f, 1.5f, 0.2f, 0.2f},   // real roots (z branch)
      {-1.0f, -1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.3f, 0.3f}, // crossing the origin
      {0.0f, 0.0f, 1e-7f, 1.0f, 0.0f, 0.5f, 0.1f, 0.1f},  // tiny dx
      {0.0f, 0.0f, 1.0f, 1e-7f, 0.0f, 0.5f, 0.1f, 0.1f},  // tiny dz
      {100.0f, -100.0f, 100.5f, -99.5f, 100.2f, -99.8f, 1.0f, 1.0f},
      {-3.5f, 7.25f, -3.0f, 7.5f, -3.2f, 7.4f, 0.5f, 0.25f},
      {0.0f, 0.0f, 0.0f, 5.0f, 0.0f, 2.5f, 0.5f, 0.5f},   // dz-only, hit
      {0.0f, 0.0f, 5.0f, 0.0f, 2.5f, 0.0f, 0.5f, 0.5f},   // dx-only, hit
      {1.0f, 1.0f, 4.0f, 4.0f, 2.0f, 2.0f, 1.0f, 1.0f},   // diagonal, d1 == d2
      {0.5f, 0.5f, 0.5f, 0.5f, 1.0f, 1.0f, 5.0f, 5.0f},   // zero motion, far brick

      // Contraction cases (t_4392393c).  The native build compiles with clang's `-O2`
      // default `-ffp-contract=on`, so every `a*b + c` in `GetCollisionFixedCoordinates` is
      // one fused rounding and not the source's multiply-then-add; these six inputs are
      // minimal examples where the two forms differ in the last bit (three per branch, found
      // offline by replaying both forms).  A rounds-per-operation transcription fails these
      // and passes the other 3016; the disassembled form passes all of them.  See PARITY.md
      // -> the float-contraction rule and `f32Fma` in `src/model/agent/numeric.ts`.
      {-0.07f, 1.3f, 5.75f, -3.75f, 9.0f, -0.15f, 1.5f, 5.0f},        // x branch, zf1 last bit
      {-5.75f, -0.06f, -0.17f, 0.3f, 1.2f, 0.16f, 0.5f, 1.0f},        // x branch, zf1 last bit
      {-4.25f, -0.19f, -0.25f, -2.1f, 2.0f, -1.1f, 1.0f, 3.0f},       // x branch, zf1 last bit
      {-6.5f, 0.12f, -2.9f, 7.0f, -0.1f, 2.0f, 0.25f, 5.0f},          // z branch, zf1 last bit
      {-0.16f, 0.12f, -6.5f, 7.75f, -0.75f, -0.14f, 1.5f, 0.25f},     // z branch, xf1 last bit
      {-7.0f, -1.0f, -2.4f, 7.5f, -7.75f, -0.05f, 1.5f, 5.0f},        // z branch, xf1 last bit
  };
  for (size_t i = 0; i < sizeof(crafted) / sizeof(crafted[0]); i++) {
    CollisionCase c;
    c.xo = crafted[i][0]; c.zo = crafted[i][1]; c.xn = crafted[i][2]; c.zn = crafted[i][3];
    c.xb = crafted[i][4]; c.zb = crafted[i][5]; c.rc = crafted[i][6]; c.rb = crafted[i][7];
    cases.push_back(c);
  }

  for (int i = 0; i < count; i++) {
    CollisionCase c;
    c.xo = nextFloat(-100.0f, 100.0f);
    c.zo = nextFloat(-100.0f, 100.0f);
    c.xn = nextFloat(-100.0f, 100.0f);
    c.zn = nextFloat(-100.0f, 100.0f);
    c.xb = nextFloat(-100.0f, 100.0f);
    c.zb = nextFloat(-100.0f, 100.0f);
    c.rc = nextFloat(0.0f, 5.0f);
    c.rb = nextFloat(0.0f, 5.0f);
    cases.push_back(c);
  }

  fprintf(gOut, "{\n  \"kind\": \"agent.GetCollisionFixedCoordinates\",\n  \"cases\": [\n");
  for (size_t i = 0; i < cases.size(); i++) {
    const CollisionCase &c = cases[i];
    float xf = 0.0f, zf = 0.0f;
    callFixedCoordinates(c, &xf, &zf);
    fprintf(gOut, "    {\"in\": [%u,%u,%u,%u,%u,%u,%u,%u], \"out\": [%u,%u]}%s\n",
            (unsigned)fbits(c.xo), (unsigned)fbits(c.zo), (unsigned)fbits(c.xn),
            (unsigned)fbits(c.zn), (unsigned)fbits(c.xb), (unsigned)fbits(c.zb),
            (unsigned)fbits(c.rc), (unsigned)fbits(c.rb), (unsigned)fbits(xf),
            (unsigned)fbits(zf), (i + 1 == cases.size()) ? "" : ",");
  }
  fprintf(gOut, "  ]\n}\n");
  fclose(gOut);
}

// ---------------------------------------------------------------------------
// energy: environment/Energy arithmetic
// ---------------------------------------------------------------------------

// `Energy`, `EnergyPolarity` and `EnergyMultiplier` keep no vtable and no state beyond a
// fixed 4-slot array, and expose no component-wise setter (a polarity with UNDEFINED
// components is constructed by proplib in the model, never by assignment).  Rather than
// poke at private members through a fake accessor, the probe asserts the layout and
// injects the operands as bytes: values are then bit-identical to what the model's own
// constructors would produce from a worldfile array of the same floats.
static void putvn(const float *v, int n) {
  fprintf(gOut, "[");
  for (int i = 0; i < n; i++) fprintf(gOut, "%s%u", i ? "," : "", (unsigned)fbits(v[i]));
  fprintf(gOut, "]");
}

static void modeEnergy(const char *out, int count) {
  gOut = fopen(out, "w");
  if (!gOut) { fprintf(stderr, "agentprobe: cannot write %s\n", out); exit(2); }

  if (sizeof(Energy) != 4 * sizeof(float) || sizeof(EnergyPolarity) != 4 * sizeof(int) ||
      sizeof(EnergyMultiplier) != 4 * sizeof(float)) {
    fprintf(stderr, "agentprobe: unexpected Energy layout (sizeof Energy=%zu, "
                    "EnergyPolarity=%zu, EnergyMultiplier=%zu)\n",
            sizeof(Energy), sizeof(EnergyPolarity), sizeof(EnergyMultiplier));
    exit(3);
  }

  fprintf(gOut, "{\n  \"kind\": \"environment.Energy\",\n  \"cases\": [\n");

  for (int k = 0; k < count; k++) {
    const int n = 1 + (int)(next64() % 4);   // == globals::numEnergyTypes
    const int op = (int)(next64() % 10);
    globals::numEnergyTypes = n;

    float a[4] = {0, 0, 0, 0};
    float b[4] = {0, 0, 0, 0};
    float m[4] = {0, 0, 0, 0};
    int p[4] = {1, 1, 1, 1};
    for (int i = 0; i < n; i++) {
      a[i] = nextFloat(-500.0f, 500.0f);
      b[i] = nextFloat(-500.0f, 500.0f);
      m[i] = nextFloat(-2.0f, 2.0f);
      p[i] = nextPolarity();
    }
    if (k % 7 == 0) {                       // exact-value cases: zeros, ties, +-0.5
      for (int i = 0; i < n; i++) {
        a[i] = (i % 3 == 0) ? 0.0f : ((i % 3 == 1) ? 750.980408f : -1.0f);
        b[i] = (i % 2 == 0) ? 0.5f : -0.5f;
        m[i] = (i % 4 == 0) ? 0.0f : ((i % 4 == 1) ? 1.0f : -1.0f);
      }
    }

    Energy ea, eb;
    EnergyMultiplier mul;
    EnergyPolarity polarity;
    memcpy(&ea, a, sizeof(ea));
    memcpy(&eb, b, sizeof(eb));
    memcpy(&mul, m, sizeof(mul));
    memcpy(&polarity, p, sizeof(polarity));

    float y[4] = {0, 0, 0, 0};
    float ov[4] = {0, 0, 0, 0};
    float extra = 0.0f;
    float extra2 = 0.0f;
    int flag = 0;

    switch (op) {
      case 0: { Energy r = ea + eb; for (int i = 0; i < n; i++) y[i] = r[i]; break; }
      case 1: { Energy r = ea - eb; for (int i = 0; i < n; i++) y[i] = r[i]; break; }
      case 2: { Energy r = ea * b[0]; for (int i = 0; i < n; i++) y[i] = r[i]; break; }
      case 3: { Energy r = ea * polarity; for (int i = 0; i < n; i++) y[i] = r[i]; break; }
      case 4: { Energy r = ea * mul; for (int i = 0; i < n; i++) y[i] = r[i]; break; }
      case 5: {
        // min is b[0] broadcast; max is the M array read as an Energy (the same array is
        // read two ways on purpose: multiplier in case 4, bound here)
        Energy e = ea, mn = Energy(b[0]), mx, overflow;
        memcpy(&mx, m, sizeof(mx));
        e.constrain(mn, mx, overflow);
        for (int i = 0; i < n; i++) { y[i] = e[i]; ov[i] = overflow[i]; }
        break;
      }
      case 6: {
        Energy e = ea;
        extra = e.sum();
        extra2 = e.mean();
        Energy threshold = eb;
        flag = (e.isZero() ? 1 : 0) | (e.isDepleted(threshold) ? 2 : 0);
        break;
      }
      case 7: {
        Energy r = Energy::createDepletionThreshold(ea, polarity);
        for (int i = 0; i < n; i++) y[i] = r[i];
        break;
      }
      case 8: {
        Energy r = Energy(ea, eb, polarity);
        for (int i = 0; i < n; i++) y[i] = r[i];
        break;
      }
      default: {
        Energy e = ea;
        e += eb;
        for (int i = 0; i < n; i++) y[i] = e[i];
        break;
      }
    }

    fprintf(gOut, "    {\"n\": %d, \"op\": %d, \"a\": ", n, op);
    putvn(a, n);
    fprintf(gOut, ", \"b\": ");
    putvn(b, n);
    fprintf(gOut, ", \"m\": ");
    putvn(m, n);
    fprintf(gOut, ", \"p\": [");
    for (int i = 0; i < n; i++) fprintf(gOut, "%s%d", i ? "," : "", p[i]);
    fprintf(gOut, "], \"out\": ");
    putvn(y, n);
    fprintf(gOut, ", \"ov\": ");
    putvn(ov, n);
    fprintf(gOut, ", \"extra\": ");
    putf(extra);
    fprintf(gOut, ", \"extra2\": ");
    putf(extra2);
    fprintf(gOut, ", \"flag\": %d}%s\n", flag, (k + 1 == count) ? "" : ",");
  }

  fprintf(gOut, "  ]\n}\n");
  fclose(gOut);
}

// ---------------------------------------------------------------------------
// config: agent::processWorldfile against a real worldfile document
// ---------------------------------------------------------------------------

static const char *kWorldfileKeys[] = {
    "SeedSynapsesFromRun", "FreezeSeededSynapses", "AgentHeight", "Vision",
    "MaxVelocity", "MaxCarries", "MinVisionPitch", "MaxVisionPitch", "MinVisionYaw",
    "MaxVisionYaw", "EyeHeight", "InitMateWait", "RandomSeedMateWait", "MinAgentSize",
    "MaxAgentSize", "MinLifeSpan", "MaxLifeSpan", "MinAgentStrength", "MaxAgentStrength",
    "MinAgentMaxSpeed", "MaxAgentMaxSpeed", "MinEnergyFractionToOffspring",
    "MaxEnergyFractionToOffspring", "MinAgentMaxEnergy", "MaxAgentMaxEnergy", "MotionRate",
    "YawRate", "YawEncoding", "MinHorizontalFieldOfView", "MaxHorizontalFieldOfView",
    "VerticalFieldOfView", "MaxSizeFightAdvantage", "BodyRedChannel", "BodyGreenChannel",
    "BodyBlueChannel", "NoseColor", "MaxSeedEnergy", "RandomSeedEnergy",
    "EnergyUseMultiplier", "AgeEnergyMultiplier", "DieAtMaxAge", "StarvationEnergyFraction",
    "StarvationWait", "EnergyUseEat", "EnergyUseMate", "EnergyUseFight", "EnergyUseGive",
    "MinSizeEnergyPenalty", "MaxSizeEnergyPenalty", "EnergyUseMove", "EnergyUseTurn",
    "EnergyUseLight", "EnergyUseFocus", "EnergyUsePickup", "EnergyUseDrop",
    "EnergyUseCarryAgent", "EnergyUseCarryAgentSize", "EnergyUseFixed",
    "EnableMateWaitFeedback", "InvertMateWaitFeedback", "EnableSpeedFeedback", "EnableGive",
    "EnableCarry", "InvertFocus", "EnableVisionPitch", "EnableVisionYaw",
};

static void modeConfig(const char *out, const char *docPath, int nparams, char **params_argv) {
  gOut = fopen(out, "w");
  if (!gOut) { fprintf(stderr, "agentprobe: cannot write %s\n", out); exit(2); }

  // Exactly the pipeline TSimulation::processWorldFile's caller uses (Simulation.cc:269-284):
  // schema -> worldfile document + `--Key value` parameters -> schema->apply -> the model's
  // own processWorldfile.  Loading the original worldfile (not the written normalized one)
  // is what the recorded run did.
  proplib::DocumentBuilder builder;
  proplib::SchemaDocument *schema = builder.buildSchemaDocument("./etc/worldfile.wfs");
  proplib::ParameterMap parameters;
  for (int i = 0; i < nparams; i++) {
    const std::string pair = params_argv[i];
    const size_t eq = pair.find('=');
    if (eq == std::string::npos) {
      fprintf(stderr, "agentprobe: parameters must be Key=Value, got '%s'\n", pair.c_str());
      exit(2);
    }
    parameters[pair.substr(0, eq)] = pair.substr(eq + 1);
  }
  proplib::Document *doc = builder.buildWorldfileDocument(schema, docPath, parameters);
  schema->apply(doc);

  fprintf(gOut, "{\n  \"kind\": \"agent.processWorldfile\",\n  \"worldfile\": ");
  putCString(docPath);
  fprintf(gOut, ",\n  \"keys\": {\n");
  const size_t nkeys = sizeof(kWorldfileKeys) / sizeof(kWorldfileKeys[0]);
  for (size_t i = 0; i < nkeys; i++) {
    proplib::Property &prop = doc->get(kWorldfileKeys[i]);
    std::string text = (std::string)prop;
    fprintf(gOut, "    ");
    putCString(kWorldfileKeys[i]);
    fprintf(gOut, ": ");
    putString(text);
    fprintf(gOut, "%s\n", (i + 1 == nkeys) ? "" : ",");
  }
  fprintf(gOut, "  },\n");

  agent::processWorldfile(*doc);

  const agent::Configuration &c = agent::config;
  fprintf(gOut, "  \"config\": {\n");
  struct FloatField { const char *name; float value; };
  const FloatField floats[] = {
      {"agentHeight", c.agentHeight},
      {"minAgentSize", c.minAgentSize},
      {"maxAgentSize", c.maxAgentSize},
      {"minStrength", c.minStrength},
      {"maxStrength", c.maxStrength},
      {"minmaxspeed", c.minmaxspeed},
      {"maxmaxspeed", c.maxmaxspeed},
      {"minmateenergy", c.minmateenergy},
      {"maxmateenergy", c.maxmateenergy},
      {"eat2Energy", c.eat2Energy},
      {"mate2Energy", c.mate2Energy},
      {"fight2Energy", c.fight2Energy},
      {"give2Energy", c.give2Energy},
      {"minSizePenalty", c.minSizePenalty},
      {"maxSizePenalty", c.maxSizePenalty},
      {"speed2Energy", c.speed2Energy},
      {"yaw2Energy", c.yaw2Energy},
      {"light2Energy", c.light2Energy},
      {"focus2Energy", c.focus2Energy},
      {"pickup2Energy", c.pickup2Energy},
      {"drop2Energy", c.drop2Energy},
      {"carryAgent2Energy", c.carryAgent2Energy},
      {"carryAgentSize2Energy", c.carryAgentSize2Energy},
      {"fixedEnergyDrain", c.fixedEnergyDrain},
      {"maxCarries", c.maxCarries},
      {"speed2DPosition", c.speed2DPosition},
      {"maxRadius", c.maxRadius},
      {"maxVelocity", c.maxVelocity},
      {"minMaxEnergy", c.minMaxEnergy},
      {"maxMaxEnergy", c.maxMaxEnergy},
      {"yaw2DYaw", c.yaw2DYaw},
      {"minFocus", c.minFocus},
      {"maxFocus", c.maxFocus},
      {"agentFOV", c.agentFOV},
      {"minVisionPitch", c.minVisionPitch},
      {"maxVisionPitch", c.maxVisionPitch},
      {"minVisionYaw", c.minVisionYaw},
      {"maxVisionYaw", c.maxVisionYaw},
      {"eyeHeight", c.eyeHeight},
      {"maxSizeAdvantage", c.maxSizeAdvantage},
      {"bodyRedChannelConstValue", c.bodyRedChannelConstValue},
      {"bodyGreenChannelConstValue", c.bodyGreenChannelConstValue},
      {"bodyBlueChannelConstValue", c.bodyBlueChannelConstValue},
      {"noseColorConstValue", c.noseColorConstValue},
      {"maxSeedEnergy", c.maxSeedEnergy},
      {"energyUseMultiplier", c.energyUseMultiplier},
      {"ageEnergyMultiplier", c.ageEnergyMultiplier},
      {"starvationEnergyFraction", c.starvationEnergyFraction},
  };
  const size_t nfloats = sizeof(floats) / sizeof(floats[0]);
  for (size_t i = 0; i < nfloats; i++) {
    fprintf(gOut, "    ");
    putCString(floats[i].name);
    fprintf(gOut, ": %u%s\n", (unsigned)fbits(floats[i].value),
            (i + 1 == nfloats) ? "" : ",");
  }
  fprintf(gOut, "  },\n");

  fprintf(gOut, "  \"longs\": {\n");
  struct LongField { const char *name; long value; };
  const LongField longs[] = {
      {"minLifeSpan", c.minLifeSpan},
      {"maxLifeSpan", c.maxLifeSpan},
      {"initMateWait", c.initMateWait},
      {"starvationWait", c.starvationWait},
  };
  const size_t nlongs = sizeof(longs) / sizeof(longs[0]);
  for (size_t i = 0; i < nlongs; i++) {
    fprintf(gOut, "    ");
    putCString(longs[i].name);
    fprintf(gOut, ": %ld%s\n", longs[i].value, (i + 1 == nlongs) ? "" : ",");
  }
  fprintf(gOut, "  },\n");

  fprintf(gOut, "  \"bools\": {\n");
  struct BoolField { const char *name; bool value; };
  const BoolField bools[] = {
      {"vision", c.vision},
      {"randomSeedMateWait", c.randomSeedMateWait},
      {"hasLightBehavior", c.hasLightBehavior},
      {"randomSeedEnergy", c.randomSeedEnergy},
      {"dieAtMaxAge", c.dieAtMaxAge},
      {"enableMateWaitFeedback", c.enableMateWaitFeedback},
      {"invertMateWaitFeedback", c.invertMateWaitFeedback},
      {"enableSpeedFeedback", c.enableSpeedFeedback},
      {"enableGive", c.enableGive},
      {"enableCarry", c.enableCarry},
      {"invertFocus", c.invertFocus},
      {"enableVisionPitch", c.enableVisionPitch},
      {"enableVisionYaw", c.enableVisionYaw},
  };
  const size_t nbools = sizeof(bools) / sizeof(bools[0]);
  for (size_t i = 0; i < nbools; i++) {
    fprintf(gOut, "    ");
    putCString(bools[i].name);
    fprintf(gOut, ": %s%s\n", bools[i].value ? "true" : "false",
            (i + 1 == nbools) ? "" : ",");
  }
  fprintf(gOut, "  },\n");

  fprintf(gOut, "  \"enums\": {\n");
  struct EnumField { const char *name; int value; };
  const EnumField enums[] = {
      {"yawEncoding", (int)c.yawEncoding},
      {"bodyRedChannel", (int)c.bodyRedChannel},
      {"bodyGreenChannel", (int)c.bodyGreenChannel},
      {"bodyBlueChannel", (int)c.bodyBlueChannel},
      {"noseColor", (int)c.noseColor},
  };
  const size_t nenums = sizeof(enums) / sizeof(enums[0]);
  for (size_t i = 0; i < nenums; i++) {
    fprintf(gOut, "    ");
    putCString(enums[i].name);
    fprintf(gOut, ": %d%s\n", enums[i].value, (i + 1 == nenums) ? "" : ",");
  }
  fprintf(gOut, "  }\n}\n");
  fclose(gOut);
}

// ---------------------------------------------------------------------------
// lifespan: the name tables `lifespans.txt` is written from
// ---------------------------------------------------------------------------

static void modeLifespan(const char *out) {
  gOut = fopen(out, "w");
  if (!gOut) { fprintf(stderr, "agentprobe: cannot write %s\n", out); exit(2); }

  fprintf(gOut, "{\n  \"kind\": \"agent.LifeSpan\",\n  \"birth\": [");
  for (int i = 0; i < LifeSpan::__BR_NTYPES; i++) {
    if (i) fprintf(gOut, ",");
    putCString(LifeSpan::BR_NAMES[i]);
  }
  fprintf(gOut, "],\n  \"death\": [");
  for (int i = 0; i < LifeSpan::__DR_NTYPES; i++) {
    if (i) fprintf(gOut, ",");
    putCString(LifeSpan::DR_NAMES[i]);
  }
  fprintf(gOut, "]\n}\n");
  fclose(gOut);
}

// ---------------------------------------------------------------------------

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr,
            "usage: agentprobe collision|energy|lifespan <out.json> [count]\n"
            "       agentprobe config <out.json> <worldfile>\n");
    return 2;
  }

  const std::string mode = argv[1];
  // Native `proplib::Interpreter::init()` starts the expression evaluator (python); without
  // it every `getEvaledString()` on a dynamic property dereferences a null process.  The
  // simulation calls it on startup, so the probe must too.
  proplib::Interpreter::init();
  if (mode == "collision") {
    modeCollision(argv[2], argc > 3 ? atoi(argv[3]) : 2000);
  } else if (mode == "energy") {
    modeEnergy(argv[2], argc > 3 ? atoi(argv[3]) : 500);
  } else if (mode == "lifespan") {
    modeLifespan(argv[2]);
  } else if (mode == "config") {
    if (argc < 4) { fprintf(stderr, "agentprobe: config needs a worldfile\n"); return 2; }
    modeConfig(argv[2], argv[3], argc - 4, argv + 4);
  } else {
    fprintf(stderr, "agentprobe: unknown mode %s\n", mode.c_str());
    return 2;
  }

  // Shut the evaluator's python child down; without this the interpreter holds the
  // inherited stdout pipe open and a caller reading the probe's output waits forever.
  proplib::Interpreter::dispose();

  return 0;
}
