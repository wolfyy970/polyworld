// Lane L6 (brain core) — the `synapses` probe mode: `Brain::dumpSynapses` ->
// `Brain::loadSynapses` -> `copySynapses` / `scaleSynapses`.
//
// `#include`d by `brainprobe.cc` just above `main`, where every shared helper (the spec
// generator, `initNeuronAttrs`, `writeSpec`, `fbitsOf`, `ProbeCns`/`ProbeBrain`) is already
// defined; the mode is a separate file because that is where the oracle-facing measurement
// lives, not because it compiles on its own.
//
// What it drives, and why:
//
// * `Logs::brainEnd` writes `run/brain/synapses/synapses_<agent>_<stage>.txt` through
//   `Brain::dumpSynapses`, and `analysis::getNervousSystem` / `analysis::copyNervousSystem` /
//   `analysis::setMaxWeight` read it back through `Brain::loadSynapses` (with and without a
//   rescale) and `Brain::copySynapses`. `SeedSynapsesFromRun` is `False` in every recorded
//   scenario, so no frozen artifact reaches any of the three.
// * The dump is *text* and `%g` prints six significant digits, so the round trip is lossy for
//   a real brain's efficacies and lossless for short decimals. The two families bracket that:
//   `synrandom` (what `buildSpec` draws) and `synexact` (efficacies whose shortest exact
//   decimal form fits in six digits).
// * The header's `maxweight` is 7.3f: written with `%g` and read back with `%g` into a
//   `float`, and not a power of two, so a reader that keeps it in a `float` and one that keeps
//   it in a `double` divide by different divisors — which is what gives the rescale path
//   something to disagree about.
// * One internal neuron is left with no incoming synapse: `setSynapses` never rewrites a
//   neuron it never sees, so its range keeps the value the brain was grown with.
//
// Every value is reported as raw IEEE-754 bits (`%08x` of the float), never as `%g`, so the
// port cannot hide a 1-ulp divergence behind six digits. `syndump.<tag>.txt` is the exact byte
// sequence the shipped `dumpSynapses` produced, for a byte-level diff of the port's dumper.
// The report's own header comments name the columns; `summary` carries the counts.

#define SYNAPSES_NUM_INPUT 5
#define SYNAPSES_NUM_OUTPUT 6
#define SYNAPSES_NUM_INTERNAL 13
#define SYNAPSES_DUMP_INDEX 7

// Efficacies and learning rates whose shortest exact decimal form is six significant digits or
// fewer, so `%g` reproduces them and the dump round trip is lossless on them.
static const float SynExactEfficacy[] = {
	0.25f, -0.5f, 1.5f, 2.0f, 0.125f, -3.25f, 0.0625f, 1.0625f,
	8.0f, 0.5f, 4.0f, -2.5f, 0.375f, 1.25f, 0.1875f, 3.0f,
	0.75f, -0.0625f, 1.75f, -1.5f, 6.0f, 0.03125f, 2.5f, -0.125f,
	1.125f, 0.0f, 0.875f, -4.0f,
};

static const float SynExactLrate[] = {
	0.01f, 0.1f, -0.05f, 0.001f, 0.025f, 0.5f, 0.075f, -0.1f,
	0.02f, 0.0f, 0.9f, 0.0001f,
};

// The `maxWeight` values `analysis::setMaxWeight` is driven with. The header's own default
// (-1.0f, i.e. no rescale at all) is the `rt` family, reached through `loadSynapses`'s
// default argument.
static const float SynScaleMaxWeights[] = {0.0f, 1.0f, 2.5f, 6.0f, 7.3f, 3.14159f, 12.5f};

