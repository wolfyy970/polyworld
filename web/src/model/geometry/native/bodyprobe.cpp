/*
 * bodyprobe — lane L15/W1e: the *agent body mesh* goldens, taken from the native code path.
 *
 * Everything in `src/model/geometry/golden/nativeBodyMesh.ts` is produced by this program:
 *
 *   mesh    the real `etc/objects/agent.obj` loaded through the real
 *           `Resources::loadPolygons` / `operator>>( const char*, gpolyobj& )` (the loader
 *           `agent::agentinit` calls), its per-polygon vertex bits, and the bounding box and
 *           radius `gpolyobj::setlen()`/`setradius()` derive from it.
 *   body    per agent of a *recorded scenario*: the `Size` and `MaxSpeed` genes read out of
 *           the recorded `genome/agents/genome_<n>.txt.gz` by the real `Genome::load()`, and
 *           the resulting `fLengthX`, `fLengthZ`, bounding box and collision radius produced
 *           by the real `agent::SetGeometry()` (clonegeom -> the in-place vertex scaling ->
 *           `gpolyobj::setlen()` -> the virtual `agent::setradius()`).
 *
 * PORT-NOTE(W1e/body-probe-is-oracle-tooling): this file is oracle tooling, not model code.
 * It is the only place in the lane that links the native tree, nothing under `src/model/**`
 * imports it, and it never writes inside the native tree or `oracle/**` (it only *reads*
 * `etc/objects/agent.obj`, `etc/worldfile.wfs` and the recorded goldens handed to it on the
 * command line). The native tree's `run/` is not touched.
 *
 * Build/run through `bodyprobe.sh` (it knows the include paths, the SDK's OpenGL headers, the
 * rpath of the native tree and how the recorded scenarios are registered).
 *
 *   bodyprobe body <out> <scenario-run-dir> <worldfile> [Key=Value ...]
 *
 *   cwd must be the native tree: `./etc/worldfile.wfs` and `./etc/objects/agent.obj` are
 *   resolved relative to it, exactly as the oracle binary resolves them.
 *
 * `#define protected public` is deliberate and scoped to the native headers: the pieces that
 * make the radius (agent::SetGeometry, geneCache, fLengthX/fLengthZ) are protected members,
 * and the probe must call the *shipped* code rather than a copy of it.
 */

#include <dirent.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define protected public
#include "agent/agent.h"
#undef protected

#include "brain/Brain.h"
#include "genome/GenomeSchema.h"
#include "genome/GenomeUtil.h"
#include "graphics/gpolygon.h"
#include "proplib/proplib.h"
#include "sim/globals.h"
#include "utils/AbstractFile.h"
#include "utils/Resources.h"

// ---------------------------------------------------------------------------
// bit-exact emission (Floats are printed as their raw IEEE-754 bits as well as decimal:
// the port's test compares bits, so a 1-ulp divergence cannot hide.)
// ---------------------------------------------------------------------------

static FILE *gOut = NULL;

static uint32_t fbits(float v)
{
    uint32_t u;
    memcpy(&u, &v, sizeof(u));
    return u;
}

static void printF32(const char *kind, const char *key, const float *v, int n)
{
    fprintf(gOut, "%s %s", kind, key);
    for (int i = 0; i < n; i++)
        fprintf(gOut, " %.9g:%08x", (double)v[i], (unsigned)fbits(v[i]));
    fprintf(gOut, "\n");
}

static void printF32_1(const char *kind, const char *key, float v)
{
    printF32(kind, key, &v, 1);
}

// ---------------------------------------------------------------------------
// mesh: the real loader over the real file
// ---------------------------------------------------------------------------

static void probeMesh()
{
    gpolyobj tmpl;
    Resources::loadPolygons(&tmpl, "agent");

    fprintf(gOut, "mesh numPolygons %ld\n", tmpl.numPolygons());

    long points = 0;
    for (long i = 0; i < tmpl.numPolygons(); i++)
    {
        const opoly &p = tmpl.fPolygon[i];
        fprintf(gOut, "mesh polygon.%ld.numPoints %ld\n", i, p.fNumPoints);
        fprintf(gOut, "mesh polygon.%ld.vertices", i);
        for (long j = 0; j < p.fNumPoints * 3; j++)
            fprintf(gOut, " %.9g:%08x", (double)p.fVertices[j], (unsigned)fbits(p.fVertices[j]));
        fprintf(gOut, "\n");
        points += p.fNumPoints;
    }
    fprintf(gOut, "mesh numPoints %ld\n", points);

    float len[3] = { tmpl.lx(), tmpl.ly(), tmpl.lz() };
    printF32("f32", "mesh.length", len, 3);
    printF32_1("f32", "mesh.radius", tmpl.radius());
    printF32_1("f32", "mesh.radiusscale", tmpl.radiusscale());
}

