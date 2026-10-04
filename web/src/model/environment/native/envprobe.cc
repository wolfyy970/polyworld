/*
 * Lane L10 — the environment golden generator.
 *
 * Compiles against the ORACLE's own headers and links its already-built
 * `libpolyworld.dylib`, then drives the real `environment/**` classes and prints every
 * result as a raw float32 bit pattern plus its decimal value. The native tree is read-only:
 * nothing here writes inside it, and nothing here is part of the shipped port — it is a
 * probe, like `geometry/native/glprobe.cpp` and `brain/core/native/brainprobe.cc`.
 *
 * Why a probe rather than replaying the recorded runs: the environment's numbers reach the
 * frozen artifacts only *through* the simulation (`run/energy/food.txt` is a float sum in
 * x-sorted order over food the sim created; `events/collisions.log`'s `barrier` rows are
 * decided in `agent::UpdateBody`). Until lane L11 exists, the only way to pin the
 * environment's own arithmetic — the float chain that decides those artifacts — is to call
 * the native code directly with the same inputs the port is given.
 * `tests/environment.test.ts` additionally replays the `barrier` rows of the recorded
 * `collisions.log` against the port's barrier geometry, which is the part of the frozen
 * surface the environment owns outright.
 *
 * WHAT THE PROBE CANNOT REACH (stated, not hidden):
 *   - `Energy`'s and `EnergyPolarity`'s `values[]` arrays are **private** (`EnergyPolarity`
 *     friends only `Energy` and its `operator*`), and native's only public writers are the
 *     `proplib::Property` constructors, whose `Property` cannot be built without the whole
 *     document machinery. So the probe builds its adversarial vectors out of
 *     `Energy(float) * EnergyMultiplier(float*)` (which the port must agree on anyway) and
 *     uses only the default `EnergyPolarity()` (all POSITIVE). The `UNDEFINED -> NaN` branch
 *     of `createDepletionThreshold` and a NEGATIVE polarity are therefore *not* probe-pinned;
 *     they are single-branch, read-verified mappings, and PARITY.md records them as a residual.
 *   - `barrier::absCurrPosition` / `fVertices` are `protected` in `gpoly`. The probe pins the
 *     geometry through the public surface the model actually uses — `xmin`/`xmax`/`zmin`/
 *     `zmax`, `sina`/`cosa` and `dist()` at many points, which determine `a`, `b`, `c` and `f`.
 *   - `brick::InitBrickClass()` is private; the probe constructs a brick and reads
 *     `gBrickRadius` after, which is exactly when the model first sees it.
 *
 * Output: `key<TAB>kind<TAB>value` lines, kind in {f32, int, str, bool}; f32 values carry
 * their exact bits so a comparison cannot drift through a decimal parse.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

#include <stdlib.h>

#include "sim/globals.h"
#include "sim/Domain.h"
#include "environment/Energy.h"
#include "environment/FoodType.h"
#include "environment/FoodPatch.h"
#include "environment/brick.h"
#include "environment/BrickPatch.h"
#include "environment/food.h"
#include "environment/barrier.h"
#include "utils/distributions.h"
#include "utils/misc.h"
#include "utils/objectxsortedlist.h"
#include "graphics/gstage.h"
#include "graphics/gsquare.h"

using namespace std;

/*
 * Flipping `BrickPatch::on` is what the cppprops-generated library does at run time:
 * `PROPLIB_CPP_PROPERTIES` makes `proplib::CppProperties_Update()` a friend of the class and
 * the generated body writes the member. The probe does not dlopen the generated library, so
 * it defines that one function itself — the same access, no macro tricks — which makes the
 * brick patch's *falling* edge (the removal walk) reachable.
 */
static BrickPatch* gProbeBrickPatch = nullptr;

namespace proplib {
void CppProperties_Update( CppProperties::UpdateContext *context )
{
    (void) context;
    if( gProbeBrickPatch )
        gProbeBrickPatch->on = !gProbeBrickPatch->on;
}
} // namespace proplib

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

static void emitF32(const string& key, float v) {
    uint32_t bits;
    memcpy(&bits, &v, sizeof(bits));
    printf("%s\tf32\t0x%08x\n", key.c_str(), bits);
}

static void emitInt(const string& key, long v) {
    printf("%s\tint\t%ld\n", key.c_str(), v);
}

static void emitBool(const string& key, bool v) {
    printf("%s\tbool\t%d\n", key.c_str(), v ? 1 : 0);
}

static void emitStr(const string& key, const char* v) {
    printf("%s\tstr\t%s\n", key.c_str(), v ? v : "");
}

/** `srand48` seeds the whole `randpw()`/`drand48()` stream the model uses. */
static void seedStream(long seed) {
    srand48(seed);
}

// ---------------------------------------------------------------------------
// energy
// ---------------------------------------------------------------------------

/** Build `Energy( base ) * EnergyMultiplier( m )` — the only public per-component path. */
static Energy makeEnergy(int n, float base, const float* mValues) {
    float raw[4] = {1.0f, 1.0f, 1.0f, 1.0f};
    for (int i = 0; i < n; i++) raw[i] = mValues[i];
    EnergyMultiplier m(raw);
    return Energy(base) * m;
}

