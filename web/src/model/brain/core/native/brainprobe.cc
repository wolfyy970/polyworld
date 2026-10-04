// Lane L6 (brain core) — native differential probe.
//
// The oracle for this lane is `run/brain/{anatomy,function,synapses}/**`, but those files can
// only be produced by a whole simulation (lane L11) driven by a genome (lane L5). Neither
// exists yet, so this probe answers the question the lane can actually answer today:
//
//     does the TypeScript port of the neuron models and of the brain's dump code produce the
//     same bytes as the oracle's own code, for the same brain?
//
// It links against the oracle's `libpolyworld.dylib` (the real `FiringRateModel`,
// `SpikingModel`, `Brain::dumpAnatomical/startFunctional/writeFunctional/dumpSynapses`,
// `BaseNeuronModel`) and drives them with a synthetic brain described in a text spec. The
// vitest side (`tests/brain-core.test.ts`) rebuilds exactly that brain from the spec, runs
// its own port, and diffs the four output files byte-for-byte plus the raw bit patterns of
// every activation. Any difference in the update maths, in the learning rule, in the
// activation-buffer swap, in the RNG draw count, or in `%g`/`%hd`/`%+06.4f` formatting shows
// up as a diff.
//
// The spec generator is a private LCG, not a Polyworld RNG, so the spec is reproducible
// without depending on the model's streams; the *model's* streams are then exercised on top
// of it (the spiking model draws `drand48` per input neuron per brain step).
//
// Usage: brainprobe <models|format|math|growexpr> <outdir>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

#include "brain/Brain.h"
#include "brain/FiringRateModel.h"
#include "brain/NervousSystem.h"
#include "brain/SpikingModel.h"
#include "sim/Simulation.h"
#include "utils/AbstractFile.h"
#include "utils/misc.h"

// ---------------------------------------------------------------------------
// deterministic, model-independent spec generator
// ---------------------------------------------------------------------------
static unsigned long long g_lcg = 0x0123456789abcdefULL;

static double u01()
{
	g_lcg = g_lcg * 6364136223846793005ULL + 1442695040888963407ULL;
	return double((g_lcg >> 11) & ((1ULL << 53) - 1)) / double(1ULL << 53);
}

static double uniform(double lo, double hi)
{
	return lo + u01() * (hi - lo);
}

static int randint(int lo, int hi) // inclusive
{
	return lo + int(u01() * double(hi - lo + 1));
}

// ---------------------------------------------------------------------------
// nervous system / brain shims
//
// `NervousSystem` leaves `b` unset until `grow()`; the models reach their brain through
// `cns->getBrain()->isFrozen()`, so the probe wires one in explicitly, exactly as
// `NervousSystem::grow` would.
// ---------------------------------------------------------------------------
class ProbeCns : public NervousSystem
{
 public:
	ProbeCns() : NervousSystem() { b = NULL; }
	void setBrain(Brain *brain) { b = brain; }
};

class ProbeBrain : public Brain
{
 public:
	ProbeBrain(NervousSystem *cns) : Brain(cns) {}
	void setDims(const NeuronModel::Dimensions &d) { _dims = d; }
	void setNet(NeuronModel *net) { _neuralnet = net; }
};

// ---------------------------------------------------------------------------
// brain spec
// ---------------------------------------------------------------------------
struct NeuronSpec
{
	float bias, tau, gain;
	float spikingA, spikingB, spikingC, spikingD;
	long start, end;
};

struct SynapseSpec
{
	short from, to;
	float efficacy, lrate;
};

struct Spec
{
	NeuronModel::Dimensions dims;
	std::vector<NeuronSpec> neurons;
	std::vector<SynapseSpec> synapses;
	std::vector<std::vector<double> > inputs; // per step, numInputNeurons values
	float logisticSlope;
	float maxWeight;
	float maxBias;
	bool enableLearning;
	float minlrate, maxlrate, decayRate;
	float scaleLatestSpikes;
	unsigned int drandSeed;
	int spikingParams; // 1 = use the gene-supplied per-neuron parameters
};

static void buildSpec(Spec &spec, bool spiking)
{
	spec.dims = NeuronModel::Dimensions();
	const int numInput = 7;
	const int numOutput = 4;
	const int numInternal = spiking ? 6 : 5;
	const int numNeurons = numInput + numOutput + numInternal;

	spec.dims.numInputNeurons = numInput;
	spec.dims.numOutputNeurons = numOutput;
	spec.dims.numNeurons = numNeurons;

	spec.neurons.resize(numNeurons);
	spec.synapses.clear();

	// input neurons: the growth path sets zeroed attributes
	for (int i = 0; i < numInput; i++)
	{
		NeuronSpec n;
		memset(&n, 0, sizeof(n));
		spec.neurons[i] = n;
	}

	// outputs and internals: 2 and 3 incoming synapses respectively, laid down in
	// to-neuron order (the order `BaseNeuronModel::setSynapses` relies on)
	for (int i = numInput; i < numNeurons; i++)
	{
		NeuronSpec n;
		n.bias = float(uniform(-2.0, 2.0));
		n.tau = float(uniform(0.01, 1.0));
		n.gain = float(uniform(0.1, 10.0));
		n.spikingA = float(uniform(0.001, 0.2));
		n.spikingB = float(uniform(0.01, 0.3));
		n.spikingC = float(uniform(-80, -30));
		n.spikingD = float(uniform(0.1, 10));
		n.start = long(spec.synapses.size());
		int count = (i < numInput + numOutput) ? 2 : 3;
		std::vector<int> froms;
		for (int k = 0; k < count; k++)
		{
			int from;
			do
			{
				from = randint(0, numNeurons - 1);
			} while (from == i || (k > 0 && from == froms[k - 1]));
			froms.push_back(from);

			SynapseSpec s;
			s.from = short(from);
			s.to = short(i);
			// a mix of excitatory and inhibitory efficacies and rates
			double mag = uniform(0.05, 4.0);
			s.efficacy = float(u01() < 0.35 ? -mag : mag);
			s.lrate = float(u01() < 0.5 ? uniform(0.0, 0.1) : -uniform(0.0, 0.1));
			spec.synapses.push_back(s);
		}
		n.end = long(spec.synapses.size());
		spec.neurons[i] = n;
	}

	spec.dims.numSynapses = long(spec.synapses.size());

	const int numSteps = 6;
	for (int step = 0; step < numSteps; step++)
	{
		std::vector<double> values;
		for (int i = 0; i < numInput; i++) values.push_back(uniform(0.0, 1.0));
		spec.inputs.push_back(values);
	}

	spec.logisticSlope = float(uniform(0.5, 3.0));
	spec.maxWeight = 8.0f;
	spec.maxBias = 8.0f;
	spec.enableLearning = true;
	spec.minlrate = 0.0f;
	spec.maxlrate = 0.1f;
	spec.decayRate = 0.99f;
	spec.scaleLatestSpikes = 0.8f;
	spec.drandSeed = 20260928u;
	spec.spikingParams = 1;
}

static void writeSpec(FILE *f, const Spec &spec, const char *modelName, bool tauGain, bool frozen)
{
	fprintf(f, "model %s\n", modelName);
	fprintf(f, "tauGain %d\n", tauGain ? 1 : 0);
	fprintf(f, "frozen %d\n", frozen ? 1 : 0);
	fprintf(f, "logisticSlope %.9g\n", spec.logisticSlope);
	fprintf(f, "maxWeight %.9g\n", spec.maxWeight);
	fprintf(f, "maxBias %.9g\n", spec.maxBias);
	fprintf(f, "enableLearning %d\n", spec.enableLearning ? 1 : 0);
	fprintf(f, "minlrate %.9g\n", spec.minlrate);
	fprintf(f, "maxlrate %.9g\n", spec.maxlrate);
	fprintf(f, "decayRate %.9g\n", spec.decayRate);
	fprintf(f, "scaleLatestSpikes %.9g\n", spec.scaleLatestSpikes);
	fprintf(f, "drandSeed %u\n", spec.drandSeed);
	fprintf(f, "spikingParams %d\n", spec.spikingParams);
	fprintf(f, "dims %d %d %d %ld\n", spec.dims.numNeurons, spec.dims.numInputNeurons,
			spec.dims.numOutputNeurons, spec.dims.numSynapses);
	for (size_t i = 0; i < spec.neurons.size(); i++)
	{
		const NeuronSpec &n = spec.neurons[i];
		fprintf(f, "neuron %zu %.9g %.9g %.9g %.9g %.9g %.9g %.9g %ld %ld\n", i,
				n.bias, n.tau, n.gain, n.spikingA, n.spikingB, n.spikingC, n.spikingD, n.start, n.end);
	}
	for (size_t k = 0; k < spec.synapses.size(); k++)
	{
		const SynapseSpec &s = spec.synapses[k];
		fprintf(f, "synapse %zu %d %d %.9g %.9g\n", k, s.from, s.to, s.efficacy, s.lrate);
	}
	for (size_t step = 0; step < spec.inputs.size(); step++)
	{
		fprintf(f, "input %zu", step);
		for (size_t i = 0; i < spec.inputs[step].size(); i++) fprintf(f, " %.17g", spec.inputs[step][i]);
		fprintf(f, "\n");
	}
}

// ---------------------------------------------------------------------------
// models mode
// ---------------------------------------------------------------------------
static void printBits(FILE *f, const char *label, double v)
{
	unsigned long long bits;
	memcpy(&bits, &v, sizeof(bits));
	fprintf(f, "%s %016llx\n", label, bits);
}