// ---------------------------------------------------------------------------
// agent bodies: the recorded scenario's genomes through the real geometry path
// ---------------------------------------------------------------------------

static bool numberFromGenomePath(const std::string &path, unsigned long *out)
{
    const std::string prefix = "genome_";
    const std::string suffix = ".txt.gz";
    const size_t at = path.find(prefix);
    if (at == std::string::npos)
        return false;
    const size_t start = at + prefix.size();
    if (path.size() < start + suffix.size() || path.compare(path.size() - suffix.size(), suffix.size(), suffix) != 0)
        return false;
    const std::string digits = path.substr(start, path.size() - suffix.size() - start);
    if (digits.empty())
        return false;
    for (size_t i = 0; i < digits.size(); i++)
        if (!isdigit((unsigned char)digits[i]))
            return false;
    *out = strtoul(digits.c_str(), NULL, 10);
    return true;
}

static std::vector<std::string> genomeFiles(const std::string &dir)
{
    std::vector<std::string> out;
    DIR *d = opendir(dir.c_str());
    if (d == NULL)
    {
        fprintf(stderr, "bodyprobe: cannot open %s\n", dir.c_str());
        exit(2);
    }
    struct dirent *e;
    while ((e = readdir(d)) != NULL)
    {
        std::string name = e->d_name;
        if (name.size() > 3 && name.compare(name.size() - 3, 3, ".gz") == 0)
            out.push_back(dir + "/" + name);
    }
    closedir(d);
    std::sort(out.begin(), out.end());
    return out;
}