static void sectionEnergy() {
    printf("# section energy\n");

    // (base, multiplier) fixtures: uniform zero/positive/negative/extreme, and per-component
    // vectors whose multiplier sign matches the base (see the header note). Every literal here
    // is a decimal the port can write too, so the fixture is reproducible on both sides.
    struct EFix {
        const char* name;
        float aBase;
        float aM[4];
        float bBase;
        float bM[4];
    };
    const EFix fixes[] = {
        {"uniform1", 1.0f, {1.0f, 1.0f, 1.0f, 1.0f}, 2.5f, {1.0f, 1.0f, 1.0f, 1.0f}},
        {"zero", 0.0f, {1.0f, 1.0f, 1.0f, 1.0f}, 0.1f, {1.0f, 1.0f, 1.0f, 1.0f}},
        {"negative", -3.75f, {1.0f, 1.0f, 1.0f, 1.0f}, -2.5f, {1.0f, 1.0f, 1.0f, 1.0f}},
        {"mixed", 3.0f, {2.0f, 0.5f, 0.25f, 1.0f}, 1.0f, {0.5f, 2.0f, 4.0f, 0.125f}},
        {"tinyHuge", 1e-5f, {1.0f, 1e-3f, 1e3f, 1.0f}, 1e10f, {1.0f, 1e-3f, 1e3f, 1.0f}},
        {"eps", 1.0f, {1e-5f, 2e-5f, 0.5f, 1.0f}, 0.5f, {1.0f, 1.0f, 1.0f, 1.0f}},
    };

    for (int n = 1; n <= 3; n++) {
        globals::numEnergyTypes = n;
        char key[160];
        for (unsigned f = 0; f < sizeof(fixes) / sizeof(fixes[0]); f++) {
            const EFix& fix = fixes[f];
            Energy a = makeEnergy(n, fix.aBase, fix.aM);
            Energy b = makeEnergy(n, fix.bBase, fix.bM);

            string pre = "energy.n" + to_string(n) + "." + fix.name;

            // the vectors themselves (so a reader can see what was tested)
            for (int k = 0; k < n; k++) {
                snprintf(key, sizeof(key), "%s.a.%d", pre.c_str(), k);
                emitF32(key, a[k]);
                snprintf(key, sizeof(key), "%s.b.%d", pre.c_str(), k);
                emitF32(key, b[k]);
            }

            snprintf(key, sizeof(key), "%s.sum", pre.c_str());
            emitF32(key, a.sum());
            snprintf(key, sizeof(key), "%s.mean", pre.c_str());
            emitF32(key, a.mean());
            snprintf(key, sizeof(key), "%s.isZero", pre.c_str());
            emitBool(key, a.isZero());
            snprintf(key, sizeof(key), "%s.isDepletedDefault", pre.c_str());
            emitBool(key, a.isDepleted());
            snprintf(key, sizeof(key), "%s.isDepletedEps", pre.c_str());
            emitBool(key, a.isDepleted(Energy(0.00001f)));
            snprintf(key, sizeof(key), "%s.zeroAfterZero", pre.c_str());
            {
                Energy z = a;
                z.zero();
                emitF32(key, z[0]);
            }

            Energy sum = a + b;
            Energy diff = a - b;
            Energy scaled = a * 3.5f;
            Energy halved = 2.5f * a;
            for (int k = 0; k < n; k++) {
                snprintf(key, sizeof(key), "%s.add.%d", pre.c_str(), k);
                emitF32(key, sum[k]);
                snprintf(key, sizeof(key), "%s.sub.%d", pre.c_str(), k);
                emitF32(key, diff[k]);
                snprintf(key, sizeof(key), "%s.mulScalarLeft.%d", pre.c_str(), k);
                emitF32(key, scaled[k]);
                snprintf(key, sizeof(key), "%s.mulScalarRight.%d", pre.c_str(), k);
                emitF32(key, halved[k]);
            }

            {
                Energy acc = a;
                acc += b;
                Energy red = a;
                red -= b;
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.addAssign.%d", pre.c_str(), k);
                    emitF32(key, acc[k]);
                    snprintf(key, sizeof(key), "%s.subAssign.%d", pre.c_str(), k);
                    emitF32(key, red[k]);
                }
            }

            // `operator*( Energy, EnergyMultiplier )`: zero multiplier and sign mismatch both
            // pass the value through unchanged.
            {
                float mraw[4] = {0.0f, -2.0f, 2.0f, 0.5f};
                EnergyMultiplier m2(mraw);
                Energy prod = a * m2;
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.mulMultiplier.%d", pre.c_str(), k);
                    emitF32(key, prod[k]);
                }
            }

            // The default polarity is all POSITIVE, so this is a component-wise copy — pinned
            // anyway so a port that inverted the sign would show up.
            {
                EnergyPolarity p;
                Energy flipped = a * p;
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.mulPolarity.%d", pre.c_str(), k);
                    emitF32(key, flipped[k]);
                }
                Energy threshold = Energy::createDepletionThreshold(Energy(1.0f), p);
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.depletionThreshold.%d", pre.c_str(), k);
                    emitF32(key, threshold[k]);
                }
                snprintf(key, sizeof(key), "%s.polarityEquals", pre.c_str());
                emitBool(key, p == p);
            }

            {
                Energy clamped = a;
                clamped.constrain(Energy(-2.0f), Energy(1.0f));
                Energy overflowed = a;
                Energy overflow;
                overflowed.constrain(Energy(-2.0f), Energy(1.0f), overflow);
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.constrain.%d", pre.c_str(), k);
                    emitF32(key, clamped[k]);
                    snprintf(key, sizeof(key), "%s.clamped.%d", pre.c_str(), k);
                    emitF32(key, overflowed[k]);
                    snprintf(key, sizeof(key), "%s.overflow.%d", pre.c_str(), k);
                    emitF32(key, overflow[k]);
                }
            }

            {
                Energy fromPolarity = Energy(a, b, EnergyPolarity());
                for (int k = 0; k < n; k++) {
                    snprintf(key, sizeof(key), "%s.fromPolarity.%d", pre.c_str(), k);
                    emitF32(key, fromPolarity[k]);
                }
            }
        }
    }

    globals::numEnergyTypes = 3;
    {
        char key[96];
        EnergyPolarity x;
        emitBool("energy.polarequal.xx", x == x);

        float mraw[4] = {1.0f, 0.5f, -2.0f, 0.0f};
        EnergyMultiplier m1(mraw);
        EnergyMultiplier m2(mraw);
        float mraw2[4] = {1.0f, 0.5f + 1e-7f, -2.0f, 0.0f};
        EnergyMultiplier m3(mraw2);
        emitBool("energy.muleq.near", m1 == m2);
        emitBool("energy.muleq.far", m1 == m3);
        emitInt("energy.muleq.index0", (long)(m1[0] == 1.0f));
    }
}

// ---------------------------------------------------------------------------
// FoodType
// ---------------------------------------------------------------------------