static void initNeuronAttrs(NeuronModel *model, const Spec &spec, bool spiking, bool geneParams)
{
	NeuronModel::Dimensions dims = spec.dims;

	if (spiking)
	{
		SpikingModel__NeuronAttrs attrs;
		for (int i = 0; i < dims.numInputNeurons; i++)
		{
			attrs.bias = 0.0f;
			attrs.SpikingParameter_a = 0;
			attrs.SpikingParameter_b = 0;
			attrs.SpikingParameter_c = 0;
			attrs.SpikingParameter_d = 0;
			model->set_neuron(i, &attrs);
		}
		for (int i = dims.numInputNeurons; i < dims.numNeurons; i++)
		{
			const NeuronSpec &n = spec.neurons[i];
			attrs.bias = n.bias;
			if (geneParams)
			{
				attrs.SpikingParameter_a = n.spikingA;
				attrs.SpikingParameter_b = n.spikingB;
				attrs.SpikingParameter_c = n.spikingC;
				attrs.SpikingParameter_d = n.spikingD;
			}
			else
			{
				attrs.SpikingParameter_a = 0.02;
				attrs.SpikingParameter_b = 0.2;
				attrs.SpikingParameter_c = -65;
				attrs.SpikingParameter_d = 6;
			}
			model->set_neuron(i, &attrs, (int) n.start);
			model->set_neuron_endsynapses(i, (int) n.end);
		}
	}
	else
	{
		FiringRateModel__NeuronAttrs attrs;
		for (int i = 0; i < dims.numInputNeurons; i++)
		{
			attrs.bias = 0.0f;
			attrs.tau = 0.0f;
			attrs.gain = 0.0f;
			model->set_neuron(i, &attrs);
		}
		for (int i = dims.numInputNeurons; i < dims.numNeurons; i++)
		{
			const NeuronSpec &n = spec.neurons[i];
			attrs.bias = n.bias;
			attrs.tau = n.tau;
			attrs.gain = n.gain;
			model->set_neuron(i, &attrs, (int) n.start);
			model->set_neuron_endsynapses(i, (int) n.end);
		}
	}

	for (size_t k = 0; k < spec.synapses.size(); k++)
	{
		const SynapseSpec &s = spec.synapses[k];
		model->set_synapse((int) k, s.from, s.to, s.efficacy, s.lrate);
	}
}

static int runModels(const std::string &outdir)
{
	for (int variant = 0; variant < 3; variant++)
	{
		const bool spiking = (variant == 2);
		const bool tauGain = (variant == 1);
		const bool frozen = (variant == 1);

		Spec spec;
		buildSpec(spec, spiking);

		// configure the model exactly as Brain::processWorldfile/init would
		Brain::config.neuronModel = spiking ? Brain::Configuration::SPIKING
										   : (tauGain ? Brain::Configuration::TAU_GAIN
													  : Brain::Configuration::FIRING_RATE);
		Brain::config.logisticSlope = spec.logisticSlope;
		Brain::config.maxWeight = spec.maxWeight;
		Brain::config.maxbias = spec.maxBias;
		Brain::config.enableLearning = spec.enableLearning;
		Brain::config.minlrate = spec.minlrate;
		Brain::config.maxlrate = spec.maxlrate;
		Brain::config.decayRate = spec.decayRate;
		Brain::config.learningMode = Brain::Configuration::LEARN_ALL;

		ProbeCns cns;
		ProbeBrain *brain = new ProbeBrain(&cns);
		cns.setBrain(brain);
		brain->setDims(spec.dims);
		if (frozen) brain->freeze();

		NeuronModel *model = spiking ? (NeuronModel *) new SpikingModel(&cns, spec.scaleLatestSpikes)
									 : (NeuronModel *) new FiringRateModel(&cns);
		brain->setNet(model);

		model->init(&spec.dims, 0.1);
		initNeuronAttrs(model, spec, spiking, spec.spikingParams == 1);

		const char *tag = spiking ? "spiking" : (tauGain ? "taugain" : "firingrate");
		char path[1024];

		snprintf(path, sizeof(path), "%s/spec.%s.txt", outdir.c_str(), tag);
		FILE *specFile = fopen(path, "w");
		writeSpec(specFile, spec, tag, tauGain, frozen);
		fclose(specFile);

		// ---- the drand48 stream the model will draw from (GLOBAL role) ----
		snprintf(path, sizeof(path), "%s/summary.%s.txt", outdir.c_str(), tag);
		FILE *summary = fopen(path, "w");
		fprintf(summary, "energyUse %.9g\n", brain->getEnergyUse());
		srand48((long) spec.drandSeed);
		fprintf(summary, "drand48");
		for (int i = 0; i < 8; i++) fprintf(summary, " %.17g", drand48());
		fprintf(summary, "\n");

		// ---- functional recording (native Brain::startFunctional / writeFunctional) ----
		TSimulation::fStep = 13;
		snprintf(path, sizeof(path), "%s/function.%s.txt", outdir.c_str(), tag);
		AbstractFile *functional = AbstractFile::open(AbstractFile::TYPE_FILE, path, "w");
		brain->startFunctional(functional, 42);

		srand48((long) spec.drandSeed);
		for (size_t step = 0; step < spec.inputs.size(); step++)
		{
			const std::vector<double> &values = spec.inputs[step];
			brain->setActivations(const_cast<double *>(&values[0]), 0, (int) values.size());
			brain->update(false);
			brain->writeFunctional(functional);

			// raw bits, so a 1-ulp difference cannot hide behind %g
			double *activations = new double[spec.dims.numNeurons];
			brain->getActivations(activations, 0, spec.dims.numNeurons);
			for (int i = 0; i < spec.dims.numNeurons; i++)
			{
				char label[64];
				snprintf(label, sizeof(label), "activations %zu %d", step, i);
				printBits(summary, label, activations[i]);
			}
			delete[] activations;
		}
		brain->endFunctional(functional, 1.5f);
		functional->close();

		// ---- synapse dump (native Brain::dumpSynapses) ----
		snprintf(path, sizeof(path), "%s/synapses.%s.txt", outdir.c_str(), tag);
		AbstractFile *synapses = AbstractFile::open(AbstractFile::TYPE_FILE, path, "w");
		brain->dumpSynapses(synapses, 42);
		synapses->close();

		// ---- anatomy dump (native Brain::dumpAnatomical) ----
		snprintf(path, sizeof(path), "%s/anatomy.%s.txt", outdir.c_str(), tag);
		AbstractFile *anatomy = AbstractFile::open(AbstractFile::TYPE_FILE, path, "w");
		brain->dumpAnatomical(anatomy, 42, 1.5f);
		anatomy->close();

		// final efficacies, as raw float bits
		for (long k = 0; k < spec.dims.numSynapses; k++)
		{
			short from, to;
			float efficacy, lrate;
			model->get_synapse((int) k, from, to, efficacy, lrate);
			unsigned int bits;
			memcpy(&bits, &efficacy, sizeof(bits));
			fprintf(summary, "efficacy %ld %08x\n", k, bits);
		}
		fclose(summary);
	}

	return 0;
}

// ---------------------------------------------------------------------------
// format mode — pins the port's `%g` against this machine's printf
// ---------------------------------------------------------------------------
static void formatValue(FILE *f, const char *label, double v, bool withInts)
{
	fprintf(f, "%s g[%.6g] G[%.6G] g3[%.3g] g10[%.10g] f[%f] plus06f[%+06.4f]",
			label, v, v, v, v, v, v);
	// the integer conversions are only meaningful (and only well defined in C) for values
	// that fit a long, so the extreme-magnitude vectors omit them
	if (withInts) fprintf(f, " d[%d] hd[%hd] ld[%ld]", (int) v, (short) (int) v, (long) v);
	fprintf(f, "\n");
}

static int runFormat(const std::string &outdir)
{
	char path[1024];
	snprintf(path, sizeof(path), "%s/format.txt", outdir.c_str());
	FILE *f = fopen(path, "w");

	// the model's own magnitudes, plus the cases that separate correct rounding from
	// toPrecision/JS formatting
	double values[] = {
		0.0, -0.0, 0.5, 1.0, -1.0, 0.821122, 0.0078125, 0.0078124, 1e-5, 1e-4, 9.999999e-5,
		0.000123456789, 123456.789, 999999.5, 999999.4, 0.9999995, 0.99999949, 1.5e-7,
		1.0 / 3.0, 2.0 / 3.0, -2.5e-8, 1234567.0, 1e20, 1e-20, 3.14159265358979,
		0.09999999999999999, 1.0000000000000002, 2147483647.0, -2147483648.0, 4294967296.0,
		0.1, 0.2, 0.30000000000000004, 1e6, 99999.95, 0.049999999999, 4.9999995,
	};
	for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++)
	{
		char label[32];
		snprintf(label, sizeof(label), "v%zu", i);
		formatValue(f, label, values[i], fabs(values[i]) < 1e9);
	}

	// and the values an actual firing-rate run produces
	Spec spec;
	buildSpec(spec, false);
	Brain::config.neuronModel = Brain::Configuration::FIRING_RATE;
	Brain::config.logisticSlope = spec.logisticSlope;
	Brain::config.maxWeight = spec.maxWeight;
	Brain::config.maxbias = spec.maxBias;
	Brain::config.enableLearning = spec.enableLearning;
	Brain::config.minlrate = spec.minlrate;
	Brain::config.maxlrate = spec.maxlrate;
	Brain::config.decayRate = spec.decayRate;

	ProbeCns cns;
	ProbeBrain *brain = new ProbeBrain(&cns);
	cns.setBrain(brain);
	brain->setDims(spec.dims);
	FiringRateModel *model = new FiringRateModel(&cns); // owned by ~Brain, as in the sim
	brain->setNet(model);
	model->init(&spec.dims, 0.1);
	initNeuronAttrs(model, spec, false, true);

	for (size_t step = 0; step < spec.inputs.size(); step++)
	{
		const std::vector<double> &values = spec.inputs[step];
		brain->setActivations(const_cast<double *>(&values[0]), 0, (int) values.size());
		brain->update(false);
	}

	double *activations = new double[spec.dims.numNeurons];
	brain->getActivations(activations, 0, spec.dims.numNeurons);
	for (int i = 0; i < spec.dims.numNeurons; i++)
	{
		char label[32];
		snprintf(label, sizeof(label), "a%d", i);
		formatValue(f, label, activations[i], true);
	}
	delete[] activations;

	for (long k = 0; k < spec.dims.numSynapses; k++)
	{
		short from, to;
		float efficacy, lrate;
		model->get_synapse((int) k, from, to, efficacy, lrate);
		char label[32];
		snprintf(label, sizeof(label), "s%lde", k);
		formatValue(f, label, (double) efficacy, true);
		snprintf(label, sizeof(label), "s%ldl", k);
		formatValue(f, label, (double) lrate, true);
	}

	fclose(f);
	return 0;
}

