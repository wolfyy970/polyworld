/*
 * Lane L14 (monitor) — native reference probe.
 *
 * Emits differential-test vectors taken from the REAL C++ build (libpolyworld.dylib), not
 * from a re-derivation: the same library the recorded goldens came from.  The lane's vitest
 * suite replays the same inputs through the lane's TypeScript modules and compares bit for bit
 * (floats are emitted as IEEE-754 bit patterns, so a comparison cannot hide a 1-ulp drift).
 *
 * PORT-NOTE(L14/native-probe): oracle tooling, not model code.  Nothing in `src/model/`
 * imports this file and nothing here writes into the native tree.  It constructs the objects
 * it needs, calls the native functions the lane ports, and prints.
 *
 *   monitorprobe camera        <out.json> [cases]  CameraController (real gcamera), all modes
 *   monitorprobe moviesettings <out.json>          MovieSettings::{shouldRecord,...}
 *   monitorprobe monitorconfig <out.json> <doc>    the MonitorManager document reads
 *   monitorprobe enums         <out.json>          Monitor::Type / AgentTracker::Mode orders
 *
 * Build/run through ./monitorprobe.sh.  What is *not* probeable and why is in PARITY.md
 * ("Open questions"): the live-agent camera-tracking branches need a real `agent`, and
 * AgentTracker::setTarget is private to two friends (Listener, MonitorManager) — neither is
 * reachable without constructing a TSimulation and the Qt renderer.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "monitor/AgentTracker.h"
#include "monitor/CameraController.h"
#include "monitor/Monitor.h"
#include "monitor/MovieController.h"
#include "proplib/proplib.h"
#include "sim/globals.h"
#include "utils/misc.h"

using namespace std;

// ---------------------------------------------------------------------------
// bit-exact emission helpers (same shape as lane L8's agentprobe)
// ---------------------------------------------------------------------------

static FILE *gOut = NULL;

static uint32_t fbits(float v) {
  uint32_t u;
  memcpy(&u, &v, 4);
  return u;
}

static void putf(float v) { fprintf(gOut, "%u", (unsigned)fbits(v)); }

static void putPos(const float *p) {
  fprintf(gOut, "[");
  for (int i = 0; i < 3; i++) fprintf(gOut, "%s%u", i ? "," : "", (unsigned)fbits(p[i]));
  fprintf(gOut, "]");
}

static void putString(const string &s) {
  fprintf(gOut, "\"");
  for (size_t i = 0; i < s.size(); i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') fprintf(gOut, "\\%c", c);
    else if (c < 0x20 || c > 0x7e) fprintf(gOut, "\\u%04x", c);
    else fputc(c, gOut);
  }
  fprintf(gOut, "\"");
}

// deterministic generator for the synthetic cases (NOT one of the model's RNG streams --
// those are lane L1's contract and tooling must never consume them).
static uint64_t gState = 0x243f6a8885a308d3ull;

static uint64_t next64(void) {
  gState ^= gState << 13;
  gState ^= gState >> 7;
  gState ^= gState << 17;
  return gState;
}

static float randFloat(float lo, float hi) {
  double u = (double)(next64() >> 11) / (double)(1ull << 53);
  return (float)(lo + u * (hi - lo));
}

// ---------------------------------------------------------------------------
// camera: CameraController over a real gcamera
// ---------------------------------------------------------------------------

struct CameraSnapshot {
  float pos[3];
  float rot[3];
};

static void snapshotCamera(gcamera &cam, CameraSnapshot &s) {
  s.pos[0] = cam.x();
  s.pos[1] = cam.y();
  s.pos[2] = cam.z();
  s.rot[0] = cam.getyaw();
  s.rot[1] = cam.getpitch();
  s.rot[2] = cam.getroll();
}

static void emitSnapshot(const CameraSnapshot &s) {
  fprintf(gOut, "{\"position\":");
  putPos(s.pos);
  fprintf(gOut, ",\"rotation\":");
  putPos(s.rot);
  fprintf(gOut, "}");
}

static void emitRotateCase(int index,
                           float radius,
                           float height,
                           float rate,
                           float angleStart,
                           const float fixation[3],
                           float worldsize,
                           int steps) {
  globals::worldsize = worldsize;

  gcamera cam;
  CameraController controller(cam);

  CameraController::RotationParms parms(radius, height, rate, angleStart,
                                        fixation[0], fixation[1], fixation[2]);
  controller.initRotation(parms);

  fprintf(gOut, "{\"index\":%d,\"radius\":", index);
  putf(radius);
  fprintf(gOut, ",\"height\":");
  putf(height);
  fprintf(gOut, ",\"rate\":");
  putf(rate);
  fprintf(gOut, ",\"angleStart\":");
  putf(angleStart);
  fprintf(gOut, ",\"fixation\":");
  putPos(fixation);
  fprintf(gOut, ",\"worldsize\":");
  putf(worldsize);
  fprintf(gOut, ",\"frames\":[");

  CameraSnapshot s;
  snapshotCamera(cam, s);
  emitSnapshot(s);
  for (int i = 0; i < steps; i++) {
    controller.step();
    snapshotCamera(cam, s);
    fprintf(gOut, ",");
    emitSnapshot(s);
  }
  fprintf(gOut, "]}");
}

static void modeCamera(const char *path, int cases) {
  gOut = fopen(path, "w");
  if (!gOut) {
    perror(path);
    exit(1);
  }

  fprintf(gOut, "{\n  \"kind\": \"monitor.CameraController\",\n");

  // ---- Rotate ---------------------------------------------------------- #
  fprintf(gOut, "  \"rotate\": [\n");
  // the two parm sets the recorded scenarios actually use: etc/monitors.mfs'
  // "Main" entry, at the minitest world size, and the schema defaults.
  {
    globals::worldsize = 100.0f;
    float ws = globals::worldsize;
    float fix[3] = {0.5f * ws, 0.0f, -0.5f * ws};
    emitRotateCase(0, 0.6f, 0.35f, 0.09f, 0.0f, fix, ws, 40);
    fprintf(gOut, ",\n");
    emitRotateCase(1, 0.6f, 0.35f, 0.09f, 0.0f, fix, 1.0f, 3);
    fprintf(gOut, ",\n");
  }
  for (int i = 0; i < cases; i++) {
    float ws = randFloat(1.0f, 400.0f);
    float radius = randFloat(0.0f, 5.0f);
    float height = randFloat(0.0f, 2.0f);
    float rate = randFloat(-90.0f, 90.0f);
    float angleStart = randFloat(-720.0f, 720.0f);
    float fix[3] = {randFloat(0.0f, 1.0f) * ws, randFloat(0.0f, 1.0f), -randFloat(0.0f, 1.0f) * ws};
    int steps = 1 + (int)(next64() % 4);
    emitRotateCase(2 + i, radius, height, rate, angleStart, fix, ws, steps);
    fprintf(gOut, "%s\n", i + 1 < cases ? "," : "");
  }
  fprintf(gOut, "  ],\n");

  // ---- Static ---------------------------------------------------------- #
  fprintf(gOut, "  \"static\": [\n");
  for (int i = 0; i < 1 + cases; i++) {
    float ws = (i == 0) ? 100.0f : randFloat(1.0f, 400.0f);
    float height = (i == 0) ? 0.6f : randFloat(0.0f, 2.0f);
    globals::worldsize = ws;

    gcamera cam;
    CameraController controller(cam);
    CameraController::StaticParms parms(height);
    controller.initStatic(parms);
    CameraSnapshot s;
    snapshotCamera(cam, s);

    fprintf(gOut, "{\"index\":%d,\"height\":", i);
    putf(height);
    fprintf(gOut, ",\"worldsize\":");
    putf(ws);
    fprintf(gOut, ",\"frames\":[");
    emitSnapshot(s);
    controller.step();
    snapshotCamera(cam, s);
    fprintf(gOut, ",");
    emitSnapshot(s);
    fprintf(gOut, "]}%s\n", i < cases ? "," : "");
  }
  fprintf(gOut, "  ],\n");

  // ---- AgentTracking, no target --------------------------------------- #
  // (a target is only reachable through setTarget, which is private to
  // MonitorManager/Listener; PARITY.md records that as not-probeable)
  fprintf(gOut, "  \"agentTracking\": [\n");
  for (int i = 0; i < 2; i++) {
    float ws = (i == 0) ? 100.0f : randFloat(1.0f, 400.0f);
    globals::worldsize = ws;

    AgentTracker::Parms tp = AgentTracker::Parms::createFitness(1);
    AgentTracker tracker("Fittest", tp);

    gcamera cam;
    CameraController controller(cam);
    CameraController::AgentTrackingParms::Perspective perspective =
        (i == 0) ? CameraController::AgentTrackingParms::OVERHEAD
                 : CameraController::AgentTrackingParms::POV;
    CameraController::AgentTrackingParms parms(&tracker, perspective);
    controller.initAgentTracking(parms);

    CameraSnapshot s;
    snapshotCamera(cam, s);
    fprintf(gOut, "{\"index\":%d,\"perspective\":%d,\"worldsize\":", i, (int)perspective);
    putf(ws);
    fprintf(gOut, ",\"frames\":[");
    emitSnapshot(s);
    for (int k = 0; k < 2; k++) {
      controller.step();
      snapshotCamera(cam, s);
      fprintf(gOut, ",");
      emitSnapshot(s);
    }
    fprintf(gOut, "]}%s\n", i == 0 ? "," : "");
  }
  fprintf(gOut, "  ]\n}\n");

  fclose(gOut);
  gOut = NULL;
}

// ---------------------------------------------------------------------------
// moviesettings: MovieSettings::{shouldRecord(), shouldRecord(t)}
// ---------------------------------------------------------------------------

static void modeMovieSettings(const char *path) {
  gOut = fopen(path, "w");
  if (!gOut) {
    perror(path);
    exit(1);
  }

  fprintf(gOut, "{\n  \"kind\": \"monitor.MovieSettings\",\n  \"cases\": [\n");

  const int freqs[] = {1, 2, 3, 5, 10, 100};
  const int durs[] = {1, 2, 3, 5, 10};
  bool first = true;
  for (int fi = 0; fi < 6; fi++) {
    for (int di = 0; di < 5; di++) {
      int sf = freqs[fi];
      int sd = durs[di];
      if (sd > sf) continue;
      for (int record = 0; record < 2; record++) {
        MovieSettings settings(record != 0, "run/movie.pmv", sf, sd);
        if (!first) fprintf(gOut, ",\n");
        first = false;
        fprintf(gOut, "    {\"record\":%d,\"sampleFrequency\":%d,\"sampleDuration\":%d,\"shouldRecord\":%d,\"timesteps\":[",
                record, sf, sd, settings.shouldRecord() ? 1 : 0);
        int timestep = 0;
        // timestep 0 is legal input here only to pin the native arithmetic (the writer
        // asserts timestep > 0, so a run never asks); the model path starts at 1.
        for (int t = 0; t <= 4 * sf + 2; t++) {
          fprintf(gOut, "%s%d", (t == 0) ? "" : ",", settings.shouldRecord(t) ? 1 : 0);
          timestep = t;
        }
        fprintf(gOut, "],\"n\":%d}", timestep + 1);
      }
    }
  }

  fprintf(gOut, "\n  ]\n}\n");
  fclose(gOut);
  gOut = NULL;
}

// ---------------------------------------------------------------------------
// monitorconfig: exactly the document reads MonitorManager's constructor makes
// ---------------------------------------------------------------------------

static void putBoolLeaf(const char *path, bool v) {
  fprintf(gOut, "{\"path\":\"%s\",\"kind\":\"bool\",\"value\":%d}", path, v ? 1 : 0);
}

static void putIntLeaf(const char *path, int v) {
  fprintf(gOut, "{\"path\":\"%s\",\"kind\":\"int\",\"value\":%d}", path, v);
}

static void putFloatLeaf(const char *path, float v) {
  fprintf(gOut, "{\"path\":\"%s\",\"kind\":\"float\",\"bits\":", path);
  putf(v);
  fprintf(gOut, "}");
}

static void putStringLeaf(const char *path, const string &v) {
  fprintf(gOut, "{\"path\":\"%s\",\"kind\":\"string\",\"value\":", path);
  putString(v);
  fprintf(gOut, "}");
}

static void modeMonitorConfig(const char *outPath, const char *docPath) {
  gOut = fopen(outPath, "w");
  if (!gOut) {
    perror(outPath);
    exit(1);
  }

  // main.cc: `proplib::Interpreter::init()` before MonitorManager is constructed and
  // `dispose()` right after (main.cc:157-163) -- every document read here goes through the
  // same window.
  proplib::Interpreter::init();

  proplib::DocumentBuilder builder;
  proplib::SchemaDocument *pschema = builder.buildSchemaDocument("./etc/monitors.mfs");
  proplib::Document *pdoc = builder.buildDocument(docPath);
  pschema->apply(pdoc);
  proplib::Document &doc = *pdoc;

  fprintf(gOut, "{\n  \"kind\": \"monitor.MonitorConfig\",\n  \"document\":");
  putString(docPath);
  fprintf(gOut, ",\n  \"leaves\": [\n");

  bool first = true;
  auto leaf = [&](const char *path, int value) {
    if (!first) fprintf(gOut, ",\n    ");
    first = false;
    putIntLeaf(path, value);
  };
  auto leafF = [&](const char *path, float value) {
    if (!first) fprintf(gOut, ",\n    ");
    first = false;
    putFloatLeaf(path, value);
  };
  auto leafS = [&](const char *path, const string &value) {
    if (!first) fprintf(gOut, ",\n    ");
    first = false;
    putStringLeaf(path, value);
  };
  auto leafB = [&](const char *path, bool value) {
    if (!first) fprintf(gOut, ",\n    ");
    first = false;
    putBoolLeaf(path, value);
  };

  char buf[256];

  // --- charts ---
  const char *charts[] = {"BirthRate", "Fitness", "FoodEnergy", "Population"};
  for (int i = 0; i < 4; i++) {
    snprintf(buf, sizeof(buf), "%s.Enabled", charts[i]);
    leafB(buf, (bool)doc.get(charts[i]).get("Enabled"));
  }

  // --- brain / POV / status text ---
  leafB("Brain.Enabled", (bool)doc.get("Brain").get("Enabled"));
  leaf("Brain.Frequency", (int)doc.get("Brain").get("Frequency"));
  leafS("Brain.AgentTracker", (string)doc.get("Brain").get("AgentTracker"));
  leafB("POV.Enabled", (bool)doc.get("POV").get("Enabled"));
  leafB("StatusText.Enabled", (bool)doc.get("StatusText").get("Enabled"));
  leaf("StatusText.FrequencyDisplay", (int)doc.get("StatusText").get("FrequencyDisplay"));
  leaf("StatusText.FrequencyStore", (int)doc.get("StatusText").get("FrequencyStore"));
  leafB("StatusText.StorePerformance", (bool)doc.get("StatusText").get("StorePerformance"));

  // --- farm ---
  leafB("Farm.Enabled", (bool)doc.get("Farm").get("Enabled"));
  leaf("Farm.Frequency", (int)doc.get("Farm").get("Frequency"));
  {
    int i = 0;
    itfor(proplib::PropertyMap, doc.get("Farm").get("Properties").elements(), it) {
      snprintf(buf, sizeof(buf), "Farm.Properties[%d].Name", i);
      leafS(buf, it->second->get("Name"));
      snprintf(buf, sizeof(buf), "Farm.Properties[%d].Title", i);
      leafS(buf, it->second->get("Title"));
      i++;
    }
  }

  // --- agent trackers ---
  {
    size_t n = doc.get("AgentTrackers").size();
    for (size_t i = 0; i < n; i++) {
      proplib::Property &t = doc.get("AgentTrackers").get(i);
      snprintf(buf, sizeof(buf), "AgentTrackers[%zu].Name", i);
      leafS(buf, t.get("Name"));
      snprintf(buf, sizeof(buf), "AgentTrackers[%zu].TrackMode", i);
      leafS(buf, t.get("TrackMode"));
      snprintf(buf, sizeof(buf), "AgentTrackers[%zu].SelectionMode", i);
      leafS(buf, t.get("SelectionMode"));
      snprintf(buf, sizeof(buf), "AgentTrackers[%zu].Fitness.Rank", i);
      leaf(((string)"AgentTrackers[" + to_string(i) + "].Fitness.Rank").c_str(), (int)t.get("Fitness").get("Rank"));
      snprintf(buf, sizeof(buf), "AgentTrackers[%zu].Number", i);
      leaf(((string)"AgentTrackers[" + to_string(i) + "].Number").c_str(), (int)t.get("Number"));
    }
    fprintf(gOut, ",\n    {\"path\":\"AgentTrackers.count\",\"kind\":\"int\",\"value\":%zu}", n);
    first = false;
  }

  // --- camera settings ---
  {
    size_t n = doc.get("CameraSettings").size();
    for (size_t i = 0; i < n; i++) {
      proplib::Property &s = doc.get("CameraSettings").get(i);
      string base = "CameraSettings[" + to_string(i) + "]";
      leafS((base + ".Name").c_str(), s.get("Name"));
      leafF((base + ".FieldOfView").c_str(), (float)s.get("FieldOfView"));
      leafF((base + ".Color.R").c_str(), (float)s.get("Color").get("R"));
      leafF((base + ".Color.G").c_str(), (float)s.get("Color").get("G"));
      leafF((base + ".Color.B").c_str(), (float)s.get("Color").get("B"));
    }
    fprintf(gOut, ",\n    {\"path\":\"CameraSettings.count\",\"kind\":\"int\",\"value\":%zu}", n);
    first = false;
  }

  // --- camera controller settings ---
  {
    size_t n = doc.get("CameraControllerSettings").size();
    for (size_t i = 0; i < n; i++) {
      proplib::Property &s = doc.get("CameraControllerSettings").get(i);
      string base = "CameraControllerSettings[" + to_string(i) + "]";
      leafS((base + ".Name").c_str(), s.get("Name"));
      string mode = s.get("Mode");
      leafS((base + ".Mode").c_str(), mode);

      if (mode == "Rotate") {
        proplib::Property &m = s.get("Rotate");
        leafF((base + ".Rotate.Radius").c_str(), (float)m.get("Radius"));
        leafF((base + ".Rotate.Height").c_str(), (float)m.get("Height"));
        leafF((base + ".Rotate.Rate").c_str(), (float)m.get("Rate"));
        leafF((base + ".Rotate.AngleStart").c_str(), (float)m.get("AngleStart"));
        leafF((base + ".Rotate.Fixation.X").c_str(), (float)m.get("Fixation").get("X"));
        leafF((base + ".Rotate.Fixation.Y").c_str(), (float)m.get("Fixation").get("Y"));
        leafF((base + ".Rotate.Fixation.Z").c_str(), (float)m.get("Fixation").get("Z"));
      } else if (mode == "AgentTracking") {
        proplib::Property &m = s.get("AgentTracking");
        leafS((base + ".AgentTracking.AgentTracker").c_str(), m.get("AgentTracker"));
        leafS((base + ".AgentTracking.Perspective").c_str(), m.get("Perspective"));
      } else if (mode == "Static") {
        proplib::Property &m = s.get("Static");
        leafF((base + ".Static.Height").c_str(), (float)m.get("Height"));
      }
    }
    fprintf(gOut, ",\n    {\"path\":\"CameraControllerSettings.count\",\"kind\":\"int\",\"value\":%zu}", n);
    first = false;
  }

  // --- scenes ---
  {
    const char *scenes[] = {"MainScene", "OverheadScene", "SinglePOVScene"};
    for (int i = 0; i < 3; i++) {
      proplib::Property &s = doc.get(scenes[i]);
      string base = scenes[i];
      leafB((base + ".Enabled").c_str(), (bool)s.get("Enabled"));
      leafS((base + ".Name").c_str(), s.get("Name"));
      leafS((base + ".Title").c_str(), s.get("Title"));
      leafS((base + ".CameraSettings").c_str(), s.get("CameraSettings"));
      leafS((base + ".CameraControllerSettings").c_str(), s.get("CameraControllerSettings"));
      leaf((base + ".Buffer.Width").c_str(), (int)s.get("Buffer").get("Width"));
      leaf((base + ".Buffer.Height").c_str(), (int)s.get("Buffer").get("Height"));
      leafB((base + ".Movie.Record").c_str(), (bool)s.get("Movie").get("Record"));
      leafS((base + ".Movie.Path").c_str(), s.get("Movie").get("Path"));
      leaf((base + ".Movie.SampleFrequency").c_str(), (int)s.get("Movie").get("SampleFrequency"));
      leaf((base + ".Movie.SampleDuration").c_str(), (int)s.get("Movie").get("SampleDuration"));
    }
  }

  leafB("RecordMovie", (bool)doc.get("RecordMovie"));

  fprintf(gOut, "\n  ]\n}\n");
  fclose(gOut);
  gOut = NULL;

  proplib::Interpreter::dispose();
}

// ---------------------------------------------------------------------------
// enums: the header-only vocabularies the port must keep in the same order
// ---------------------------------------------------------------------------

static void modeEnums(const char *path) {
  gOut = fopen(path, "w");
  if (!gOut) {
    perror(path);
    exit(1);
  }

  fprintf(gOut, "{\n  \"kind\": \"monitor.Enums\",\n");
  fprintf(gOut, "  \"monitorType\": {\"CHART\":%d,\"BRAIN\":%d,\"POV\":%d,\"STATUS_TEXT\":%d,\"FARM\":%d,\"SCENE\":%d},\n",
          (int)Monitor::CHART, (int)Monitor::BRAIN, (int)Monitor::POV,
          (int)Monitor::STATUS_TEXT, (int)Monitor::FARM, (int)Monitor::SCENE);
  fprintf(gOut, "  \"trackerMode\": {\"FITNESS\":%d,\"NUMBER\":%d},\n",
          (int)AgentTracker::FITNESS, (int)AgentTracker::NUMBER);
  fprintf(gOut, "  \"perspective\": {\"OVERHEAD\":%d,\"POV\":%d},\n",
          (int)CameraController::AgentTrackingParms::OVERHEAD,
          (int)CameraController::AgentTrackingParms::POV);

  // Parms factory defaults + the no-target state title
  AgentTracker::Parms fitness = AgentTracker::Parms::createFitness(1);
  AgentTracker::Parms fitnessNoTilDeath = AgentTracker::Parms::createFitness(1, false);
  AgentTracker::Parms number = AgentTracker::Parms::createNumber(7);
  AgentTracker tracker("Fittest", fitness);
  AgentTracker trackerNumber("First", number);
  fprintf(gOut, "  \"parms\": {\"fitness\":{\"mode\":%d,\"trackTilDeath\":%d,\"rank\":%d},\n",
          (int)fitness.mode, fitness.trackTilDeath ? 1 : 0, fitness.fitness.rank);
  fprintf(gOut, "            \"fitnessNoTilDeath\":{\"mode\":%d,\"trackTilDeath\":%d,\"rank\":%d},\n",
          (int)fitnessNoTilDeath.mode, fitnessNoTilDeath.trackTilDeath ? 1 : 0, fitnessNoTilDeath.fitness.rank);
  fprintf(gOut, "            \"number\":{\"mode\":%d,\"trackTilDeath\":%d,\"number\":%ld}},\n",
          (int)number.mode, number.trackTilDeath ? 1 : 0, number.number);
  fprintf(gOut, "  \"stateTitle\": {\"noTarget\":");
  putString(tracker.getStateTitle());
  fprintf(gOut, ",\"noTargetNumberMode\":");
  putString(trackerNumber.getStateTitle());
  fprintf(gOut, "},\n");
  fprintf(gOut, "  \"names\": {\"fittest\":");
  putString(tracker.getName());
  fprintf(gOut, "}\n}\n");

  fclose(gOut);
  gOut = NULL;
}

// ---------------------------------------------------------------------------

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: monitorprobe <camera|moviesettings|monitorconfig|enums> <out.json> [...]\n");
    return 2;
  }

  string mode = argv[1];
  if (mode == "camera") {
    modeCamera(argv[2], argc > 3 ? atoi(argv[3]) : 24);
  } else if (mode == "moviesettings") {
    modeMovieSettings(argv[2]);
  } else if (mode == "monitorconfig") {
    if (argc < 4) {
      fprintf(stderr, "monitorprobe monitorconfig <out.json> <document>\n");
      return 2;
    }
    modeMonitorConfig(argv[2], argv[3]);
  } else if (mode == "enums") {
    modeEnums(argv[2]);
  } else {
    fprintf(stderr, "monitorprobe: unknown mode '%s'\n", mode.c_str());
    return 2;
  }

  return 0;
}