static void sectionFoodType() {
    printf("# section foodtype\n");

    globals::numEnergyTypes = 1;

    const char* names[] = {"Standard", "a", "A", "10", "2", "B"};
    const float polarities[] = {1.0f, -1.0f, 1.0f, 1.0f, -1.0f, -1.0f};
    const float thresholds[] = {0.5f, 1.5f, 2.5f, 3.5f, 4.5f, 5.5f};
    const float multipliers[] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f};

    for (int i = 0; i < 6; i++) {
        Color c;
        c.r = 0.1f * (float)(i + 1);
        c.g = 0.2f * (float)(i + 1);
        c.b = 0.3f * (float)(i + 1);

        float mraw[4] = {multipliers[i], 1.0f, 1.0f, 1.0f};
        EnergyMultiplier mul(mraw);
        // `EnergyPolarity`'s only public constructor is the all-POSITIVE one; the worldfile
        // path that sets NEGATIVE needs a `proplib::Property` (see the header note).
        EnergyPolarity pol;
        (void)polarities[i];
        FoodType::define(names[i], c, pol, mul, Energy(thresholds[i]));
    }

    emitInt("foodtype.count", FoodType::getNumberDefinitions());
    for (int i = 0; i < FoodType::getNumberDefinitions(); i++) {
        char key[96];
        snprintf(key, sizeof(key), "foodtype.get.%d.name", i);
        emitStr(key, FoodType::get(i)->name.c_str());
        snprintf(key, sizeof(key), "foodtype.get.%d.index", i);
        emitInt(key, FoodType::get(i)->index);
        snprintf(key, sizeof(key), "foodtype.get.%d.threshold", i);
        emitF32(key, FoodType::get(i)->depletionThreshold[0]);
        snprintf(key, sizeof(key), "foodtype.get.%d.eatMultiplier", i);
        emitF32(key, FoodType::get(i)->eatMultiplier[0]);
        snprintf(key, sizeof(key), "foodtype.get.%d.colorR", i);
        emitF32(key, FoodType::get(i)->color.r);
    }

    for (int i = 0; i < 6; i++) {
        char key[96];
        snprintf(key, sizeof(key), "foodtype.lookup.%s.present", names[i]);
        emitBool(key, FoodType::lookup(names[i]) != NULL);
    }

    // `find` walks the map in strcmp order; with every polarity POSITIVE the winner is the
    // alphabetically-first name (which is also the name-order check the port must reproduce).
    {
        const FoodType* fp = FoodType::find(EnergyPolarity());
        emitStr("foodtype.find.positive", fp ? fp->name.c_str() : "<null>");
    }
    emitStr("foodtype.find.namesOrder",
            (string(FoodType::lookup("Standard")->name) + "," + FoodType::lookup("2")->name + "," +
             FoodType::lookup("10")->name + "," + FoodType::lookup("A")->name + "," +
             FoodType::lookup("B")->name + "," + FoodType::lookup("a")->name)
                .c_str());

    // A lookup of a name that was never defined inserts a null entry (PORT-NOTE
    // `L10/foodtype-lookup-inserts`). Measure it rather than assume it.
    emitInt("foodtype.count.beforeUnknownLookup", FoodType::getNumberDefinitions());
    const FoodType* missing = FoodType::lookup("ZZZ-never-defined");
    emitBool("foodtype.lookup.unknown.isNull", missing == NULL);
    emitInt("foodtype.count.afterUnknownLookup", FoodType::getNumberDefinitions());
}

// ---------------------------------------------------------------------------
// food
// ---------------------------------------------------------------------------

static const FoodType* standardType() {
    return FoodType::lookup("Standard");
}

static void setFoodStatics() {
    food::gFoodHeight = 1.0f;
    food::gFoodColor.r = 0.25f;
    food::gFoodColor.g = 0.5f;
    food::gFoodColor.b = 0.75f;
    food::gMinFoodEnergy = 200.0f;
    food::gMaxFoodEnergy = 1000.0f;
    food::gSize2Energy = 300.0f;
    food::gMaxFoodRadius = 1.5f;
    food::gCarryFood2Energy = 0.125f;
    food::gMaxLifeSpan = 0;
    globals::worldsize = 25.0f;
}

static void dumpFood(const string& prefix, food* f) {
    emitF32(prefix + ".energy", f->getEnergy()[0]);
    emitF32(prefix + ".x", f->x());
    emitF32(prefix + ".y", f->y());
    emitF32(prefix + ".z", f->z());
    emitF32(prefix + ".radius", f->radius());
    emitF32(prefix + ".lx", f->lx());
    emitF32(prefix + ".ly", f->ly());
    emitF32(prefix + ".lz", f->lz());
    emitInt(prefix + ".typeNumber", (long)f->getTypeNumber());
    emitInt(prefix + ".objType", (long)((gobject*)f)->getType());
    emitInt(prefix + ".domain", (long)f->domain());
    emitStr(prefix + ".foodType", f->getType()->name.c_str());
    emitBool(prefix + ".isDepleted", f->isDepleted());
}

static void sectionFood() {
    printf("# section food\n");

    const FoodType* st = standardType();
    setFoodStatics();

    seedStream(20260928);

    // (a) the 2-arg constructor: random energy, then random x, then random z.
    for (int i = 0; i < 3; i++) {
        food* f = new food(st, 0);
        char key[96];
        snprintf(key, sizeof(key), "food.random2.%d", i);
        dumpFood(key, f);
    }

    // (b) the 3-arg form (given energy, random position).
    for (int i = 0; i < 2; i++) {
        food* f = new food(st, 7, Energy(1500.0f));
        char key[96];
        snprintf(key, sizeof(key), "food.givenE.%d", i);
        dumpFood(key, f);
        emitInt((string(key) + ".age10"), f->getAge(10));
        emitInt((string(key) + ".age0"), f->getAge(0));
    }

    // (c) the 5-arg form (carcass food): no draws at all beyond the gobject colour.
    {
        food* f = new food(st, -3, Energy(400.0f), 12.5f, -7.25f);
        dumpFood("food.carcass", f);
        emitInt("food.carcass.creationStepViaAge0", f->getAge(0));
    }

    // (d) `eat` with requests below, at, and above what is left; the length follows.
    {
        food* f = new food(st, 0, Energy(100.0f), 1.0f, 2.0f);
        dumpFood("food.eat.initial", f);
        Energy r1 = f->eat(Energy(25.0f));
        emitF32("food.eat.part.actual", r1[0]);
        dumpFood("food.eat.part", f);

        Energy r2 = f->eat(Energy(1000.0f));
        emitF32("food.eat.all.actual", r2[0]);
        dumpFood("food.eat.all", f);

        Energy r3 = f->eat(Energy(5.0f));
        emitF32("food.eat.empty.actual", r3[0]);
        dumpFood("food.eat.empty", f);

        // negative request: `constrain( 0, fEnergy )` clamps it up to 0
        Energy r4 = f->eat(Energy(-4.0f));
        emitF32("food.eat.negative.actual", r4[0]);
        dumpFood("food.eat.negative", f);
    }

    // (e) `gAllFood` order: appended for step >= 0, sorted-stable for step < 0.
    {
        food::gAllFood.clear();
        new food(st, 5, Energy(1.0f), 1.0f, 1.0f);
        new food(st, -1, Energy(2.0f), 2.0f, 2.0f);
        new food(st, 5, Energy(3.0f), 3.0f, 3.0f);
        new food(st, -7, Energy(4.0f), 4.0f, 4.0f);
        new food(st, 0, Energy(5.0f), 5.0f, 5.0f);
        new food(st, -1, Energy(6.0f), 6.0f, 6.0f);

        int idx = 0;
        for (food::FoodList::iterator it = food::gAllFood.begin(); it != food::gAllFood.end();
             ++it, idx++) {
            char key[96];
            snprintf(key, sizeof(key), "food.gAllFood.order.%d", idx);
            emitF32(key, (*it)->getEnergy()[0]);
        }
        emitInt("food.gAllFood.size", (long)food::gAllFood.size());
    }
}