// ---------------------------------------------------------------------------
// math mode — isolates the libm question (PORT_SPEC rule 3)
//
// The firing-rate update is `logistic( x, slope ) = 1/(1+exp(-x*slope))`, and `exp` is the
// one transcendental on that path. This mode prints the oracle's own `logistic()` and `exp()`
// values as raw bits over the range the model feeds them, so the port's `Math.exp` can be
// measured against the oracle's libm instead of assumed equal.
// ---------------------------------------------------------------------------
static int runMath(const std::string &outdir)
{
	char path[1024];
	snprintf(path, sizeof(path), "%s/math.txt", outdir.c_str());
	FILE *f = fopen(path, "w");

	const double slopes[] = {1.0, 1.55016601, 2.5, 0.5};
	for (size_t s = 0; s < sizeof(slopes) / sizeof(slopes[0]); s++)
	{
		for (int i = 0; i < 512; i++)
		{
			double x = -30.0 + i * (60.0 / 511.0);
			double r = logistic(x, slopes[s]);
			unsigned long long xb, bits;
			memcpy(&xb, &x, sizeof(xb));
			memcpy(&bits, &r, sizeof(bits));
			fprintf(f, "logistic %.17g %016llx %016llx\n", slopes[s], xb, bits);
		}
	}

	for (int i = 0; i < 512; i++)
	{
		double x = -30.0 + i * (60.0 / 511.0);
		double r = exp(x);
		unsigned long long xb, bits;
		memcpy(&xb, &x, sizeof(xb));
		memcpy(&bits, &r, sizeof(bits));
		fprintf(f, "exp %016llx %016llx\n", xb, bits);
	}

	fclose(f);
	return 0;
}

// ---------------------------------------------------------------------------
// growexpr mode — the arithmetic of GroupsBrain::growSynapses, against the native compiler
//
// `growSynapses` is private and needs a live `GroupsGenome` (lane L5) and `agent::config`
// (lane L8), so the *walk* cannot be driven yet. The *arithmetic* can: each function below is a
// transcription of one C expression of `GroupsBrain.cc` (line numbers cited, operands typed
// exactly as the native source types them) and it is compiled by the same clang++ that builds
// the oracle. The expressions are evaluated over an enumerated grid; both the inputs (raw bits)
// and the native result are written to `growexpr.txt`, and `tests/brain-core.test.ts` replays
// the inputs through the port's `growArithmetic.ts` and compares.
//
// The transcription is the point, not a shortcut: for these expressions the operand *types* are
// what has to be reproduced — `nsynjiperneur + remainder` is a FLOAT addition that rounds before
// the `double` literal `1.e-5` promotes the sum, and `float(synapseCount_new) * 0.5` is a DOUBLE
// that `short(...)` truncates — and a transcription that adds everything in `double` looks
// identical until it is run.
// ---------------------------------------------------------------------------

static unsigned int fbitsOf(float x)
{
	unsigned int b;
	memcpy(&b, &x, sizeof(b));
	return b;
}

static unsigned long long dbitsOf(double x)
{
	unsigned long long b;
	memcpy(&b, &x, sizeof(b));
	return b;
}

/** Spacing of the `float`s around `x` (the ulp the port's `f32` rounding can move a value by). */
static float fspacing(float x)
{
	float up = nextafterf(x, INFINITY);
	return up - x;
}

// GroupsBrain.cc:688 — int synapseCount_new = short( nsynjiperneur + remainder[groupIndex_from] + 1.e-5 );
static int nativeSynapseCountNew(float nsynjiperneur, float remainder)
{
	int synapseCount_new = short(nsynjiperneur + remainder + 1.e-5);
	return synapseCount_new;
}

// GroupsBrain.cc:689 — remainder[groupIndex_from] += nsynjiperneur - synapseCount_new;
static float nativeRemainderUpdate(float remainder, float nsynjiperneur, int synapseCount_new)
{
	remainder += nsynjiperneur - synapseCount_new;
	return remainder;
}

// GroupsBrain.cc:713-714
static int nativeNeuronLocalIndexFromBase(int neuronLocalIndex_to, int neuronCount_to, int neuronCount_from,
                                          int synapseCount_new)
{
	int neuronLocalIndex_fromBase = short((float(neuronLocalIndex_to) / float(neuronCount_to)) * float(neuronCount_from)
	                                      - float(synapseCount_new) * 0.5);
	neuronLocalIndex_fromBase = std::max<short>(0, std::min<short>(short(neuronCount_from - synapseCount_new), short(neuronLocalIndex_fromBase)));
	return neuronLocalIndex_fromBase;
}

// GroupsBrain.cc:764 / 769 / 775
static float nativeTdFromToAbs(float td_fromto, int branch)
{
	float td_fromto_abs;
	if (branch == 0)
		td_fromto_abs = td_fromto; // not mirrored
	else if (branch == 1)
		td_fromto_abs = td_fromto * 2; // mirrored, td_fromto < 0.5
	else
		td_fromto_abs = (1 - td_fromto) * 2; // mirrored, td_fromto >= 0.5
	return td_fromto_abs;
}

// GroupsBrain.cc:778 — short distortion = short( nint( td_rng->range(-0.5,0.5)*td_fromto_abs*neuronCount_from ) );
//
// `nint` is `utils/misc.h`'s macro (`(long)((a)+(((a)<0.0)?-0.499999999:0.499999999))`) and it
// mentions its argument **twice**, so the `range()` *call* inside it runs twice on the stream:
// the compiled walk consumes two draws per passing connection, and which of the two the sum
// uses is the compiler's choice. This transcription keeps the call — the macro's argument is a
// queued draw, not a value — so each emitted row records the compiled macro's own behaviour and
// the port must consume the same two draws in the same roles.
static double gDrawQueue[2];
static int gDrawIndex;
static double nativeQueuedRange(double lo, double hi)
{
	// the queued value *is* `range()`'s result (the grid supplies the draws, not the uniform
	// inputs), so this stands in for `RandomNumberGenerator::range`
	(void) lo;
	(void) hi;
	double r = gDrawQueue[gDrawIndex < 2 ? gDrawIndex : 1];
	gDrawIndex++;
	return r;
}

static int nativeDistortion(double drawA, double drawB, float td_fromto_abs, int neuronCount_from)
{
	gDrawQueue[0] = drawA;
	gDrawQueue[1] = drawB;
	gDrawIndex = 0;
	short distortion = short(nint(nativeQueuedRange(-0.5, 0.5) * td_fromto_abs * neuronCount_from));
	return distortion;
}

// The same expression as the port transcribed it *before* t_7d391d0f: the product materialised
// (rounded) and only then added to the macro's ±0.499999999. Each value is a named
// intermediate, so nothing here is contracted — this is the form the boundary family below
// scores, and the form the port's differential test counts as "pre-change".
static int nativeDistortionUnfused(double drawA, double drawB, float td_fromto_abs, int neuronCount_from)
{
	gDrawQueue[0] = drawA;
	gDrawQueue[1] = drawB;
	gDrawIndex = 0;
	double value = nativeQueuedRange(-0.5, 0.5) * td_fromto_abs * neuronCount_from;
	double test = nativeQueuedRange(-0.5, 0.5) * td_fromto_abs * neuronCount_from;
	double bias = (test < 0.0) ? -0.499999999 : 0.499999999;
	return (int) (short) (long) (value + bias);
}

// GroupsBrain.cc:713-714 — `0x66b70 fmadd d0, d1, d2, d0` (d1 = (double)synapseCount_new,
// d2 = -0.5, d0 = (double)(f32(localTo/countTo) * f32(countFrom)), widened exactly by 66b5c
// fcvt) is the *other* contraction in this function, and it cannot move: `synapseCount_new *
// -0.5` is exact in binary64 for every integer `synapseCount_new` (a power-of-two scaling of an
// integer), and the addend is a binary32 widened exactly, so the fused and the two-step sums are
// the SAME double for every input. The `baseidx` grid below is therefore exact for a reason, and
// no boundary family exists that could separate the two forms (t_7d391d0f, PARITY.md).

// GroupsBrain.cc:822 (the gene value is `Scalar::fval`, `Scalar * float` is a float product,
// Scalar.cc:143; `Brain::config.gaussianInitMaxStdev` is a float, Brain.h:102)
static float nativeStdev(float weightStdevGene, float gaussianInitMaxStdev)
{
	float stdev = weightStdevGene * gaussianInitMaxStdev;
	return stdev;
}

// GroupsBrain.cc:616-617 (every operation is `float`: `Brain::config.maxneuron2energy` /
// `maxsynapse2energy` are floats, `config.maxneurons` is a `short`, `config.maxsynapses` a
// `long`, and `_energyUse` is a float)
static float nativeEnergyUse(float maxneuron2energy, long numNeurons, short maxneurons,
                             float maxsynapse2energy, long numSynapses, long maxsynapses)
{
	float energyUse = maxneuron2energy * float(numNeurons) / float(maxneurons)
	                + maxsynapse2energy * float(numSynapses) / float(maxsynapses);
	return energyUse;
}

#define NELEMS(a) (sizeof(a) / sizeof((a)[0]))