static void buildSynSpec(Spec &spec, bool exact)
{
	spec.dims = NeuronModel::Dimensions();
	const int numInput = SYNAPSES_NUM_INPUT;
	const int numOutput = SYNAPSES_NUM_OUTPUT;
	const int numNeurons = numInput + numOutput + SYNAPSES_NUM_INTERNAL;

	spec.dims.numInputNeurons = numInput;
	spec.dims.numOutputNeurons = numOutput;
	spec.dims.numNeurons = numNeurons;
	spec.neurons.assign((size_t) numNeurons, NeuronSpec());
	spec.synapses.clear();
	spec.inputs.clear();

	// input neurons: the growth path sets zeroed attributes
	for (int i = 0; i < numInput; i++)
	{
		NeuronSpec n;
		memset(&n, 0, sizeof(n));
		spec.neurons[(size_t) i] = n;
	}

	// outputs and internals: 2 and 3 incoming synapses respectively, laid down in to-neuron
	// order (the order `BaseNeuronModel::setSynapses` relies on)
	for (int i = numInput; i < numNeurons; i++)
	{
		NeuronSpec n;
		memset(&n, 0, sizeof(n));
		n.bias = float(uniform(-2.0, 2.0));
		n.tau = float(uniform(0.01, 1.0));
		n.gain = float(uniform(0.1, 10.0));
		n.start = (long) spec.synapses.size();

		// the last internal neuron gets nothing pointing at it: `setSynapses` leaves a neuron
		// it never sees exactly as it was, so its range has to survive the load untouched
		const bool wired = (i != numNeurons - 1);
		const int count = wired ? ((i < numInput + numOutput) ? 2 : 3) : 0;

		std::vector<int> froms;
		for (int k = 0; k < count; k++)
		{
			int from;
			do
			{
				from = randint(0, numNeurons - 1);
			} while (from == i || (k > 0 && from == froms[(size_t) k - 1]));
			froms.push_back(from);

			const size_t kk = spec.synapses.size();
			SynapseSpec s;
			s.from = (short) from;
			s.to = (short) i;
			if (exact)
			{
				s.efficacy = SynExactEfficacy[kk % NELEMS(SynExactEfficacy)];
				s.lrate = SynExactLrate[kk % NELEMS(SynExactLrate)];
			}
			else
			{
				// a mix of excitatory and inhibitory efficacies and rates
				double mag = uniform(0.05, 4.0);
				s.efficacy = float(u01() < 0.35 ? -mag : mag);
				s.lrate = float(u01() < 0.5 ? uniform(0.0, 0.1) : -uniform(0.0, 0.1));
			}
			spec.synapses.push_back(s);
		}

		n.end = (long) spec.synapses.size();
		spec.neurons[(size_t) i] = n;
	}

	spec.dims.numSynapses = (long) spec.synapses.size();

	spec.logisticSlope = 1.5f;
	// not a power of two, so `maxWeight / fileMaxWeight` is a real quotient *and* the `float`
	// and `double` readings of its `%g` text are different numbers
	spec.maxWeight = 7.3f;
	spec.maxBias = 8.0f;
	spec.enableLearning = false;
	spec.minlrate = 0.0f;
	spec.maxlrate = 0.1f;
	spec.decayRate = 0.99f;
	spec.scaleLatestSpikes = 0.8f;
	spec.drandSeed = 20260929u;
	spec.spikingParams = 0;
}

// The brain a dump is loaded *into* is not the brain it came from: `analysis::getNervousSystem`
// grows a fresh one from the genome first, so it holds that brain's own ranges until the load
// overwrites them (and `setSynapses` only rewrites the neurons it sees). Perturbing every range
// is what makes the `range`/`copyrange` rows below evidence about `setSynapses` rather than
// about the construction both sides share.
static void perturbSynRanges(FiringRateModel *model, Spec &spec)
{
	for (int i = 0; i < spec.dims.numNeurons; i++)
	{
		FiringRateModel__NeuronAttrs attrs;
		if (i < spec.dims.numInputNeurons)
		{
			attrs.bias = 0.0f;
			attrs.tau = 0.0f;
			attrs.gain = 0.0f;
		}
		else
		{
			const NeuronSpec &n = spec.neurons[(size_t) i];
			attrs.bias = n.bias;
			attrs.tau = n.tau;
			attrs.gain = n.gain;
		}
		model->set_neuron(i, &attrs, i, i + 1);
	}
}