// ---------------------------------------------------------------------------
// Patch / FoodPatch / BrickPatch
// ---------------------------------------------------------------------------

static void sectionPatch() {
    printf("# section patch\n");

    globals::numEnergyTypes = 1;
    globals::worldsize = 25.0f;
    const FoodType* st = standardType();

    gstage stage;
    TCastList cast;
    stage.SetCast(&cast);

    Domain dm;
    dm.startX = -12.5f;
    dm.startZ = -25.0f;
    dm.absoluteSizeX = 25.0f;
    dm.absoluteSizeZ = 25.0f;

    struct PatchSpec {
        const char* name;
        float x, z, sx, sz;
        int shape, distrib;
        float nhsize;
    };
    const PatchSpec specs[] = {
        // The two food patches of `oracle/minitest_voff/run/normalized.wf` verbatim, geometry
        // included: CenterX 0.5, CenterZ 0.05 / 0.8, SizeX 1.0, SizeZ **0.1 / 0.4** (all
        // ratios of the domain). What is *not* the worldfile's: the counters/rate/energy below
        // are probe constants (`normalized.wf` uses the -1.0 "derive it" sentinels, resolved
        // earlier in the pipeline), so these fixtures replay the recorded patches' geometry,
        // shape, distribution, neighborhood size, `On` and `RemoveFood` — not their counters.
        {"recorded0", 0.5f, 0.05f, 1.0f, 0.1f, RECTANGULAR, UNIFORM, 10.0f},
        {"recorded1", 0.5f, 0.8f, 1.0f, 0.4f, RECTANGULAR, UNIFORM, 10.0f},
        {"rectLinear", 0.25f, 0.75f, 0.5f, 0.5f, RECTANGULAR, LINEAR, 2.5f},
        {"rectGauss", 0.1f, 0.2f, 0.3f, 0.4f, RECTANGULAR, GAUSSIAN, 1.0f},
        {"ellipseUniform", 0.5f, 0.5f, 1.0f, 1.0f, ELLIPTICAL, UNIFORM, 3.0f},
        {"ellipseLinear", 0.75f, 0.25f, 0.6f, 0.8f, ELLIPTICAL, LINEAR, 0.5f},
        {"ellipseGauss", 0.9f, 0.1f, 0.2f, 0.9f, ELLIPTICAL, GAUSSIAN, 0.0f},
    };

    for (unsigned s = 0; s < sizeof(specs) / sizeof(specs[0]); s++) {
        const PatchSpec& spec = specs[s];
        FoodPatch p;
        p.init(st, spec.x, spec.z, spec.sx, spec.sz, 0.1f, 500.0f, 90, 45, 90, 90, 0.25f,
               spec.shape, spec.distrib, spec.nhsize, true, false, &stage, &dm, 2);

        string pre = string("patch.") + spec.name;
        emitF32(pre + ".centerX", p.centerX);
        emitF32(pre + ".centerZ", p.centerZ);
        emitF32(pre + ".sizeX", p.sizeX);
        emitF32(pre + ".sizeZ", p.sizeZ);
        emitF32(pre + ".startX", p.startX);
        emitF32(pre + ".endX", p.endX);
        emitF32(pre + ".startZ", p.startZ);
        emitF32(pre + ".endZ", p.endZ);
        emitF32(pre + ".area", p.getArea());
        emitF32(pre + ".neighborhoodSize", p.neighborhoodSize);
        emitInt(pre + ".domainNumberOfParent", (long)p.domainNumberOfParent);
        emitInt(pre + ".agentInsideCount", (long)p.agentInsideCount);
        emitF32(pre + ".fraction", p.fraction);
        emitF32(pre + ".growthRate", p.growthRate);
        emitF32(pre + ".energy", p.energy);
        emitInt(pre + ".initFoodCount", (long)p.initFoodCount);
        emitInt(pre + ".minFoodCount", (long)p.minFoodCount);
        emitInt(pre + ".maxFoodCount", (long)p.maxFoodCount);
        emitInt(pre + ".maxFoodGrownCount", (long)p.maxFoodGrownCount);
        emitInt(pre + ".removeFood", (long)p.removeFood);
        emitInt(pre + ".on", (long)p.isOn());
        emitInt(pre + ".foodGrown", (long)p.initFoodGrown());

        const float pts[][2] = {
            {p.centerX, p.centerZ},
            {p.startX, p.startZ},
            {p.endX, p.endZ},
            {p.startX - 0.01f, p.centerZ},
            {p.centerX, p.endZ + 0.01f},
            {0.0f, 0.0f},
            {-12.5f, -25.0f},
        };
        for (unsigned k = 0; k < sizeof(pts) / sizeof(pts[0]); k++) {
            char key[160];
            snprintf(key, sizeof(key), "%s.inside.%u", pre.c_str(), k);
            emitBool(key, p.pointIsInside(pts[k][0], pts[k][1], 0.0f));
            snprintf(key, sizeof(key), "%s.insideNh.%u", pre.c_str(), k);
            emitBool(key, p.pointIsInside(pts[k][0], pts[k][1], p.neighborhoodSize));
        }

        p.resetAgentCounts();
        for (unsigned k = 0; k < sizeof(pts) / sizeof(pts[0]); k++) {
            p.checkIfAgentIsInside(pts[k][0], pts[k][1]);
            p.checkIfAgentIsInsideNeighborhood(pts[k][0], pts[k][1]);
        }
        emitInt(pre + ".agentInsideCount.afterProbe", (long)p.agentInsideCount);
        emitInt(pre + ".agentNeighborhoodCount.afterProbe", (long)p.agentNeighborhoodCount);

        // `setPoint` from a fixed stream: the *draw count* is part of the result, so a
        // rejection sampler that draws differently lands on a different value here.
        seedStream(97);
        for (int k = 0; k < 4; k++) {
            float px = 0.0f;
            float pz = 0.0f;
            p.setPoint(&px, &pz);
            char key[160];
            snprintf(key, sizeof(key), "%s.setPoint.%d.x", pre.c_str(), k);
            emitF32(key, px);
            snprintf(key, sizeof(key), "%s.setPoint.%d.z", pre.c_str(), k);
            emitF32(key, pz);
        }
    }

    // `setInitCounts`.
    {
        FoodPatch p;
        p.init(st, 0.5f, 0.05f, 1.0f, 1.0f, 0.1f, 500.0f, 90, 45, 90, 90, 0.25f, RECTANGULAR,
               UNIFORM, 10.0f, true, false, &stage, &dm, 0);
        p.setInitCounts(11, 22, 33, 44, 0.125f);
        emitInt("patch.setInitCounts.init", (long)p.initFoodCount);
        emitInt("patch.setInitCounts.min", (long)p.minFoodCount);
        emitInt("patch.setInitCounts.max", (long)p.maxFoodCount);
        emitInt("patch.setInitCounts.maxGrown", (long)p.maxFoodGrownCount);
        emitF32("patch.setInitCounts.fraction", p.fraction);
        emitInt("patch.onChanged.afterInit", (long)p.isOnChanged());
        p.endStep();
        emitInt("patch.onChanged.afterEndStep", (long)p.isOnChanged());
    }

    // `addFood`: the only place a live food object is constructed from a patch, including the
    // energy sentinel (-1.0 => random energy) and the foodCount/maxFoodCount gate.
    {
        FoodPatch p;
        p.init(st, 0.5f, 0.05f, 1.0f, 1.0f, 0.1f, -1.0f, 90, 45, 2, 90, 0.25f, RECTANGULAR,
               UNIFORM, 10.0f, true, false, &stage, &dm, 0);
        objectxsortedlist::gXSortedObjects.reset();

        seedStream(555);
        for (int k = 0; k < 4; k++) {
            food* f = p.addFood(11);
            char key[96];
            snprintf(key, sizeof(key), "foodpatch.addFood.%d.exists", k);
            emitBool(key, f != NULL);
            if (f) {
                snprintf(key, sizeof(key), "foodpatch.addFood.%d", k);
                dumpFood(key, f);
            }
        }
        emitInt("foodpatch.addFood.foodCount", (long)p.foodCount);
        emitInt("foodpatch.addFood.listFoodCount",
                (long)objectxsortedlist::gXSortedObjects.getCount(FOODTYPE));
        emitInt("foodpatch.addFood.stageCount", (long)cast.size());
    }

    // The brick patch: `addBricks` (which draws each brick's colour *and* the patch's point)
    // and `removeBricks` (the walk that removes through the list cursor).
    {
        BrickPatch bp;
        Color bc;
        bc.r = 0.125f;
        bc.g = 0.25f;
        bc.b = 0.5f;
        brick::gBrickHeight = 0.5f;
        bp.init(bc, 0.5f, 0.5f, 0.25f, 0.25f, 3, RECTANGULAR, UNIFORM, 1.0f, &stage, &dm, 0, true);

        objectxsortedlist::gXSortedObjects.reset();
        seedStream(2024);
        bp.updateOn();
        emitInt("brickpatch.brickCount", (long)bp.brickCount);
        emitInt("brickpatch.numBricks", (long)brick::GetNumBricks());
        emitInt("brickpatch.listBricks",
                (long)objectxsortedlist::gXSortedObjects.getCount(BRICKTYPE));
        emitInt("brickpatch.stageCount", (long)cast.size());
        {
            int idx = 0;
            gobject* o = NULL;
            objectxsortedlist::gXSortedObjects.reset();
            while (objectxsortedlist::gXSortedObjects.nextObj(BRICKTYPE, &o)) {
                char key[96];
                snprintf(key, sizeof(key), "brickpatch.brick.%d.x", idx);
                emitF32(key, o->x());
                snprintf(key, sizeof(key), "brickpatch.brick.%d.z", idx);
                emitF32(key, o->z());
                snprintf(key, sizeof(key), "brickpatch.brick.%d.typeNumber", idx);
                emitInt(key, (long)o->getTypeNumber());
                idx++;
            }
        }

        // rising edge already latched; the falling edge removes them
        bp.updateOn();  // no-op (on == onPrev)
        emitInt("brickpatch.afterSecondUpdate.listBricks",
                (long)objectxsortedlist::gXSortedObjects.getCount(BRICKTYPE));

        // Falling edge: `on` -> false, exactly as the dynamic property update would set it.
        gProbeBrickPatch = &bp;
        proplib::CppProperties_Update( nullptr );
        gProbeBrickPatch = nullptr;
        bp.updateOn();
        emitInt("brickpatch.afterOff.listBricks",
                (long)objectxsortedlist::gXSortedObjects.getCount(BRICKTYPE));
        emitInt("brickpatch.afterOff.stageCount", (long)cast.size());
        emitInt("brickpatch.afterOff.brickCount", (long)bp.brickCount);
        emitInt("brickpatch.afterOff.numBricks", (long)brick::GetNumBricks());

        // Rising again: a second batch of bricks (and a second set of draws).
        gProbeBrickPatch = &bp;
        proplib::CppProperties_Update( nullptr );
        gProbeBrickPatch = nullptr;
        bp.updateOn();
        emitInt("brickpatch.afterOn.listBricks",
                (long)objectxsortedlist::gXSortedObjects.getCount(BRICKTYPE));
        emitInt("brickpatch.afterOn.stageCount", (long)cast.size());
        emitInt("brickpatch.afterOn.numBricks", (long)brick::GetNumBricks());
    }
}