static int runGrowExpr(const std::string &outdir)
{
	char path[1024];
	snprintf(path, sizeof(path), "%s/growexpr.txt", outdir.c_str());
	FILE *f = fopen(path, "w");
	if (!f)
	{
		fprintf(stderr, "growexpr: cannot write %s\n", path);
		return 1;
	}

	fprintf(f, "# native GroupsBrain::growSynapses arithmetic (GroupsBrain.cc), evaluated by the\n");
	fprintf(f, "# native toolchain; inputs and results as raw bits. Replayed by growArithmetic.ts.\n");
	fprintf(f, "# synnew  <nsyn_bits> <rem_bits> <synapseCount_new>\n");
	fprintf(f, "# remupd  <rem_bits> <nsyn_bits> <synapseCount_new> <result_bits>\n");
	fprintf(f, "# baseidx <localTo> <countTo> <countFrom> <synapseCount_new> <neuronLocalIndex_fromBase>\n");
	fprintf(f, "# tdabs   <td_bits> <branch:0|1|2> <result_bits>\n");
	fprintf(f, "# distort <drawA_bits(64)> <drawB_bits(64)> <tdabs_bits> <neuronCount_from> <distortion>\n");
	fprintf(f, "# stdev   <gene_bits> <config_bits> <result_bits>\n");
	fprintf(f, "# energy  <maxneuron2energy_bits> <numNeurons> <maxneurons> <maxsynapse2energy_bits> <numSynapses> <maxsynapses> <result_bits>\n");

	const double nsynBases[] = {0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0, 8.0, 12.0, 16.0, 23.0, 32.0, 64.0,
	                            0.14285714285714285, 3.0 / 7.0, 15.5, 64.25, 100.0};
	const double remBases[] = {0.0, 1e-5, -1e-5, 1e-6, -1e-6, 1e-7, -1e-7, 0.5, -0.5, 0.25, -0.25, 0.9999, -0.9999,
	                           1.0 / 3.0, -1.0 / 3.0, 1.0 / 7.0, -1.0 / 7.0};

	// (a) the structural grid: integer-ish synapse counts against the remainders the accumulator
	//     actually produces (a persistent float in [-1, 1])
	for (size_t i = 0; i < NELEMS(nsynBases); i++)
		for (size_t j = 0; j < NELEMS(remBases); j++)
		{
			float nsyn = (float) nsynBases[i];
			float rem = (float) remBases[j];
			fprintf(f, "synnew %08x %08x %d\n", fbitsOf(nsyn), fbitsOf(rem), nativeSynapseCountNew(nsyn, rem));
		}

	// (b) a uniform sweep over [0, 8] synapse-per-neuron ratios × [-0.5, 0.5] remainders
	for (int i = 0; i <= 2048; i++)
		for (int j = -4; j <= 4; j++)
		{
			float nsyn = (float) (i / 256.0);
			float rem = (float) (j / 8.0);
			fprintf(f, "synnew %08x %08x %d\n", fbitsOf(nsyn), fbitsOf(rem), nativeSynapseCountNew(nsyn, rem));
		}

	// (c) the truncation window: ±24 float ulps around the remainder that puts the double sum
	//     exactly on an integer boundary (this is where a missing float rounding shows up)
	for (size_t i = 0; i < NELEMS(nsynBases); i++)
	{
		float nsyn = (float) nsynBases[i];
		for (int n = (int) floor(nsynBases[i]) - 1; n <= (int) floor(nsynBases[i]) + 1; n++)
		{
			float remNear = (float) (double(n) - double(nsyn) - 1.e-5);
			float spacing = fspacing(remNear);
			if (spacing == 0.0f) continue;
			for (int m = -24; m <= 24; m++)
			{
				float rem = (float) (double(remNear) + m * double(spacing));
				fprintf(f, "synnew %08x %08x %d\n", fbitsOf(nsyn), fbitsOf(rem), nativeSynapseCountNew(nsyn, rem));
			}
		}
	}

	// remainders are floats; `nsynjiperneur - synapseCount_new` is a float difference and the
	// `+=` is a float store
	{
		const float rems[] = {-1.0f, -0.5f, -1e-5f, -1.1920929e-07f, 0.0f, 1e-5f, 0.5f, 0.9999f, 1.0f, 1.0f / 3.0f};
		const float nsyns[] = {0.0f, 0.1f, 0.5f, 1.0f, 2.5f, 7.0f, 0.33333334f, -0.5f};
		const int scns[] = {-2, -1, 0, 1, 2, 7, 1000};
		for (size_t i = 0; i < NELEMS(rems); i++)
			for (size_t j = 0; j < NELEMS(nsyns); j++)
				for (size_t k = 0; k < NELEMS(scns); k++)
					fprintf(f, "remupd %08x %08x %d %08x\n", fbitsOf(rems[i]), fbitsOf(nsyns[j]), scns[k],
					        fbitsOf(nativeRemainderUpdate(rems[i], nsyns[j], scns[k])));
	}

	// every reachable (local_to, count_to, count_from, synapseCount_new) shape of a neuron group
	for (int countTo = 1; countTo <= 12; countTo++)
		for (int localTo = 0; localTo < countTo; localTo++)
			for (int countFrom = 1; countFrom <= 12; countFrom++)
				for (int scn = 0; scn <= countFrom; scn++)
					fprintf(f, "baseidx %d %d %d %d %d\n", localTo, countTo, countFrom, scn,
					        nativeNeuronLocalIndexFromBase(localTo, countTo, countFrom, scn));

	// … plus larger group shapes, where the intermediate's magnitude (and therefore the float
	// spacing the narrowing happens at) is further from the reachable recorded architectures
	{
		const int countsTo[] = {16, 32, 64};
		const int countsFrom[] = {1, 2, 7, 16, 31, 64, 128};
		for (size_t i = 0; i < NELEMS(countsTo); i++)
		{
			const int ct = countsTo[i];
			const int localTos[] = {0, ct / 2, ct - 1};
			for (size_t l = 0; l < NELEMS(localTos); l++)
				for (size_t j = 0; j < NELEMS(countsFrom); j++)
				{
					const int cf = countsFrom[j];
					const int scns[] = {0, 1, cf / 2, cf};
					for (size_t k = 0; k < NELEMS(scns); k++)
						fprintf(f, "baseidx %d %d %d %d %d\n", localTos[l], ct, cf, scns[k],
						        nativeNeuronLocalIndexFromBase(localTos[l], ct, cf, scns[k]));
				}
		}
	}

	// td_fromto_abs: the gene value's range plus the two boundaries the mirrored branch tests
	{
		std::vector<float> tds;
		for (int i = 0; i <= 64; i++) tds.push_back((float) (i / 64.0));
		const float extra[] = {1.0f, 1.5f, 2.0f, 3.0f, 3.7f, 5.0f, 7.25f, 10.0f, 0.9999999f, 1.0000001f};
		for (size_t i = 0; i < NELEMS(extra); i++) tds.push_back(extra[i]);
		// ±8 ulps around 0.5 (the branch test) and around 1.0 (where `1 - td` starts to round)
		for (int m = -8; m <= 8; m++)
		{
			tds.push_back((float) (0.5 + m * double(fspacing(0.5f))));
			tds.push_back((float) (1.0 + m * double(fspacing(1.0f))));
		}
		// ±64 ulps around bases across [0.5, 10]: `1 - td_fromto` needs more mantissa bits than
		// `td_fromto` carries once |td| >= 4, and *that* is the rounding a double transcription
		// loses
		const float sweepBases[] = {0.5f, 0.625f, 1.0f, 1.5f, 2.0f, 2.5f, 3.0f, 3.7f, 4.0f, 5.0f, 7.25f, 8.0f, 10.0f};
		for (size_t i = 0; i < NELEMS(sweepBases); i++)
		{
			float baseSpacing = fspacing(sweepBases[i]);
			for (int m = -64; m <= 64; m++)
				tds.push_back((float) (double(sweepBases[i]) + m * double(baseSpacing)));
		}
		for (size_t i = 0; i < tds.size(); i++)
			for (int branch = 0; branch < 3; branch++)
				fprintf(f, "tdabs %08x %d %08x\n", fbitsOf(tds[i]), branch, fbitsOf(nativeTdFromToAbs(tds[i], branch)));
	}

	// distortion = short( nint( range * td_fromto_abs * neuronCount_from ) ), where the `nint`
	// macro's argument is a `range()` *call* and therefore runs twice (two draws, one per
	// evaluation). Rows come in three second-draw shapes: the same draw (both evaluations equal),
	// the negated draw (the sign test sees the opposite sign), and a shifted draw (both
	// evaluations differ, which is what the walk always has).
	{
		std::vector<double> ranges;
		for (int i = 0; i <= 128; i++) ranges.push_back((i / 128.0) - 0.5);
		const double extra[] = {-0.5, 0.5, 0.0, -1e-9, 1e-9, -0.4999999999, 0.4999999999, -1.0, 1.0};
		for (size_t i = 0; i < NELEMS(extra); i++) ranges.push_back(extra[i]);
		const float tdabs[] = {0.0f, 1e-5f, 1e-4f, 0.1f, 0.25f, 0.5f, 0.9999999f, 1.0f, 1.5f, 2.0f, 5.0f, 7.25f};
		const int counts[] = {1, 2, 3, 7, 16, 64};
		for (size_t i = 0; i < ranges.size(); i++)
			for (size_t j = 0; j < NELEMS(tdabs); j++)
				for (size_t k = 0; k < NELEMS(counts); k++)
				{
					const double second[3] = {ranges[i], -ranges[i], ranges[(i + 1) % ranges.size()]};
					for (int s = 0; s < 3; s++)
						fprintf(f, "distort %016llx %016llx %08x %d %d\n", dbitsOf(ranges[i]), dbitsOf(second[s]),
						        fbitsOf(tdabs[j]), counts[k], nativeDistortion(ranges[i], second[s], tdabs[j], counts[k]));
				}
	}

	// distortion, the **boundary family** (t_7d391d0f): the rows where the contraction at
	// `0x66dc0` is observable *at all*.
	//
	// The compiled macro is `fmadd d0, d9, d11, d0` (66dc0) with `d9 = fmul d9, d0, d10` — i.e.
	// `trunc( RN( RN(range1*td_fromto_abs) * neuronCount_from + ±0.499999999 ) )`, one rounding —
	// while a rounds-per-operation transcription rounds the product first. The two differ only
	// where the exact product `RN(range1*td_fromto_abs)*count` sits within ~1 ulp of the
	// truncation boundary `n - K`, so — exactly like the `synnew` tie family above — the draws are
	// *constructed*: solve `R* = (n - K)/(td*count)`, snap it to the nearest draw of
	// `range(-0.5,0.5)`'s own grid (`-0.5 + k*2**-48`: drand48, the generator `growSynapses`
	// reaches through `_cns->getRNG()` when `StaticTimestepGeometry` is off, and always through
	// the `TOPOLOGICAL_DISTORTION` role), and walk ±BOUNDARY_SPAN grid steps — the window is far
	// narrower than the grid, so which step lands in it is not predictable from the construction
	// and the family has to carry its neighbours.
	//
	// Only rows whose *result* differs between the compiled macro and the pre-change
	// transcription are emitted (the filter evaluates both), so the family cannot be vacuous and
	// the count it reports to stderr is the number of rows a rounds-per-operation transcription
	// gets wrong. The second draw is the first's magnitude with the sign the family's `K` wants —
	// in the walk the second draw is an independent value of either sign, so that is a 1-in-2
	// event, not a constructed draw.
	{
		const double GRID = 4503599627370496.0; // 2**48, drand48's grid
		const double STEP = 1.0 / GRID;
		const int BOUNDARY_SPAN = 6;
		const float boundTds[] = {0.1f, 0.25f, 1.0f / 3.0f, 0.5f, 0.7f, 0.9f, 0.9999999f, 1.0f, 1.5f, 2.0f,
		                          2.5f, 5.0f, 7.25f, 0.30000001f, 0.69999999f, 2.0f / 3.0f};
		const int boundCounts[] = {1, 2, 3, 5, 7, 11, 16, 17, 19, 23, 29, 30, 32, 64, 112, 128};
		int emitted = 0;
		for (size_t i = 0; i < NELEMS(boundTds); i++)
		{
			const float td = boundTds[i];
			for (size_t j = 0; j < NELEMS(boundCounts); j++)
			{
				const int count = boundCounts[j];
				const int nmax = (int) floor(0.5 * double(td) * double(count)) + 1;
				for (int n = -nmax; n <= nmax; n++)
					for (int s = 0; s < 2; s++)
					{
						const double K = (s == 0) ? 0.499999999 : -0.499999999;
						const double Rstar = (double(n) - K) / (double(td) * double(count));
						if (!(Rstar >= -0.5 && Rstar < 0.5)) continue;
						const long long k0 = (long long) ((Rstar + 0.5) * GRID);
						for (int m = -BOUNDARY_SPAN; m <= BOUNDARY_SPAN; m++)
						{
							const long long k = k0 + m;
							if (k < 0 || k >= (long long) GRID) continue;
							const double R1 = -0.5 + (double(k) * STEP);
							const double R2 = (s == 0) ? fabs(R1) : -fabs(R1);
							if (R2 == 0.0) continue; // the sign test would read +0 and pick `K > 0`
							const int fused = nativeDistortion(R1, R2, td, count);
							const int unfused = nativeDistortionUnfused(R1, R2, td, count);
							if (fused == unfused) continue;
							fprintf(f, "distortb %016llx %016llx %08x %d %d\n", dbitsOf(R1), dbitsOf(R2),
							        fbitsOf(td), count, fused);
							emitted++;
						}
					}
			}
		}
		if (emitted == 0)
		{
			fprintf(stderr, "growexpr: the 0x66dc0 boundary family is EMPTY — this build contracted "
			                "nothing at the `nint` sum, so the family would be vacuous\n");
			fclose(f);
			return 1;
		}
		fprintf(stderr, "growexpr: 0x66dc0 boundary family: %d discriminating rows\n", emitted);
	}

	// stdev = WEIGHT_STDEV * gaussianInitMaxStdev (both float)
	{
		const float genes[] = {0.0f, 0.5f, 1.0f, 2.0f, 2.5f, 5.0f, 7.5f, 0.1f, 1.0f / 3.0f, 7.0f / 11.0f, 1e-5f, 100.0f,
		                       1000.0f, 0.30000001f, 0.7f, 1.7f};
		const float configs[] = {0.0f, 0.5f, 1.0f, 2.0f, 2.5f, 3.0f, 10.0f, 0.25f, 1.0f / 3.0f, 0.7f, 1.5f};
		for (size_t i = 0; i < NELEMS(genes); i++)
			for (size_t j = 0; j < NELEMS(configs); j++)
				fprintf(f, "stdev %08x %08x %08x\n", fbitsOf(genes[i]), fbitsOf(configs[j]),
				        fbitsOf(nativeStdev(genes[i], configs[j])));
	}

	// `_energyUse` (GroupsBrain.cc:616-617) — the only place native assigns it
	{
		const float neuronFactors[] = {0.0f, 0.5f, 1.0f, 2.5f, 8.0f, 12.5f};
		const long numNeurons[] = {0, 1, 7, 37, 100, 1234};
		const short maxNeurons[] = {32, 128, 1500, 32767};
		const float synapseFactors[] = {0.0f, 0.5f, 1.0f, 2.5f, 8.0f, 12.5f};
		const long numSynapses[] = {0, 73, 1369, 40000};
		const long maxSynapses[] = {1024, 50000, 1000000};
		for (size_t a = 0; a < NELEMS(neuronFactors); a++)
			for (size_t n = 0; n < NELEMS(numNeurons); n++)
				for (size_t m = 0; m < NELEMS(maxNeurons); m++)
					for (size_t b = 0; b < NELEMS(synapseFactors); b++)
						for (size_t s = 0; s < NELEMS(numSynapses); s++)
							for (size_t x = 0; x < NELEMS(maxSynapses); x++)
								fprintf(f, "energy %08x %ld %d %08x %ld %ld %08x\n", fbitsOf(neuronFactors[a]), numNeurons[n],
								        (int) maxNeurons[m], fbitsOf(synapseFactors[b]), numSynapses[s], maxSynapses[x],
								        fbitsOf(nativeEnergyUse(neuronFactors[a], numNeurons[n], maxNeurons[m],
								                                synapseFactors[b], numSynapses[s], maxSynapses[x])));
	}

	fclose(f);
	return 0;
}