// A freshly grown brain of `spec`'s shape: `dims` set, the model `init`ed and given the spec's
// neuron attributes and synapses — the state `loadSynapses`/`copySynapses` land on.
static ProbeBrain *makeSynBrain(Spec &spec, ProbeCns &cns, bool perturbRanges)
{
	cns.setBrain(NULL);
	ProbeBrain *brain = new ProbeBrain(&cns);
	cns.setBrain(brain);
	brain->setDims(spec.dims);

	FiringRateModel *model = new FiringRateModel(&cns);
	brain->setNet(model);
	model->init(&spec.dims, 0.1);
	initNeuronAttrs(model, spec, false, false);
	if (perturbRanges) perturbSynRanges(model, spec);

	return brain;
}

static int runSynapses(const std::string &outdir)
{
	// the corpus must not depend on the order the modes are run in
	g_lcg = 0x0123456789abcdefULL;

	for (int family = 0; family < 2; family++)
	{
		const bool exact = (family == 1);
		const char *tag = exact ? "synexact" : "synrandom";

		Spec spec;
		buildSynSpec(spec, exact);

		// configure the model exactly as Brain::processWorldfile/init would
		Brain::config.neuronModel = Brain::Configuration::FIRING_RATE;
		Brain::config.logisticSlope = spec.logisticSlope;
		Brain::config.maxWeight = spec.maxWeight;
		Brain::config.maxbias = spec.maxBias;
		Brain::config.enableLearning = spec.enableLearning;
		Brain::config.minlrate = spec.minlrate;
		Brain::config.maxlrate = spec.maxlrate;
		Brain::config.decayRate = spec.decayRate;
		Brain::config.learningMode = Brain::Configuration::LEARN_ALL;

		char path[1024];
		snprintf(path, sizeof(path), "%s/spec.%s.txt", outdir.c_str(), tag);
		FILE *specFile = fopen(path, "w");
		if (!specFile)
		{
			fprintf(stderr, "synapses: cannot write %s\n", path);
			return 1;
		}
		writeSpec(specFile, spec, "firingrate", false, false);
		fclose(specFile);

		ProbeCns sourceCns;
		ProbeBrain *source = makeSynBrain(spec, sourceCns, false);
		NeuronModel *sourceNet = source->getNeuronModel();

		// ---- what the recorder writes: Logs::brainEnd -> Brain::dumpSynapses ----
		std::string dumpPath = outdir + "/syndump." + tag + ".txt";
		AbstractFile *dump = AbstractFile::open(AbstractFile::TYPE_FILE, dumpPath.c_str(), "w");
		if (!dump)
		{
			fprintf(stderr, "synapses: cannot write %s\n", dumpPath.c_str());
			return 1;
		}
		source->dumpSynapses(dump, SYNAPSES_DUMP_INDEX);
		dump->close();

		// the header as both readers see it: `%g` out of the `float` config value, and `%g`
		// back into `Brain::loadSynapses`'s `float fileMaxWeight`
		char headerText[64];
		snprintf(headerText, sizeof(headerText), "%g", (double) spec.maxWeight);
		const float fileMaxWeight = strtof(headerText, NULL);

		snprintf(path, sizeof(path), "%s/synapses.%s.txt", outdir.c_str(), tag);
		FILE *f = fopen(path, "w");
		if (!f)
		{
			fprintf(stderr, "synapses: cannot write %s\n", path);
			return 1;
		}

		fprintf(f, "# native Brain::dumpSynapses -> loadSynapses -> copySynapses/scaleSynapses, driven\n");
		fprintf(f, "# through the shipped libpolyworld.dylib.  Every value is an IEEE-754 float in hex.\n");
		fprintf(f, "#\n");
		fprintf(f, "#   src <k> <from> <to> <eff> <lrate>          the brain the dump was taken from\n");
		fprintf(f, "#   rt <k> <from> <to> <eff> <lrate>           loadSynapses( dump ), default maxWeight\n");
		fprintf(f, "#   range <n> <start> <end>                    the ranges setSynapses re-derived\n");
		fprintf(f, "#   copy <k> <from> <to> <eff> <lrate>         copySynapses( the loaded brain )\n");
		fprintf(f, "#   copyrange <n> <start> <end>                 ... and the ranges it re-derived\n");
		fprintf(f, "#   scalemw <i> <maxWeight>                    the argument, one row per entry\n");
		fprintf(f, "#   scalefactor <i> <factor>                   `maxWeight / fileMaxWeight` in float\n");
		fprintf(f, "#   scale <i> <k> <eff>                         loadSynapses( dump, maxWeight )\n");
		fprintf(f, "family %s\n", tag);
		fprintf(f, "dumpindex %d\n", SYNAPSES_DUMP_INDEX);
		fprintf(f, "dims %d %d %d %ld\n", spec.dims.numNeurons, spec.dims.numInputNeurons,
		        spec.dims.numOutputNeurons, spec.dims.numSynapses);
		fprintf(f, "maxweight %08x\n", fbitsOf(spec.maxWeight));
		fprintf(f, "filemaxweight %08x\n", fbitsOf(fileMaxWeight));

		for (long k = 0; k < spec.dims.numSynapses; k++)
		{
			short from, to;
			float efficacy, lrate;
			sourceNet->get_synapse((int) k, from, to, efficacy, lrate);
			fprintf(f, "src %ld %d %d %08x %08x\n", k, (int) from, (int) to,
			        fbitsOf(efficacy), fbitsOf(lrate));
		}

		// ---- loadSynapses( file ), the default (`-1.0f`): no rescale ----
		ProbeCns loadCns;
		ProbeBrain *loaded = makeSynBrain(spec, loadCns, true);
		AbstractFile *in = AbstractFile::open(AbstractFile::TYPE_FILE, dumpPath.c_str(), "r");
		if (!in)
		{
			fprintf(stderr, "synapses: cannot read %s\n", dumpPath.c_str());
			return 1;
		}
		loaded->loadSynapses(in);
		in->close();

		FiringRateModel *loadedNet = (FiringRateModel *) loaded->getNeuronModel();
		long rtSame = 0;
		for (long k = 0; k < spec.dims.numSynapses; k++)
		{
			short from, to;
			float efficacy, lrate;
			sourceNet->get_synapse((int) k, from, to, efficacy, lrate);
			short from2, to2;
			float efficacy2, lrate2;
			loadedNet->get_synapse((int) k, from2, to2, efficacy2, lrate2);
			fprintf(f, "rt %ld %d %d %08x %08x\n", k, (int) from2, (int) to2,
			        fbitsOf(efficacy2), fbitsOf(lrate2));
			if (fbitsOf(efficacy2) == fbitsOf(efficacy) && fbitsOf(lrate2) == fbitsOf(lrate)) rtSame++;
		}
		for (int i = 0; i < spec.dims.numNeurons; i++)
			fprintf(f, "range %d %ld %ld\n", i, loadedNet->neuron[i].startsynapses,
			        loadedNet->neuron[i].endsynapses);

		// ---- copySynapses( other ) into another freshly grown brain ----
		ProbeCns copyCns;
		ProbeBrain *copied = makeSynBrain(spec, copyCns, true);
		copied->copySynapses(loaded);
		FiringRateModel *copiedNet = (FiringRateModel *) copied->getNeuronModel();
		long copySame = 0;
		for (long k = 0; k < spec.dims.numSynapses; k++)
		{
			short from, to, lfrom, lto;
			float efficacy, lrate, lefficacy, llrate;
			copiedNet->get_synapse((int) k, from, to, efficacy, lrate);
			loadedNet->get_synapse((int) k, lfrom, lto, lefficacy, llrate);
			fprintf(f, "copy %ld %d %d %08x %08x\n", k, (int) from, (int) to,
			        fbitsOf(efficacy), fbitsOf(lrate));
			if (from == lfrom && to == lto && fbitsOf(efficacy) == fbitsOf(lefficacy) &&
			    fbitsOf(lrate) == fbitsOf(llrate)) copySame++;
		}
		for (int i = 0; i < spec.dims.numNeurons; i++)
			fprintf(f, "copyrange %d %ld %ld\n", i, copiedNet->neuron[i].startsynapses,
			        copiedNet->neuron[i].endsynapses);

		// ---- loadSynapses( file, maxWeight ): the rescale path (analysis::setMaxWeight) ----
		long scaleRows = 0;
		long scaleChanged = 0;
		for (size_t m = 0; m < NELEMS(SynScaleMaxWeights); m++)
		{
			const float maxWeight = SynScaleMaxWeights[m];
			// exactly what `Brain::loadSynapses` computes: a `float` over a `float`
			const float factor = maxWeight / fileMaxWeight;
			fprintf(f, "scalemw %zu %08x\n", m, fbitsOf(maxWeight));
			fprintf(f, "scalefactor %zu %08x\n", m, fbitsOf(factor));

			ProbeCns scaleCns;
			ProbeBrain *scaled = makeSynBrain(spec, scaleCns, true);
			AbstractFile *in2 = AbstractFile::open(AbstractFile::TYPE_FILE, dumpPath.c_str(), "r");
			if (!in2)
			{
				fprintf(stderr, "synapses: cannot read %s\n", dumpPath.c_str());
				return 1;
			}
			scaled->loadSynapses(in2, maxWeight);
			in2->close();

			NeuronModel *scaledNet = scaled->getNeuronModel();
			for (long k = 0; k < spec.dims.numSynapses; k++)
			{
				short from, to;
				float efficacy, lrate, lefficacy, llrate;
				scaledNet->get_synapse((int) k, from, to, efficacy, lrate);
				loadedNet->get_synapse((int) k, from, to, lefficacy, llrate);
				fprintf(f, "scale %zu %ld %08x\n", m, k, fbitsOf(efficacy));
				if (fbitsOf(efficacy) != fbitsOf(lefficacy)) scaleChanged++;
				scaleRows++;
			}
		}

		fprintf(f, "summary synapses %ld rt_same %ld copy_same %ld scale_rows %ld scale_changed %ld\n",
		        spec.dims.numSynapses, rtSame, copySame, scaleRows, scaleChanged);
		fclose(f);

		// The families' own invariants. `synexact` must survive the round trip (it is the
		// lossless family) and `synrandom` must not (otherwise `%g`'s six digits are not what
		// the dump loses, and the corpus would be proving something else); the copy never goes
		// through text, so it must be a bit copy on both.
		const long rtDiff = spec.dims.numSynapses - rtSame;
		if (copySame != spec.dims.numSynapses)
		{
			fprintf(stderr, "synapses: %s: copySynapses was not a bit copy (%ld/%ld)\n", tag,
			        copySame, spec.dims.numSynapses);
			return 1;
		}
		if (exact && rtDiff != 0)
		{
			fprintf(stderr, "synapses: %s: the lossless family lost %ld rows\n", tag, rtDiff);
			return 1;
		}
		if (!exact && rtDiff == 0)
		{
			fprintf(stderr, "synapses: %s: nothing was lost, so the corpus proves nothing\n", tag);
			return 1;
		}
		if (scaleChanged == 0)
		{
			fprintf(stderr, "synapses: %s: no maxWeight moved an efficacy\n", tag);
			return 1;
		}

		fprintf(stderr, "synapses: %s synapses=%ld rt_same=%ld copy_same=%ld scale_rows=%ld scale_changed=%ld\n",
		        tag, spec.dims.numSynapses, rtSame, copySame, scaleRows, scaleChanged);
	}

	return 0;
}