// ---------------------------------------------------------------------------
// barrier
// ---------------------------------------------------------------------------

static void dumpBarrier(const string& pre, barrier* b) {
    emitF32(pre + ".xmin", b->xmin());
    emitF32(pre + ".xmax", b->xmax());
    emitF32(pre + ".zmin", b->zmin());
    emitF32(pre + ".zmax", b->zmax());
    emitF32(pre + ".sina", b->sina());
    emitF32(pre + ".cosa", b->cosa());
    const float pts[][2] = {
        {0.0f, 0.0f},        {8.3325f, -12.0f},  {-3.25f, -25.0f}, {16.6675f, -2.5f},
        {1e6f, 1e6f},        {-1e6f, 1e6f},      {0.5f, -0.5f},    {-0.25f, 0.125f},
        {25.0f, -25.0f},     {12.5f, -1.0f},
    };
    for (unsigned k = 0; k < sizeof(pts) / sizeof(pts[0]); k++) {
        char key[160];
        snprintf(key, sizeof(key), "%s.dist.%u", pre.c_str(), k);
        emitF32(key, b->dist(pts[k][0], pts[k][1]));
    }
}

static void sectionBarrier() {
    printf("# section barrier\n");

    globals::worldsize = 25.0f;
    barrier::gBarrierHeight = 5.0f;
    barrier::gBarrierColor.r = 1.0f;
    barrier::gBarrierColor.g = 0.5f;
    barrier::gBarrierColor.b = 0.25f;
    barrier::gStickyBarriers = false;

    struct SegSpec {
        const char* name;
        float xa, za, xb, zb;
    };
    const SegSpec segs[] = {
        {"recorded0", 0.3333f, -1.0f, 0.3333f, -0.1f},
        {"recorded1", 0.6667f, -1.0f, 0.6667f, -0.1f},
        {"diag", 1.0f, 2.0f, 3.0f, 4.0f},
        {"diagRev", 3.0f, 4.0f, 1.0f, 2.0f},
        {"negSlope", -0.6f, 0.9f, -0.2f, -0.35f},
        {"degeneratePoint", 0.5f, 0.5f, 0.5f, 0.5f},
        {"degenerateZero", 0.0f, 0.0f, 0.0f, 0.0f},
        {"horizontal", 0.2f, -0.45f, 0.9f, -0.45f},
        {"horizontalRev", 0.9f, -0.45f, 0.2f, -0.45f},
        {"extreme", -1e6f, 1e6f, 1e6f, -1e6f},
    };

    // `srand(1)` from main seeds the three `rand()` draws each `gobject` construction makes;
    // pin the stream position so the port can reproduce it.
    for (int ratioMode = 0; ratioMode < 2; ratioMode++) {
        barrier::gRatioPositions = (ratioMode == 1);
        for (unsigned s = 0; s < sizeof(segs) / sizeof(segs[0]); s++) {
            barrier* b = new barrier();
            b->getPosition().xa = segs[s].xa;
            b->getPosition().za = segs[s].za;
            b->getPosition().xb = segs[s].xb;
            b->getPosition().zb = segs[s].zb;
            b->init();

            char pre[160];
            snprintf(pre, sizeof(pre), "barrier.%s.%s", ratioMode ? "ratio" : "abs", segs[s].name);
            dumpBarrier(pre, b);

            // `update()` is a no-op when the position did not change; flipping it recomputes,
            // which is how a dynamic barrier gets new geometry.
            b->getPosition().xa = segs[s].xb;
            b->getPosition().za = segs[s].zb;
            b->update();
            char key[160];
            snprintf(key, sizeof(key), "%s.afterUpdate.xmin", pre);
            emitF32(key, b->xmin());
            snprintf(key, sizeof(key), "%s.afterUpdate.dist.0", pre);
            emitF32(key, b->dist(0.0f, 0.0f));
        }
    }

    // The x-sorted barrier list, from a scripted insertion order.
    {
        barrier::gRatioPositions = false;
        barrier::gXSortedBarriers.clear();
        const float xmins[] = {5.0f, 3.0f, 5.0f, 1.0f, 4.0f, 0.0f, -2.0f, 5.0f};
        for (int i = 0; i < 8; i++) {
            barrier* b = new barrier();
            b->getPosition().xa = xmins[i];
            b->getPosition().za = -1.0f;
            b->getPosition().xb = xmins[i];
            b->getPosition().zb = -0.5f;
            b->init();
            barrier::gXSortedBarriers.add(b);
        }
        barrier::gXSortedBarriers.xsort();

        int idx = 0;
        barrier* b = NULL;
        barrier::gXSortedBarriers.reset();
        while (barrier::gXSortedBarriers.next(b)) {
            char key[96];
            snprintf(key, sizeof(key), "barrier.list.order.%d", idx);
            emitF32(key, b->xmin());
            idx++;
        }
        emitInt("barrier.list.count", (long)barrier::gXSortedBarriers.kount);
    }
    barrier::gRatioPositions = true;
}