// ---------------------------------------------------------------------------
// fma mode — pins the port's `fma64` against this machine's fused multiply-add
//
// The shipped brain models are compiled with clang's `-ffp-contract=on`, so every `a*b + c`
// the port transcribes from the disassembly is *one* rounding (a hardware `fmadd`), and the
// port emulates it in software (`src/model/brain/core/nativeMath.ts`'s `fma64`, since
// JavaScript has no `Math.fma`). This mode writes `(a, b, c) -> fma(a, b, c)` as raw bits over
// the shapes the models feed it, so `tests/brain-core.test.ts` can replay them through the
// emulation instead of trusting it: a float-valued efficacy against an activation with an
// accumulator addend, the Izhikevich pass, and a wide-random family whose operands differ in
// magnitude by the full exponent range (which is where a transcription that rounds the product
// first, or that fuses the wrong pair, shows up).
//
// The family that isolates *round-to-odd* handling — `a*b + c` landing exactly on the midpoint
// between two doubles — is checked against exact rational arithmetic rather than here (a tie
// cannot be constructed in `double` arithmetic; see `nativeMath.ts`'s note: 4,000 exact ties of
// 44,498 vectors, 0 mismatches).
// ---------------------------------------------------------------------------
static int runFma(const std::string &outdir)
{
	char path[1024];
	snprintf(path, sizeof(path), "%s/fma.txt", outdir.c_str());
	FILE *f = fopen(path, "w");
	if (!f)
	{
		fprintf(stderr, "fma: cannot write %s\n", path);
		return 1;
	}
	fprintf(f, "# fma <a_bits> <b_bits> <c_bits> <fma_bits>   (hardware FMADD)\n");

	unsigned long long state = 0x243f6a8885a308d3ULL;
	struct LCG
	{
		unsigned long long *s;
		unsigned long long next()
		{
			*s = *s * 6364136223846793005ULL + 1442695040888963407ULL;
			return *s;
		}
		double u01() { return double((next() >> 11) & ((1ULL << 53) - 1)) / double(1ULL << 53); }
		double uniform(double lo, double hi) { return lo + u01() * (hi - lo); }
		double wide()
		{
			// a random finite double over the full exponent range (0..2045, sign random)
			unsigned long long bits = (next() & 0x800fffffffffffffULL) | ((next() % 2046ULL) << 52);
			unsigned long long b2 = bits;
			double d;
			memcpy(&d, &b2, sizeof(d));
			return d;
		}
	} lcg{&state};

	// (a) the model's own shapes: a binary32 factor (efficacy) times a double (activation),
	//     plus a double accumulator; and the spiking model's `u += a*(b*v - u)` shape
	for (int i = 0; i < 20000; i++)
	{
		float efficacy = float(lcg.uniform(-8.0, 8.0));
		double activation = lcg.uniform(-0.0, 25.0);
		double acc = lcg.uniform(-30.0, 30.0);
		unsigned long long r = dbitsOf(fma((double) efficacy, activation, acc));
		fprintf(f, "fma %016llx %016llx %016llx %016llx\n", dbitsOf((double) efficacy), dbitsOf(activation), dbitsOf(acc), r);

		double a = lcg.uniform(0.001, 0.2);
		double b = lcg.uniform(0.01, 0.3);
		double v = lcg.uniform(-90.0, 31.0);
		double u = lcg.uniform(-80.0, 30.0);
		double inner = fma(b, v, -u);
		r = dbitsOf(fma(a, inner, u));
		fprintf(f, "fma %016llx %016llx %016llx %016llx\n", dbitsOf(a), dbitsOf(inner), dbitsOf(u), r);
	}

	// (b) wide random doubles over the full finite exponent range, both factors not binary32
	for (int i = 0; i < 20000; i++)
	{
		double a = lcg.wide();
		double b = lcg.wide();
		double c = lcg.wide();
		if (!std::isfinite(a) || !std::isfinite(b) || !std::isfinite(c)) continue;
		double r = fma(a, b, c);
		if (!std::isfinite(r)) continue; // the port's emulation is for the finite domain
		fprintf(f, "fma %016llx %016llx %016llx %016llx\n", dbitsOf(a), dbitsOf(b), dbitsOf(c), dbitsOf(r));
	}

	fclose(f);
	return 0;
}