static void probeBodies(const char *runDir, const char *worldfile, int nparams, char **params)
{
    // The same pipeline `TSimulation::processWorldFile`'s caller uses
    // (Simulation.cc:269-309), in the same order.
    proplib::DocumentBuilder builder;
    proplib::SchemaDocument *schema = builder.buildSchemaDocument("./etc/worldfile.wfs");

    proplib::ParameterMap parameters;
    for (int i = 0; i < nparams; i++)
    {
        const std::string pair = params[i];
        const size_t eq = pair.find('=');
        if (eq == std::string::npos)
        {
            fprintf(stderr, "bodyprobe: parameters must be Key=Value, got '%s'\n", pair.c_str());
            exit(2);
        }
        parameters[pair.substr(0, eq)] = pair.substr(eq + 1);
    }

    proplib::Document *doc = builder.buildWorldfileDocument(schema, worldfile, parameters);
    schema->apply(doc);

    agent::processWorldfile(*doc);
    genome::GenomeSchema::processWorldfile(*doc);
    Brain::processWorldfile(*doc);
    Brain::init();
    agent::agentinit();
    genome::GenomeUtil::createSchema();

    fprintf(gOut, "str worldfile %s\n", worldfile);
    printF32_1("f32", "config.agentHeight", agent::config.agentHeight);
    printF32_1("f32", "config.minAgentSize", agent::config.minAgentSize);
    printF32_1("f32", "config.maxAgentSize", agent::config.maxAgentSize);
    printF32_1("f32", "config.minmaxspeed", agent::config.minmaxspeed);
    printF32_1("f32", "config.maxmaxspeed", agent::config.maxmaxspeed);
    printF32_1("f32", "config.maxRadius", agent::config.maxRadius);
    printF32_1("f32", "globals.worldsize", (float)globals::worldsize);

    // Cross-check the template the agents clone from: agentinit() has just loaded it.
    gpolyobj *agentobj = agent::GetAgentObj();
    const long templatePolys = agentobj->numPolygons();
    fprintf(gOut, "mesh template.numPolygons %ld\n", templatePolys);
    float tlen[3] = { agentobj->lx(), agentobj->ly(), agentobj->lz() };
    printF32("f32", "mesh.template.length", tlen, 3);
    printF32_1("f32", "mesh.template.radius", agentobj->radius());

    // One real `agent`. It is constructed exactly as `agent::getfreeagent` constructs one
    // (minus the simulation and the stage, which the geometry path never reads).
    agent a(NULL, NULL);

    const std::vector<std::string> files = genomeFiles(std::string(runDir) + "/genome/agents");
    fprintf(gOut, "mesh count %zu\n", files.size());
    for (size_t i = 0; i < files.size(); i++)
    {
        unsigned long number = 0;
        if (!numberFromGenomePath(files[i], &number))
        {
            fprintf(stderr, "bodyprobe: unexpected genome file name %s\n", files[i].c_str());
            exit(2);
        }

        genome::Genome *g = genome::GenomeUtil::createGenome(false);
        AbstractFile *in = AbstractFile::open(files[i].c_str(), "r");
        if (in == NULL)
        {
            fprintf(stderr, "bodyprobe: cannot open %s\n", files[i].c_str());
            exit(2);
        }
        g->load(in);
        delete in;

        // `agent::InitGeneCache()`'s two reads that SetGeometry consumes (agent.cc:1005-1010
        // reads `Size()` == geneCache.size and `geneCache.maxSpeed`).
        a.geneCache.size = g->get("Size");
        a.geneCache.maxSpeed = g->get("MaxSpeed");

        a.SetGeometry();

        fprintf(gOut, "body number %lu", number);
        fprintf(gOut, " size %.9g:%08x", (double)a.geneCache.size, (unsigned)fbits(a.geneCache.size));
        fprintf(gOut, " maxSpeed %.9g:%08x", (double)a.geneCache.maxSpeed, (unsigned)fbits(a.geneCache.maxSpeed));
        fprintf(gOut, " lengthX %.9g:%08x", (double)a.fLengthX, (unsigned)fbits(a.fLengthX));
        fprintf(gOut, " lengthZ %.9g:%08x", (double)a.fLengthZ, (unsigned)fbits(a.fLengthZ));
        fprintf(gOut, " lx %.9g:%08x", (double)a.lx(), (unsigned)fbits(a.lx()));
        fprintf(gOut, " ly %.9g:%08x", (double)a.ly(), (unsigned)fbits(a.ly()));
        fprintf(gOut, " lz %.9g:%08x", (double)a.lz(), (unsigned)fbits(a.lz()));
        fprintf(gOut, " radius %.9g:%08x", (double)a.radius(), (unsigned)fbits(a.radius()));
        fprintf(gOut, " carryRadius %.9g:%08x", (double)a.CarryRadius(), (unsigned)fbits(a.CarryRadius()));
        fprintf(gOut, "\n");

        delete g;
    }
}

// ---------------------------------------------------------------------------

int main(int argc, char **argv)
{
    if (argc < 2)
    {
        fprintf(stderr,
                "usage: bodyprobe mesh <out>\n"
                "       bodyprobe body <out> <scenario-run-dir> <worldfile> [Key=Value ...]\n");
        return 2;
    }

    const std::string mode = argv[1];
    if (argc < 3)
    {
        fprintf(stderr, "bodyprobe: mode %s needs an output path\n", mode.c_str());
        return 2;
    }

    gOut = fopen(argv[2], "w");
    if (!gOut)
    {
        fprintf(stderr, "bodyprobe: cannot write %s\n", argv[2]);
        return 2;
    }

    // Native `proplib::Interpreter::init()` starts the expression evaluator (python); without
    // it every `getEvaledString()` on a dynamic property dereferences a null process. The
    // simulation calls it on startup, so the probe must too.
    proplib::Interpreter::init();

    if (mode == "mesh")
    {
        probeMesh();
    }
    else if (mode == "body")
    {
        if (argc < 5)
        {
            fprintf(stderr, "bodyprobe: body needs <run-dir> <worldfile>\n");
            return 2;
        }
        probeBodies(argv[3], argv[4], argc - 5, argv + 5);
    }
    else
    {
        fprintf(stderr, "bodyprobe: unknown mode %s\n", mode.c_str());
        return 2;
    }

    fclose(gOut);
    gOut = NULL;

    // Shut the evaluator's python child down; without this the interpreter holds the
    // inherited stdout pipe open and a caller reading the probe's output waits forever.
    proplib::Interpreter::dispose();

    return 0;
}