// ---------------------------------------------------------------------------
// brick
// ---------------------------------------------------------------------------

static void sectionBrick() {
    printf("# section brick\n");

    globals::numEnergyTypes = 1;
    globals::worldsize = 25.0f;
    brick::gBrickHeight = 0.5f;
    brick::gCarryBrick2Energy = 0.05f;

    emitF32("brick.gBrickRadius.atSectionStart", brick::gBrickRadius);
    emitInt("brick.numBricks.atSectionStart", (long)brick::GetNumBricks());

    Color c;
    c.r = 0.5f;
    c.g = 0.25f;
    c.b = 1.0f;

    seedStream(31337);
    for (int i = 0; i < 3; i++) {
        brick* b = new brick(c);
        string key = "brick.drawn." + to_string(i);
        emitF32(key + ".x", b->x());
        emitF32(key + ".y", b->y());
        emitF32(key + ".z", b->z());
        emitF32(key + ".radius", b->radius());
        emitF32(key + ".lx", b->lx());
        emitF32(key + ".ly", b->ly());
        emitF32(key + ".lz", b->lz());
        emitInt(key + ".typeNumber", (long)b->getTypeNumber());
        emitInt(key + ".objType", (long)b->getType());
        emitF32(key + ".gBrickRadius", brick::gBrickRadius);
    }

    {
        brick* b = new brick(c, 3.5f, -4.25f);
        emitF32("brick.placed.x", b->x());
        emitF32("brick.placed.y", b->y());
        emitF32("brick.placed.z", b->z());
        emitF32("brick.placed.radius", b->radius());
        emitF32("brick.placed.lx", b->lx());
        emitInt("brick.placed.typeNumber", (long)b->getTypeNumber());
    }

    emitInt("brick.numBricks", (long)brick::GetNumBricks());

    // Height sensitivity of the derived radius (the class is initialised once, so this only
    // moves `gBrickHeight`; the radius of a *new* brick follows).
    brick::gBrickHeight = 1.5f;
    {
        brick* b = new brick(c, 1.0f, 1.0f);
        emitF32("brick.tall.radius", b->radius());
        emitF32("brick.tall.ly", b->ly());
    }
}

// ---------------------------------------------------------------------------
// the x-sorted object list
// ---------------------------------------------------------------------------

static void dumpListOrder(const string& pre, objectxsortedlist& list) {
    int idx = 0;
    gobject* o = NULL;
    list.reset();
    while (list.next(o)) {
        char key[96];
        snprintf(key, sizeof(key), "%s.%d", pre.c_str(), idx);
        char val[160];
        snprintf(val, sizeof(val), "%s#%lu@%.9g", OBJECTTYPE(o), o->getTypeNumber(), (double)o->x());
        emitStr(key, val);
        idx++;
    }
    emitInt(pre + ".count", (long)idx);
}