// ---------------------------------------------------------------------------
// learnclamp mode — the learning rule's *clamp chain*, driven through the shipped models
//
// PARITY.md's L6 mutation table carried exactly one survivor: reverting `FiringRateModel`'s /
// `SpikingModel`'s clamp chain to the pre-sweep binary64 form
//
//     scaled = 1.0 - (oneMinusDecay * (fabsf(efficacy) - halfMaxWeight)) / halfMaxWeight;
//     efficacy = (float) (efficacy * scaled);
//
// passes in every suite. Nothing in this probe reached the site: `models` mode's spec draws
// `|efficacy|` in `[0.05, 4.0]` while the clamp needs `|efficacy| > 0.5f*maxWeight` (= 4.0 at
// the spec's `maxWeight = 8`), and its six steps only ever shrink an efficacy, so the condition
// is never true. (The hand-built `FiringRateModel::update` drive `t_2a625bd5` wrote and removed
// failed for a different reason: the learning block is gated on
// `Brain::config.enableLearning && !cns->getBrain()->isFrozen()`, and a hand-built brain has to
// set `enableLearning` itself — `Brain::processWorldfile` derives it from `learningMode`, the
// model does not — so the drive's synapses came back exactly as they were set. The
// `set_synapse -> update -> get_synapse` round trip is fine.)
//
// This mode builds the input that *is* reachable from `update()` alone: a brain whose synapses
// are constructed with `|efficacy|` inside `(0.5f*maxWeight, 1f*maxWeight)`, driven through the
// model's own round trip for one step, with learning on. For every synapse it writes
//
//     before  — the pre-clamp efficacy the learning rule formed (post-delta / post-increment)
//     native  — the efficacy the *shipped* model stored (the arbiter)
//     pre     — the same value under the pre-change binary64 transcription
//
// and a verdict column. The verdict is `differs` only where the two forms disagree, so the
// family cannot be vacuous, and the mode **exits non-zero** if a variant's family stops
// discriminating (or if the port's *current* transcription, evaluated here by the native
// compiler, disagrees with the shipped model on any row).
// ---------------------------------------------------------------------------

/** `(float) (0.5 * maxWeight)` — the port's `f32(0.5 * Brain::config.maxWeight)`. */
static float clampHalfMaxWeight(float maxWeight)
{
	return (float) (0.5 * maxWeight);
}

/** `(float) (1.0 - decayRate)` — the port's `f32(1.0 - Brain::config.decayRate)`. */
static float clampOneMinusDecay(float decayRate)
{
	return (float) (1.0 - decayRate);
}

// The port's *current* transcription of the chain (`firingRateModel.ts` / `spikingModel.ts`),
// compiled by the same clang++ that built the oracle: one rounding per operation, and the first
// product fused (`fmadd s16, s0, s6, s18` at 0x5e8bc / `fmadd s18, s0, s7, s19` at 0x67cb0).
static float clampChainNow(float efficacy, float maxWeight, float decayRate)
{
	const float halfMaxWeight = clampHalfMaxWeight(maxWeight);
	const float oneMinusDecay = clampOneMinusDecay(decayRate);
	const float overHalfMax = __builtin_fmaf(maxWeight, -0.5f, fabsf(efficacy));
	const float a = overHalfMax * oneMinusDecay;
	const float b = a / halfMaxWeight;
	const float scaled = 1.0f - b;
	float out = efficacy * scaled;
	if (out > maxWeight) out = maxWeight;
	else if (out < -maxWeight) out = -maxWeight;
	return out;
}

// The pre-change form the mutation restores — every operation binary64, one rounding at the end.
// Each intermediate is a named variable so that nothing here can be contracted, exactly as the
// port's pre-change statements were separate JS expressions.
static float clampChainPreChange(float efficacy, float maxWeight, float decayRate)
{
	const float halfMaxWeight = clampHalfMaxWeight(maxWeight);
	const float oneMinusDecay = clampOneMinusDecay(decayRate);
	double product = (double) oneMinusDecay * ((double) fabsf(efficacy) - (double) halfMaxWeight);
	double quotient = product / (double) halfMaxWeight;
	double scaled = 1.0 - quotient;
	float out = (float) ((double) efficacy * scaled);
	if (out > maxWeight) out = maxWeight;
	else if (out < -maxWeight) out = -maxWeight;
	return out;
}

/** The un-clamped half of the rule (unchanged by the mutation, so both forms share it). */
static float clampElseBranch(float efficacy, float lrate)
{
	if (lrate >= 0.0f) efficacy = std::max(0.0f, efficacy);
	if (lrate < 0.0f) efficacy = std::min(-1.e-10f, efficacy);
	return efficacy;
}

struct ClampStep
{
	float before;  // the pre-clamp efficacy
	float now;     // the port's current transcription of the whole step
	float pre;     // the pre-change (binary64) transcription of the whole step
	bool clamped;
};

static ClampStep clampFinish(float before, float beforePre, float maxWeight, float decayRate, float lrate)
{
	ClampStep s;
	s.before = before;
	const float halfMaxWeight = clampHalfMaxWeight(maxWeight);
	s.clamped = fabsf(before) > halfMaxWeight;
	s.now = s.clamped ? clampChainNow(before, maxWeight, decayRate) : clampElseBranch(before, lrate);
	s.pre = (fabsf(beforePre) > halfMaxWeight) ? clampChainPreChange(beforePre, maxWeight, decayRate)
	                                           : clampElseBranch(beforePre, lrate);
	return s;
}

// `FiringRateModel::update`'s learning step for one synapse (0x5e890-0x5e8cc).
static ClampStep firingRateClampStep(float efficacy, float lrate, double aTo, double aFrom, float maxWeight, float decayRate)
{
	// native: `learningrate * (aTo-0.5)` is one double product (`0x5e890-0x5e894`), and the
	// second product and the add are contracted into `fmadd d17, d18, d19, d17` (`0x5e8a8`),
	// with the double result narrowed by the store
	const double first = (double) lrate * (aTo - 0.5);
	const float before = (float) __builtin_fma(first, aFrom - 0.5, (double) efficacy);
	// pre-change: the whole sum in binary64, the last product rounded before the add
	const double product = first * (aFrom - 0.5);
	const float beforePre = (float) ((double) efficacy + product);
	return clampFinish(before, beforePre, maxWeight, decayRate, lrate);
}

// `SpikingModel::update`'s learning step for one synapse (0x67c7c-0x67cc4), from the delta the
// compiled loop itself decayed and used (`synapse[k].delta *= .9` runs first).
static ClampStep spikingClampStep(float efficacy, float lrate, float deltaAfterDecay, float maxWeight, float decayRate)
{
	const float nowIncrement = (float) (0.01 + (double) (float) (deltaAfterDecay * lrate));
	const float before = (efficacy >= 0.0f) ? (float) ((double) efficacy + (double) nowIncrement)
	                                       : (float) ((double) efficacy - (double) nowIncrement);
	const double preIncrement = 0.01 + (double) deltaAfterDecay * (double) lrate;
	const float beforePre = (efficacy >= 0.0f) ? (float) ((double) efficacy + preIncrement)
	                                          : (float) ((double) efficacy - preIncrement);
	return clampFinish(before, beforePre, maxWeight, decayRate, lrate);
}

// A constructed brain: one input neuron per `a_from` family entry, one output neuron per
// candidate row, each row's single incoming synapse carrying a constructed magnitude inside
// `(0.5f*maxWeight, 1f*maxWeight)` — the band the clamp fires in and where neither form
// saturates to `±maxWeight`.
static const int LearnClampRows = 1024;

static void buildClampSpec(Spec &spec, bool spiking)
{
	// one input neuron per family entry: the firing-rate model passes input activations straight
	// through, so a row's from-neuron activation is exactly the value set here
	const double fromFamily[4] = {0.5, 0.25, 0.9, 0.6};
	const bool negative[4] = {false, false, true, true};
	const float biasFamily[4] = {0.0f, 1.5f, -1.5f, 0.75f};
	const int numInput = 4;
	const int perPick = LearnClampRows / numInput;

	spec.dims = NeuronModel::Dimensions();
	spec.dims.numInputNeurons = numInput;
	spec.dims.numOutputNeurons = LearnClampRows;
	spec.dims.numNeurons = numInput + LearnClampRows;
	spec.neurons.assign((size_t) spec.dims.numNeurons, NeuronSpec());
	spec.synapses.clear();

	const float halfMaxWeight = clampHalfMaxWeight(spec.maxWeight);

	for (int i = 0; i < numInput; i++) memset(&spec.neurons[(size_t) i], 0, sizeof(NeuronSpec));

	for (int j = 0; j < LearnClampRows; j++)
	{
		const int pick = j / perPick;   // 0..3: the (a_from, sign) combination
		const int band = j % perPick;   // 0..perPick-1: the magnitude, spread over the whole band
		const double magnitude = (double) halfMaxWeight * (1.0 + (double) band / (double) perPick);

		NeuronSpec n;
		memset(&n, 0, sizeof(n));
		n.bias = biasFamily[pick];
		n.tau = 0.5f;
		n.gain = 1.0f;
		// the standard Izhikevich parameters, nudged per row so the spiking family's deltas are
		// not all identical
		n.spikingA = (float) (0.02 + 0.001 * (band % 17));
		n.spikingB = (float) (0.2 + 0.002 * (band % 11));
		n.spikingC = -65.0f;
		n.spikingD = 6.0f;
		n.start = (long) spec.synapses.size();

		SynapseSpec s;
		s.from = (short) pick;
		s.to = (short) (numInput + j);
		s.efficacy = (float) (negative[pick] ? -magnitude : magnitude);
		s.lrate = (band % 3 == 0) ? 0.1f : ((band % 3 == 1) ? -0.1f : 0.05f);
		spec.synapses.push_back(s);

		n.end = (long) spec.synapses.size();
		spec.neurons[(size_t) (numInput + j)] = n;
	}

	spec.dims.numSynapses = (long) spec.synapses.size();

	spec.inputs.assign(1, std::vector<double>((size_t) numInput, 0.0));
	if (!spiking)
		for (int i = 0; i < numInput; i++) spec.inputs[0][(size_t) i] = fromFamily[i];
}