static void sectionObjectList() {
    printf("# section objectlist\n");

    globals::numEnergyTypes = 1;
    globals::worldsize = 25.0f;
    const FoodType* st = standardType();

    objectxsortedlist& list = objectxsortedlist::gXSortedObjects;
    // Drop whatever the earlier sections left behind (the probe owns the process).
    list.reset();
    {
        gobject* o = NULL;
        while (list.next(o)) list.removeCurrentObject();
    }

    const float positions[] = {8.0f, 2.0f, 8.0f, 0.5f, 19.0f, 2.0f, 12.0f};
    food* foods[7];
    for (int i = 0; i < 7; i++) {
        foods[i] = new food(st, 0, Energy(100.0f), positions[i], 0.0f);
        // `food::setradius()` (no-arg, protected) *hides* `gbox::setradius( float )`, so the
        // probe reaches the base overload explicitly to fix the insertion key; that is the
        // same public call the class hierarchy exposes.
        static_cast<gbox*>(foods[i])->setradius(0.25f * (float)(i + 1));
        list.add(foods[i]);
    }
    dumpListOrder("objectlist.afterAdds", list);
    emitInt("objectlist.count.food", (long)list.getCount(FOODTYPE));
    emitInt("objectlist.count.agent", (long)list.getCount(AGENTTYPE));
    emitInt("objectlist.count.brick", (long)list.getCount(BRICKTYPE));
    emitInt("objectlist.count.any", (long)list.getCount(ANYTYPE));

    // Remove one through its stored link, as `Simulation.cc` does for a dead agent.
    list.removeObjectWithLink(foods[2]);
    dumpListOrder("objectlist.afterRemoveWithLink", list);

    // And remove by walking, as `BrickPatch::removeBricks` does.
    list.reset();
    {
        gobject* o = NULL;
        while (list.nextObj(FOODTYPE, &o)) {
            if (o->x() == 8.0f) list.removeCurrentObject();
        }
    }
    dumpListOrder("objectlist.afterWalkRemove", list);
    emitInt("objectlist.count.food.final", (long)list.getCount(FOODTYPE));
    emitInt("objectlist.count.any.final", (long)list.getCount(ANYTYPE));
}

// ---------------------------------------------------------------------------
// the x-sorted object list: `sort()`
// ---------------------------------------------------------------------------
//
// `objectxsortedlist::sort()` is NOT dead code: `TSimulation::Interact()` calls it
// unconditionally on every step (`sim/Simulation.cc:1465`), and agents move every step, so
// the x-sorted keys are stale by the time it runs and the pass relocates nodes. `Interact`
// then walks the list to decide RNG draw order and `run/energy/food.txt` is a float sum in
// x-sorted order, so the order it leaves behind is on the recorded path. These fixtures are
// the only place that order is pinned against native.

/** The same rendering `dumpListOrder` uses, for a single object. */
static string objectLabel(gobject* o) {
    char val[160];
    snprintf(val, sizeof(val), "%s#%lu@%.9g", OBJECTTYPE(o), o->getTypeNumber(), (double)o->x());
    return string(val);
}

/**
 * The cursor `sort()` leaves behind — the next walker (`nextObj`/`next` in `Interact`)
 * resumes from exactly here, so it is part of the observable pass, not an internal detail.
 */
static void dumpCursor(const string& pre, objectxsortedlist& list) {
    gobject* c = NULL;
    bool hasCurrent = list.current(c) != 0;
    emitStr((pre + ".current").c_str(), hasCurrent ? objectLabel(c).c_str() : "<off-end>");
    emitBool((pre + ".currItemOffEnd").c_str(), list.getcurr() == 0);
    emitInt((pre + ".kount").c_str(), (long)list.count());
}

/** Drop everything the previous section left in the process-wide list. */
static void emptyObjectList() {
    objectxsortedlist& list = objectxsortedlist::gXSortedObjects;
    list.reset();
    gobject* o = NULL;
    while (list.next(o))
        list.removeCurrentObject();
}

/**
 * One `sort()` fixture: `n` food objects are inserted with ascending keys `1..n` (so `add`
 * leaves them in insertion order), then every key is rewritten **in place** — exactly what
 * one step of agent motion does to the list — and `sort()` runs twice. Both passes are
 * dumped, because native's technique "assumes that the list is almost entirely sorted at the
 * start": the second pass must be a no-op and must leave the same cursor behind.
 *
 * `xAfter[i]`/`radii[i]` give object `i`'s rewritten key (`key = x - radius`).
 */
static void sortFixture(const string& name, int n, const float* xAfter, const float* radii) {
    objectxsortedlist& list = objectxsortedlist::gXSortedObjects;
    const FoodType* st = standardType();
    emptyObjectList();

    food* objs[8];
    for (int i = 0; i < n; i++) {
        objs[i] = new food(st, 0, Energy(100.0f), (float)(i + 1), 0.0f);
        // `food::setradius()` (no-arg, protected) hides `gbox::setradius( float )`, so reach
        // the base overload explicitly — the same call the objectlist section above makes.
        static_cast<gbox*>(objs[i])->setradius(0.0f);
        list.add(objs[i]);
    }
    dumpListOrder(name + ".before", list);

    // The step's motion: rewrite every key in place, leaving the list order stale.
    for (int i = 0; i < n; i++) {
        static_cast<gbox*>(objs[i])->setradius(radii[i]);
        objs[i]->setx(xAfter[i]);
    }
    for (int i = 0; i < n; i++) {
        char key[96];
        snprintf(key, sizeof(key), "%s.staleKey.%d", name.c_str(), i);
        emitF32(key, objs[i]->x() - objs[i]->radius());
    }

    for (int pass = 1; pass <= 2; pass++) {
        list.sort();
        string pre = name + ".after" + to_string(pass);
        dumpCursor(pre, list);
        dumpListOrder(pre, list);
    }
    emitInt((name + ".count.food").c_str(), (long)list.getCount(FOODTYPE));
    emitInt((name + ".count.any").c_str(), (long)list.getCount(ANYTYPE));
}

static void sectionObjectListSort() {
    printf("# section objectlist sort\n");

    globals::numEnergyTypes = 1;
    globals::worldsize = 25.0f;

    // A. One node moves back past three others: the minimal relocation.
    {
        const float x[7] = {5.0f, 1.0f, 2.0f, 7.0f, 3.0f, 0.5f, 4.0f};
        const float r[7] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
        sortFixture("objectlist.sort.a", 7, x, r);
    }

    // B. Fully reversed keys: every node relocates, and the deepest one runs off the front of
    // the list (native's `else this->insert( link )` — a new head).
    {
        const float x[7] = {7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f};
        const float r[7] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
        sortFixture("objectlist.sort.b", 7, x, r);
    }

    // C. Non-zero, non-uniform radii, so the key (`x - radius`) and `x` order differently —
    // the pass must sort on the key the insertion also used, not on `x`.
    {
        const float x[6] = {2.0f, 6.0f, 1.0f, 4.0f, 7.0f, 3.0f};
        const float r[6] = {1.0f, 0.5f, 0.25f, 0.75f, 0.5f, 1.5f};
        sortFixture("objectlist.sort.c", 6, x, r);
    }

    // D. A realistic small motion: two neighbours swap, everything else stays. One relocation
    // that is not adjacent to the front.
    {
        const float x[7] = {1.0f, 3.0f, 2.0f, 4.0f, 5.0f, 7.0f, 6.0f};
        const float r[7] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
        sortFixture("objectlist.sort.d", 7, x, r);
    }

    // E. Already sorted at the strict key: the pass must relocate nothing and still leave
    // native's cursor.
    {
        const float x[7] = {1.0f, 2.0f, 2.5f, 4.0f, 5.0f, 6.0f, 7.0f};
        const float r[7] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
        sortFixture("objectlist.sort.e", 7, x, r);
    }

    // F. Degenerate sizes: the empty list and a one-element list.
    sortFixture("objectlist.sort.empty", 0, NULL, NULL);
    {
        const float x[1] = {4.0f};
        const float r[1] = {0.0f};
        sortFixture("objectlist.sort.one", 1, x, r);
    }
}

// ---------------------------------------------------------------------------
// the x-sorted object list: the insertion key is the *accessor* `x - radius()`
// ---------------------------------------------------------------------------
//
// `objectxsortedlist` spells its key `a->x() - a->radius()` — the gobject *method*, not the
// `fRadius` storage (`gobject.h:196`; `objectxsortedlist.cc`'s `add()` and `sort()`). That is
// load-bearing, not stylistic: the list's elements are `gobject*` and the accessor is what
// they are asked for, so the list accepts any object that answers it — which is exactly what
// lane L8's `agent` is (a `gpolyobj` with private radius state and a `radius()` method).
//
// The fixtures below exercise that shape: objects of a bare `gobject` subclass whose radius is
// supplied **through the accessor** (`setradius()`/`radius()`), with non-uniform radii and an
// insertion order whose key order differs from its `x` order. A port that reads a radius
// *field* instead computes `NaN` for such an object, `NaN < NaN` is false, `add()` degenerates
// to an append and `sort()` never relocates a node — the list silently drops to insertion
// order with no error anywhere. That is the defect these pins exist for.

/** A `gobject` whose radius arrives through the accessor — no `gbox` in the picture. */
class ObjectListAccessorObject : public gobject {
public:
    ObjectListAccessorObject(float x, float r, unsigned long number) {
        setType(AGENTTYPE);
        setTypeNumber(number);
        setx(x);
        setradius(r);
    }
};

static void sectionObjectListAccessor() {
    printf("# section objectlist accessor\n");

    globals::numEnergyTypes = 1;
    globals::worldsize = 25.0f;

    objectxsortedlist& list = objectxsortedlist::gXSortedObjects;
    emptyObjectList();

    // (a) `add()`: six accessor-radius objects. Keys are 4.5, 0.75, 1.5, -1.5, 7.875, 2.0 in
    // insertion order; the `x` order (0.5, 1, 2, 3, 5, 8) is a *different* order.
    {
        const float xs[6] = {5.0f, 1.0f, 3.0f, 0.5f, 8.0f, 2.0f};
        const float rs[6] = {0.5f, 0.25f, 1.5f, 2.0f, 0.125f, 0.0f};
        for (int i = 0; i < 6; i++)
            list.add(new ObjectListAccessorObject(xs[i], rs[i], (unsigned long)(i + 1)));
    }
    dumpListOrder("objectlist.accessor.adds", list);
    emitInt("objectlist.accessor.count.agent", (long)list.getCount(AGENTTYPE));
    emitInt("objectlist.accessor.count.any", (long)list.getCount(ANYTYPE));

    // The keys themselves, in list order, read the way the list reads them.
    list.reset();
    {
        gobject* o = NULL;
        int i = 0;
        while (list.next(o)) {
            char key[96];
            snprintf(key, sizeof(key), "objectlist.accessor.key.%d", i);
            emitF32(key, o->x() - o->radius());
            i++;
        }
    }

    // (b) `sort()`: six objects inserted with ascending keys 1..6 (so `add()` leaves them in
    // insertion order), then every key rewritten in place through the accessor — the stale-key
    // state one step of motion leaves behind — then two passes, as in `sortFixture`.
    emptyObjectList();
    {
        ObjectListAccessorObject* objs[6];
        for (int i = 0; i < 6; i++) {
            objs[i] = new ObjectListAccessorObject((float)(i + 1), 0.0f, (unsigned long)(i + 1));
            list.add(objs[i]);
        }
        dumpListOrder("objectlist.accessor.sort.before", list);

        const float xAfter[6] = {5.0f, 1.0f, 2.0f, 7.0f, 3.0f, 0.5f};
        const float rAfter[6] = {0.5f, 0.75f, 0.0f, 1.25f, 2.0f, 0.25f};
        for (int i = 0; i < 6; i++) {
            objs[i]->setradius(rAfter[i]);
            objs[i]->setx(xAfter[i]);
        }
        for (int i = 0; i < 6; i++) {
            char key[96];
            snprintf(key, sizeof(key), "objectlist.accessor.sort.staleKey.%d", i);
            emitF32(key, objs[i]->x() - objs[i]->radius());
        }

        for (int pass = 1; pass <= 2; pass++) {
            list.sort();
            string pre = "objectlist.accessor.sort.after" + to_string(pass);
            dumpCursor(pre, list);
            dumpListOrder(pre, list);
        }
        emitInt("objectlist.accessor.sort.count.agent", (long)list.getCount(AGENTTYPE));
        emitInt("objectlist.accessor.sort.count.any", (long)list.getCount(ANYTYPE));
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    srand(1);

    emitStr("probe.mode", "env");
    sectionEnergy();
    sectionFoodType();
    sectionFood();
    sectionPatch();
    sectionBarrier();
    sectionBrick();
    sectionObjectList();
    sectionObjectListSort();
    sectionObjectListAccessor();

    return 0;
}