static int runLearnClamp(const std::string &outdir)
{
	struct Variant
	{
		const char *tag;
		bool spiking;
		float decayRate;
	};
	const Variant variants[] = {
		{"clampfiringrate", false, 0.99f},
		{"clampfiringrate2", false, 0.1f},
		{"clampspiking", true, 0.99f},
	};

	int failures = 0;
	for (size_t v = 0; v < NELEMS(variants); v++)
	{
		const bool spiking = variants[v].spiking;
		const char *tag = variants[v].tag;

		Spec spec;
		spec.maxWeight = 8.0f;
		spec.maxBias = 8.0f;
		spec.logisticSlope = 1.5f;
		spec.enableLearning = true;
		spec.minlrate = -0.1f;
		spec.maxlrate = 0.1f;
		spec.decayRate = variants[v].decayRate;
		spec.scaleLatestSpikes = 0.8f;
		spec.drandSeed = 20260928u;
		spec.spikingParams = 1;
		// after the config, because the family is built around `0.5f*maxWeight`
		buildClampSpec(spec, spiking);

		Brain::config.neuronModel = spiking ? Brain::Configuration::SPIKING : Brain::Configuration::FIRING_RATE;
		Brain::config.logisticSlope = spec.logisticSlope;
		Brain::config.maxWeight = spec.maxWeight;
		Brain::config.maxbias = spec.maxBias;
		// the gate the hand-built drive of t_2a625bd5 missed: the model runs the learning block
		// only when this is set, and `Brain::processWorldfile` is what derives it from
		// `learningMode` — the model does not
		Brain::config.enableLearning = spec.enableLearning;
		Brain::config.minlrate = spec.minlrate;
		Brain::config.maxlrate = spec.maxlrate;
		Brain::config.decayRate = spec.decayRate;
		Brain::config.learningMode = Brain::Configuration::LEARN_ALL;

		ProbeCns cns;
		ProbeBrain *brain = new ProbeBrain(&cns);
		cns.setBrain(brain);
		brain->setDims(spec.dims);

		NeuronModel *base = spiking ? (NeuronModel *) new SpikingModel(&cns, spec.scaleLatestSpikes)
		                            : (NeuronModel *) new FiringRateModel(&cns);
		brain->setNet(base);

		base->init(&spec.dims, 0.1);
		initNeuronAttrs(base, spec, spiking, spec.spikingParams == 1);

		char path[1024];
		snprintf(path, sizeof(path), "%s/spec.%s.txt", outdir.c_str(), tag);
		FILE *specFile = fopen(path, "w");
		if (!specFile)
		{
			fprintf(stderr, "learnclamp: cannot write %s\n", path);
			return 1;
		}
		writeSpec(specFile, spec, spiking ? "spiking" : "firingrate", false, false);
		fclose(specFile);

		const long numNeurons = spec.dims.numNeurons;
		const long numSynapses = spec.dims.numSynapses;

		// the efficacies *before* the step, and the activations on both sides of it (the learning
		// loop reads the from-neuron's pre-update activation and the to-neuron's post-update one)
		std::vector<float> efficacyBefore((size_t) numSynapses, 0.0f);
		for (long k = 0; k < numSynapses; k++)
		{
			short from, to;
			float efficacy, lrate;
			base->get_synapse((int) k, from, to, efficacy, lrate);
			efficacyBefore[(size_t) k] = efficacy;
		}

		double *preActs = new double[(size_t) numNeurons];
		double *postActs = new double[(size_t) numNeurons];

		srand48((long) spec.drandSeed);
		const std::vector<double> &values = spec.inputs[0];
		brain->setActivations(const_cast<double *>(&values[0]), 0, (int) values.size());
		brain->getActivations(preActs, 0, (int) numNeurons);
		brain->update(false);
		brain->getActivations(postActs, 0, (int) numNeurons);

		snprintf(path, sizeof(path), "%s/learnclamp.%s.txt", outdir.c_str(), tag);
		FILE *f = fopen(path, "w");
		if (!f)
		{
			fprintf(stderr, "learnclamp: cannot write %s\n", path);
			return 1;
		}
		fprintf(f, "# native learning-clamp chain of FiringRateModel::update / SpikingModel::update\n");
		fprintf(f, "# (0x5e8bc-0x5e8cc / 0x67cb0-0x67cc4), driven through the shipped libpolyworld.dylib:\n");
		fprintf(f, "# one step of the model's own set_synapse -> update -> get_synapse round trip, with\n");
		fprintf(f, "# Brain::config.enableLearning true (the gate a hand-built drive has to set itself) and\n");
		fprintf(f, "# every constructed |efficacy| above 0.5f*maxWeight.  Replayed against spec.%s.txt.\n", tag);
		fprintf(f, "#\n");
		fprintf(f, "# learnclamp <k> <before_bits> <native_bits> <pre_bits> <verdict>\n");
		fprintf(f, "#   before  the pre-clamp efficacy the learning rule formed (post-delta / post-increment)\n");
		fprintf(f, "#   native  what the shipped model stored (the arbiter)\n");
		fprintf(f, "#   pre     the same value under the pre-change binary64 transcription\n");
		fprintf(f, "#   verdict differs  the two forms disagree (the row has teeth)\n");
		fprintf(f, "#           same     they agree (reported, but pins nothing on its own)\n");

		long clamped = 0;
		long differs = 0;
		long currentMismatch = 0;
		for (long k = 0; k < numSynapses; k++)
		{
			short from, to;
			float nativeEfficacy, lrate;
			base->get_synapse((int) k, from, to, nativeEfficacy, lrate);

			ClampStep step;
			if (spiking)
			{
				SpikingModel *model = (SpikingModel *) base;
				step = spikingClampStep(efficacyBefore[(size_t) k], lrate, model->synapse[k].delta,
				                        spec.maxWeight, spec.decayRate);
			}
			else
			{
				step = firingRateClampStep(efficacyBefore[(size_t) k], lrate, postActs[to], preActs[from],
				                           spec.maxWeight, spec.decayRate);
			}

			if (step.clamped) clamped++;
			if (fbitsOf(step.now) != fbitsOf(nativeEfficacy)) currentMismatch++;
			const bool discriminates = fbitsOf(step.pre) != fbitsOf(nativeEfficacy);
			if (discriminates) differs++;

			fprintf(f, "learnclamp %ld %08x %08x %08x %s\n", k, fbitsOf(step.before),
			        fbitsOf(nativeEfficacy), fbitsOf(step.pre), discriminates ? "differs" : "same");
		}

		fprintf(f, "summary candidates %ld clamped %ld differs %ld identical %ld current_mismatches %ld\n",
		        numSynapses, clamped, differs, numSynapses - differs, currentMismatch);
		fclose(f);

		delete[] preActs;
		delete[] postActs;

		if (differs == 0 || currentMismatch != 0)
		{
			fprintf(stderr, "learnclamp: %s: differs %ld, current_mismatches %ld\n", tag, differs, currentMismatch);
			failures++;
		}
	}

	return failures == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// learndelta mode
// ---------------------------------------------------------------------------
//
// `FiringRateModel::update`'s learning step forms
//
//     float efficacy = syn.efficacy + learningrate * (newneuronactivation[toneuron]-0.5)
//                                                 * (   neuronactivation[fromneuron]-0.5);
//
// and `0x5e8a8` contracts its *last* product with the add — `fmadd d17, d18, d19, d17` — with the
// double result narrowed by the float store. The pre-change port computed the sum in binary64,
// rounding the product first (`f32(syn.efficacy + learningrate * (a_to-0.5) * (a_from-0.5))`).
// The two forms differ by at most half an ulp of the product, so the store only sees them when the
// sum sits within about one *double* ulp of an f32 midpoint, and `learnclamp`'s family — whose
// delta is a product of two live activations — cannot reach that.
//
// This family makes the delta exact and the product free:
//
//   * the destination neuron is saturated: `bias` alone holds `logistic(.)` at exactly 1.0, so
//     `newneuronactivation[toneuron] - 0.5` is exactly 0.5 and the delta is `t = 0.5*lrate`, an
//     exact double;
//   * each row drives its own input neuron, whose activation the spec's `input` line carries at
//     full double precision, so `db = a_from - 0.5` is a free double;
//   * `lrate` is small enough that one ulp of the input's own grid moves the product by about a
//     ulp, which lets the search walk `db` onto the f32 midpoint above the stored efficacy, where
//     the fused and the round-product forms narrow to *different* floats.
//
// Only separating rows are emitted, and the mode exits non-zero when it finds none or when its own
// transcription disagrees with the shipped model: the report is the search's witness.
static double nextDoubleUp(double x)
{
	unsigned long long bits = dbitsOf(x);
	bits += 1;
	double out;
	memcpy(&out, &bits, sizeof(out));
	return out;
}

/** The port's current transcription of the delta: one contracted product+add, then the store. */
static float learnDeltaFused(double t, double db, double e)
{
	return (float) __builtin_fma(t, db, e);
}

/**
 * The pre-change form the mutation restores: the last product rounds on its own, then the add,
 * then the float store. `volatile` keeps `-ffp-contract=on` from re-fusing them, which would make
 * this identical to the function above and the whole family vacuous.
 */
static float learnDeltaRoundProduct(double t, double db, double e)
{
	volatile double product = t * db;
	volatile double sum = e + product;
	return (float) sum;
}

// The e family: one row each, all with an even f32 mantissa, so the f32 midpoint above `e`
// tie-breaks *down* to `e` and the fused form — one double ulp above that midpoint — is the mover.
static const float LearnDeltaE[] = {0.5f, 0.625f, 0.75f, 0.875f, 1.0f, 1.125f, 1.25f, 1.375f,
                                    1.5f, 1.625f, 1.75f, 1.875f, 2.0f, 2.25f, 2.5f, 2.75f};

static const int LearnDeltaMinRows = 8;

struct LearnDeltaRow
{
	float e;
	float lrate;
	double aFrom;
	float fused;
	float pre;
};

/**
 * Search one row for `e`. With the destination saturated the step is `e + t*db`, so the row is a
 * hit when the *exact* sum and the sum of the rounded product land on opposite sides of the f32
 * midpoint above `e`. `lrate` fixes where the input's grid falls relative to that midpoint (the
 * grid moves the product by `t * ulp(a_from)`), so the lrate family walks the alignment and, for
 * each, the neighbouring grid points are tested.
 */
static bool findLearnDeltaRow(float e, LearnDeltaRow *row)
{
	const double m = ((double) e + (double) nextafterf(e, INFINITY)) / 2.0; // the f32 midpoint above e
	const double uS = nextDoubleUp(m) - m;                                  // one double ulp there

	for (int side = 0; side < 2; side++)
	{
		// the sum's tie adjacent to the midpoint: the fused and the round-product sums straddle it
		const double pstar = (m - (double) e) + (side == 0 ? uS / 2.0 : -uS / 2.0);
		for (int j = 0; j < 256; j++)
		{
			const float lrate = (float) (2.0 * pstar * (2.0 + (double) j / 512.0));
			if (!(lrate > 0.0f)) continue;
			const double t = 0.5 * (double) lrate;
			const double dbTarget = pstar / t;
			if (!(dbTarget > 0.05 && dbTarget < 0.499)) continue;
			const double aFrom0 = 0.5 + dbTarget;  // the input grid point nearest the tie
			for (int q = -16; q <= 16; q++)
			{
				double aFrom = aFrom0;
				for (int z = 0; z < (q < 0 ? -q : q); z++)
					aFrom = nextafter(aFrom, q < 0 ? -INFINITY : INFINITY);
				const double db = aFrom - 0.5;
				const float fused = learnDeltaFused(t, db, (double) e);
				const float pre = learnDeltaRoundProduct(t, db, (double) e);
				if (fbitsOf(fused) == fbitsOf(pre)) continue;
				row->e = e;
				row->lrate = lrate;
				row->aFrom = aFrom;
				row->fused = fused;
				row->pre = pre;
				return true;
			}
		}
	}
	return false;
}

static int runLearnDelta(const std::string &outdir)
{
	std::vector<LearnDeltaRow> rows;
	for (size_t i = 0; i < NELEMS(LearnDeltaE); i++)
	{
		LearnDeltaRow row;
		if (findLearnDeltaRow(LearnDeltaE[i], &row)) rows.push_back(row);
	}
	if ((int) rows.size() < LearnDeltaMinRows)
	{
		fprintf(stderr, "learndelta: only %zu rows separate (want >= %d)\n", rows.size(), LearnDeltaMinRows);
		return 1;
	}

	const int numRows = (int) rows.size();
	// `logistic(64, 1.5)`: `exp(-96)` is ~4e-42, so `1 + exp(..)` rounds to 1.0 in binary64 and
	// the destination activation is exactly 1.0 (0x3f800000) for every row
	const float saturatingBias = 64.0f;

	Spec spec;
	spec.dims = NeuronModel::Dimensions();
	spec.dims.numInputNeurons = numRows;
	spec.dims.numOutputNeurons = numRows;
	spec.dims.numNeurons = 2 * numRows;
	spec.dims.numSynapses = numRows;
	spec.neurons.assign((size_t) spec.dims.numNeurons, NeuronSpec());
	spec.maxWeight = 8.0f;
	spec.maxBias = saturatingBias;
	spec.logisticSlope = 1.5f;
	spec.enableLearning = true;
	spec.minlrate = 0.0f;
	spec.maxlrate = 0.1f;
	spec.decayRate = 0.99f;
	spec.scaleLatestSpikes = 0.8f;
	spec.drandSeed = 20260928u;
	spec.spikingParams = 0;

	for (int j = 0; j < numRows; j++)
	{
		memset(&spec.neurons[(size_t) j], 0, sizeof(NeuronSpec)); // inputs: bias 0

		NeuronSpec n;
		memset(&n, 0, sizeof(n));
		n.bias = saturatingBias;
		n.tau = 0.5f;
		n.gain = 1.0f;
		n.start = j;
		n.end = j + 1;
		spec.neurons[(size_t) (numRows + j)] = n;

		SynapseSpec s;
		s.from = (short) j;
		s.to = (short) (numRows + j);
		s.efficacy = rows[(size_t) j].e;
		s.lrate = rows[(size_t) j].lrate;
		spec.synapses.push_back(s);
	}

	spec.inputs.assign(1, std::vector<double>((size_t) numRows, 0.0));
	for (int j = 0; j < numRows; j++) spec.inputs[0][(size_t) j] = rows[(size_t) j].aFrom;

	Brain::config.neuronModel = Brain::Configuration::FIRING_RATE;
	Brain::config.logisticSlope = spec.logisticSlope;
	Brain::config.maxWeight = spec.maxWeight;
	Brain::config.maxbias = spec.maxBias;
	Brain::config.enableLearning = spec.enableLearning;
	Brain::config.minlrate = spec.minlrate;
	Brain::config.maxlrate = spec.maxlrate;
	Brain::config.decayRate = spec.decayRate;
	Brain::config.learningMode = Brain::Configuration::LEARN_ALL;

	ProbeCns cns;
	ProbeBrain *brain = new ProbeBrain(&cns);
	cns.setBrain(brain);
	brain->setDims(spec.dims);
	brain->setNet(new FiringRateModel(&cns));

	NeuronModel *base = brain->getNeuronModel();
	base->init(&spec.dims, 0.1);
	initNeuronAttrs(base, spec, false, false);

	char path[1024];
	snprintf(path, sizeof(path), "%s/spec.learndelta.txt", outdir.c_str());
	FILE *specFile = fopen(path, "w");
	if (!specFile)
	{
		fprintf(stderr, "learndelta: cannot write %s\n", path);
		return 1;
	}
	writeSpec(specFile, spec, "firingrate", false, false);
	fclose(specFile);

	const long numNeurons = spec.dims.numNeurons;

	double *preActs = new double[(size_t) numNeurons];
	double *postActs = new double[(size_t) numNeurons];

	srand48((long) spec.drandSeed);
	const std::vector<double> &values = spec.inputs[0];
	brain->setActivations(const_cast<double *>(&values[0]), 0, (int) values.size());
	brain->getActivations(preActs, 0, (int) numNeurons);
	brain->update(false);
	brain->getActivations(postActs, 0, (int) numNeurons);

	snprintf(path, sizeof(path), "%s/learndelta.txt", outdir.c_str());
	FILE *f = fopen(path, "w");
	if (!f)
	{
		fprintf(stderr, "learndelta: cannot write %s\n", path);
		return 1;
	}
	fprintf(f, "# native FiringRateModel learning-step delta (0x5e890-0x5e8ac), driven through the\n");
	fprintf(f, "# shipped libpolyworld.dylib: one step of the model's own set_synapse -> update ->\n");
	fprintf(f, "# get_synapse round trip, with Brain::config.enableLearning true and every destination\n");
	fprintf(f, "# neuron saturated so the delta is exactly `0.5*lrate` and the row's own input neuron\n");
	fprintf(f, "# carries `a_from` at full double precision.  Replayed against spec.learndelta.txt.\n");
	fprintf(f, "#\n");
	fprintf(f, "# learndelta <k> <fused_bits> <native_bits> <pre_bits> <verdict>\n");
	fprintf(f, "#   fused   the port's current transcription: one `fmadd` product+add, then the float store\n");
	fprintf(f, "#   native  what the shipped model stored (the arbiter)\n");
	fprintf(f, "#   pre     the pre-change form: the product rounded, then the sum, then the store\n");
	fprintf(f, "#   verdict differs  the two forms narrow to different floats (the row has teeth)\n");
	fprintf(f, "#           same     they agree (a search bug: this mode fails rather than reporting it)\n");

	long differs = 0;
	long same = 0;
	long saturated = 0;
	long currentMismatch = 0;
	for (int j = 0; j < numRows; j++)
	{
		short from, to;
		float nativeEfficacy, lrate;
		base->get_synapse(j, from, to, nativeEfficacy, lrate);

		// the construction's own invariants: the destination is saturated (so the delta is exact)
		// and the pre-clamp value is inside the band the clamp chain does not fire in
		if (fbitsOf((float) postActs[to]) == fbitsOf(1.0f)) saturated++;
		if (fabs((double) rows[(size_t) j].fused) > 0.5 * (double) spec.maxWeight)
			fprintf(f, "# row %d: |fused| %.9g is outside the unclamped band\n", j, (double) rows[(size_t) j].fused);

		if (fbitsOf(rows[(size_t) j].fused) != fbitsOf(nativeEfficacy)) currentMismatch++;
		const bool discriminates = fbitsOf(rows[(size_t) j].pre) != fbitsOf(nativeEfficacy);
		if (discriminates) differs++;
		else same++;

		fprintf(f, "learndelta %d %08x %08x %08x %s\n", j, fbitsOf(rows[(size_t) j].fused),
		        fbitsOf(nativeEfficacy), fbitsOf(rows[(size_t) j].pre), discriminates ? "differs" : "same");
	}

	fprintf(f, "summary rows %d differs %ld same %ld saturated %ld current_mismatches %ld\n", numRows,
	        differs, same, saturated, currentMismatch);
	fclose(f);

	delete[] preActs;
	delete[] postActs;

	if (differs != numRows || saturated != numRows || currentMismatch != 0)
	{
		fprintf(stderr, "learndelta: differs %ld/%d, saturated %ld/%d, current_mismatches %ld\n", differs,
		        numRows, saturated, numRows, currentMismatch);
		return 1;
	}

	return 0;
}

// ---------------------------------------------------------------------------
// the `synapses` mode (the `SeedSynapsesFromRun` reader/writer pair) lives in its own file:
// it is the oracle-facing measurement for `Brain::dumpSynapses`/`loadSynapses`/
// `copySynapses`/`scaleSynapses`, and it reads as a unit.
// ---------------------------------------------------------------------------
#include "brainprobe_synapses.inc"

int main(int argc, char **argv)
{
	if (argc < 3)
	{
		fprintf(stderr, "usage: %s <models|format|math|growexpr|fma|learnclamp|learndelta|synapses> <outdir>\n", argv[0]);
		return 2;
	}

	std::string mode = argv[1];
	std::string outdir = argv[2];

	if (mode == "models") return runModels(outdir);
	if (mode == "format") return runFormat(outdir);
	if (mode == "math") return runMath(outdir);
	if (mode == "growexpr") return runGrowExpr(outdir);
	if (mode == "fma") return runFma(outdir);
	if (mode == "learnclamp") return runLearnClamp(outdir);
	if (mode == "learndelta") return runLearnDelta(outdir);
	if (mode == "synapses") return runSynapses(outdir);

	fprintf(stderr, "brainprobe: unknown mode '%s'\n", mode.c_str());
	return 2;
}
