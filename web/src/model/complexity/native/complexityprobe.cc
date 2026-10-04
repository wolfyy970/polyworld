// Lane L13 (complexity) — native differential probe.
//
// The lane's oracle is `run/genome/AdamiComplexity-*.txt` and the `complexity_*` columns, but
// neither recorded scenario runs with `ComplexityFitnessWeight != 0`, so no golden pins a
// complexity number. This probe produces them, from the oracle's *own* code:
//
//   * `brain`   drives the real `CalcComplexity_brainfunction()` over the recorded
//               `run/brain/function/brainFunction_<n>.txt.gz` fixtures for a set of `parts`
//               strings, printing the bits of every returned double (plus the agent number,
//               neuron counts and lifespan the reader reports).
//   * `pieces`  rebuilds `CalcApproximateFullComplexityWithMatrix`'s pipeline step by step
//               (`gsamp` after the noise injection, `calcCOV`, `determinant`, `CalcI`,
//               `calcC_k_exact`) over a matrix it generates itself from a private LCG, so a
//               port can be bisected stage by stage instead of only end to end. The probe
//               checks its own replication against the library's
//               `CalcApproximateFullComplexityWithMatrix` and exits non-zero if the two
//               disagree -- an independent confirmation that the pipeline as read off the
//               source is the pipeline the shipped code runs.
//   * `adami`   NOT IMPLEMENTED, and deliberately so: `computeAdamiComplexity` reads
//               `GenomeUtil::schema->getMutableSize()` and walks
//               `objectxsortedlist::gXSortedObjects` for live agents, and neither is reachable
//               outside the simulation's boot (`tools/cppprops`' `genevalueprobe.cc` documents the
//               same wall for `GenomeUtil::createSchema()`). Adami is therefore pinned two other
//               ways: `../adami_reference.py`, an independent implementation of the same
//               arithmetic in another language (`../golden/adami/`, asserted by
//               `tests/complexity-adami.test.ts`), and the recorded scenario `minitest_adami`
//               (`tools/scenarios.d/minitest_adami.json`, `--RecordAdamiComplexity True`), whose
//               four `run/genome/AdamiComplexity-*.txt` files are native's own output for a whole
//               run and which the same test compares against.
//
// Everything it writes is text with raw IEEE-754 bit patterns, so a one-ulp divergence cannot
// hide behind a printed precision.
//
// Usage: complexityprobe <brain|pieces> <outdir> [args...]

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <dirent.h>
#include <map>
#include <string>
#include <vector>

#include "complexity/complexity_algorithm.h"
#include "complexity/complexity_brain.h"
#include "utils/AbstractFile.h"
#include "utils/next_combination.h"
#include <gsl/gsl_linalg.h>
#include <gsl/gsl_permutation.h>

/**
 * Dump `calcC_k_exact`'s own loop: the index array `next_combination` walks, the determinant of
 * each cross-section and its `CalcI`. This is the trace that pins the *sum order* (the port
 * must sum the same subsets in the same sequence, because floating-point addition is not
 * associative) together with the per-subset determinant and integration.
 */
static void dumpCkTrace(FILE *out, const char *label, gsl_matrix *COV, int k)
{
	int n = COV->size1;
	int index[n];
	for (int i = 0; i < n; i++) index[i] = i;

	double sumI_k = 0;
	int nc = 0;
	do {
		gsl_matrix *xCOV = matrix_crosssection(COV, index, k);
		double det = determinant(xCOV);
		double I = CalcI(xCOV, det);
		unsigned long long ud, ui;
		memcpy(&ud, &det, 8);
		memcpy(&ui, &I, 8);
		fprintf(out, "ck %s %d k %d idx", label, nc, k);
		for (int i = 0; i < k; i++) fprintf(out, " %d", index[i]);
		fprintf(out, " det %016llx I %016llx\n", ud, ui);

		// The LU factors of this cross-section, so a port that is 1 ulp off can be bisected to
		// the exact element/step instead of guessed at.
		{
			int m = xCOV->size1;
			gsl_matrix *lu = gsl_matrix_alloc(m, m);
			gsl_matrix_memcpy(lu, xCOV);
			gsl_permutation *perm = gsl_permutation_alloc(m);
			int sign = 0;
			gsl_linalg_LU_decomp(lu, perm, &sign);
			fprintf(out, "lu %s %d sign %d perm", label, nc, sign);
			for (int i = 0; i < m; i++) fprintf(out, " %zu", gsl_permutation_get(perm, i));
			fprintf(out, "\n");
			for (int a = 0; a < m; a++)
				for (int b = 0; b < m; b++) {
					unsigned long long uv;
					double v = gsl_matrix_get(lu, a, b);
					memcpy(&uv, &v, 8);
					fprintf(out, "lu %s %d a %d %d %016llx\n", label, nc, a, b, uv);
				}
			gsl_matrix_free(lu);
			gsl_permutation_free(perm);
		}
		sumI_k += I;
		nc++;
		gsl_matrix_free(xCOV);
	} while (next_combination(index, index + k, index + n));
	unsigned long long us;
	memcpy(&us, &sumI_k, 8);
	fprintf(out, "ck %s sumI_k %d %016llx\n", label, nc, us);
}

// `complexity_algorithm.h:43` declares `gsamp( gsl_matrix_view )` but
// `complexity_algorithm.cc:129` *defines* `gsamp( gsl_matrix * )`. The library was built from
// the definition, so the probe declares the real one. (L13 PORT-NOTE: the port follows the
// definition -- a `gsl_matrix_view` here would be a by-value copy, i.e. a no-op.)
void gsamp( gsl_matrix *m );

// ---------------------------------------------------------------------------
// deterministic, model-independent input generator (never the model's RNG)
// ---------------------------------------------------------------------------
static unsigned long long g_lcg = 0x2545f4914f6cdd1dULL;

static double u01()
{
	g_lcg = g_lcg * 6364136223846793005ULL + 1442695040888963407ULL;
	return double((g_lcg >> 11) & ((1ULL << 53) - 1)) / double(1ULL << 53);
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------
static void putBits(FILE *f, const char *label, double v)
{
	unsigned long long u;
	memcpy(&u, &v, 8);
	fprintf(f, "%s %016llx %.17g\n", label, u, v);
}

static FILE *openOut(const std::string &outdir, const char *name)
{
	std::string path = outdir + "/" + name;
	FILE *f = fopen(path.c_str(), "w");
	if (!f) {
		fprintf(stderr, "complexityprobe: cannot write %s\n", path.c_str());
		exit(2);
	}
	return f;
}

// ---------------------------------------------------------------------------
// the fixture list
// ---------------------------------------------------------------------------
// The library's own `get_list_of_brainfunction_logfiles()` matches the substring
// `_brainFunction_`, which misses `run/brain/function/brainFunction_<n>.txt.gz` (no leading
// underscore) and so lists only the `incomplete_*` files. The probe wants both sets, so it
// scans the directory itself with the same rule the recorder uses to *name* them:
// `_brainFunction_` or a `brainFunction_` leaf, minus MATLAB exports.
static std::vector<std::string> listBrainFunctionFiles(const std::string &dir)
{
	std::vector<std::string> z;
	DIR *d = opendir(dir.c_str());
	if (!d) {
		fprintf(stderr, "complexityprobe: cannot opendir('%s')\n", dir.c_str());
		exit(2);
	}
	struct dirent *entry;
	while ((entry = readdir(d)) != NULL) {
		std::string name = entry->d_name;
		if (name.find("brainFunction") == std::string::npos) continue;
		if (name.find(".txt.mat") != std::string::npos) continue;
		bool txt = name.size() >= 4 && name.compare(name.size() - 4, 4, ".txt") == 0;
		bool gz = name.size() >= 7 && name.compare(name.size() - 7, 7, ".txt.gz") == 0;
		if (!txt && !gz) continue;
		z.push_back(dir + "/" + name);
	}
	closedir(d);
	std::sort(z.begin(), z.end());
	return z;
}

// ---------------------------------------------------------------------------
// brain: the real CalcComplexity_brainfunction over the recorded fixtures
// ---------------------------------------------------------------------------
static int runBrain(const std::string &outdir, int argc, char **argv)
{
	if (argc < 4) {
		fprintf(stderr, "usage: complexityprobe brain <outdir> <fixtureDir> [parts...]\n");
		return 2;
	}
	std::string fixtureDir = argv[3];
	std::vector<std::string> parts;
	for (int i = 4; i < argc; i++) parts.push_back(argv[i]);
	if (parts.empty()) {
		const char *defaults[] = {"A", "P", "I", "B", "PI", "I10", "P10"};
		for (const char *p : defaults) parts.push_back(p);
	}

	FILE *out = openOut(outdir, "brain.txt");
	std::vector<std::string> files = listBrainFunctionFiles(fixtureDir);
	fprintf(out, "# files %zu\n", files.size());

	// NOTE: `parts == "H"` alone selects a single column, and native then calls
	// `determinant()` on a 0x0 sub-matrix inside `calcC_k_exact( n-1 = 0 )`, which trips
	// GSL's `gsl_permutation_alloc(0)` error and *aborts the process*. It is not in the
	// default list for that reason; the port raises instead (PORT-NOTE
	// L13/single-column-aborts).

	for (const std::string &file : files) {
		// The reader reports the shape; a failure to open exits inside the library, so the
		// probe only ever sees readable files.
		for (const std::string &part : parts) {
			long agent = -1, lifespan = -1, numneu = -1;
			double c = CalcComplexity_brainfunction(file.c_str(), part.c_str(), NULL, false, 0,
								&agent, &lifespan, &numneu);
			fprintf(out, "file %s part %s agent %ld numneurons %ld lifespan %ld ",
				file.c_str(), part.c_str(), agent, numneu, lifespan);
			unsigned long long u;
			memcpy(&u, &c, 8);
			fprintf(out, "complexity %016llx %.17g\n", u, c);
			fflush(out);
		}
	}
	fclose(out);
	printf("complexityprobe: wrote %s/brain.txt\n", outdir.c_str());
	return 0;
}

// ---------------------------------------------------------------------------
// pieces: the CalcApproximateFullComplexityWithMatrix pipeline, stage by stage
// ---------------------------------------------------------------------------
static int runPieces(const std::string &outdir, int argc, char **argv)
{
	int rows = argc > 3 ? atoi(argv[3]) : 12;
	int cols = argc > 4 ? atoi(argv[4]) : 5;
	int numPoints = argc > 5 ? atoi(argv[5]) : 1;

	char name[64];
	snprintf(name, sizeof name, "pieces-%dx%d-np%d.txt", rows, cols, numPoints);
	FILE *out = openOut(outdir, name);
	fprintf(out, "# rows %d cols %d numPoints %d\n", rows, cols, numPoints);
	fprintf(out, "# seed 0x2545f4914f6cdd1d\n");

	// The port rebuilds this matrix from the same LCG, so it must be exactly reproducible.
	g_lcg = 0x2545f4914f6cdd1dULL;
	gsl_matrix *data = gsl_matrix_alloc(rows, cols);
	for (int i = 0; i < rows; i++)
		for (int j = 0; j < cols; j++)
			gsl_matrix_set(data, i, j, u01() * 2.0 - 0.5);

	for (int i = 0; i < rows; i++)
		for (int j = 0; j < cols; j++) {
			fprintf(out, "input %d %d ", i, j);
			unsigned long long u;
			double v = gsl_matrix_get(data, i, j);
			memcpy(&u, &v, 8);
			fprintf(out, "%016llx\n", u);
		}

	// ---- replicate CalcApproximateFullComplexityWithMatrix -------------------------------
	setGaussianize(true);
	gsl_matrix *m = gsl_matrix_alloc(data->size1, data->size2);
	gsl_rng *randNumGen = create_rng(DEFAULT_SEED);

	double noise_scale = 0.00001;
	for (size_t i = 0; i < data->size1; i++)
		for (size_t j = 0; j < data->size2; j++)
			gsl_matrix_set(m, i, j, gsl_matrix_get(data, i, j) + noise_scale * gsl_ran_ugaussian(randNumGen));

	gsamp(m);

	for (size_t i = 0; i < m->size1; i++)
		for (size_t j = 0; j < m->size2; j++) {
			fprintf(out, "noisygsamp %zu %zu ", i, j);
			unsigned long long u;
			double v = gsl_matrix_get(m, i, j);
			memcpy(&u, &v, 8);
			fprintf(out, "%016llx %.17g\n", u, v);
		}

	gsl_matrix *COV = calcCOV(m);
	double det = determinant(COV);
	double I_n = CalcI(COV, det);

	for (size_t i = 0; i < COV->size1; i++)
		for (size_t j = 0; j < COV->size2; j++) {
			fprintf(out, "cov %zu %zu ", i, j);
			unsigned long long u;
			double v = gsl_matrix_get(COV, i, j);
			memcpy(&u, &v, 8);
			fprintf(out, "%016llx %.17g\n", u, v);
		}
	putBits(out, "det", det);
	putBits(out, "I_n", I_n);

	size_t n = COV->size1;
	putBits(out, "ck_exact_nm1", calcC_k_exact(COV, I_n, (int) n - 1));
	if (n >= 2)
		putBits(out, "ck_exact_half", calcC_k_exact(COV, I_n, (int) n / 2));
	putBits(out, "calcC_k_nm1", calcC_k(COV, I_n, (int) n - 1));

	dumpCkTrace(out, "nm1", COV, (int) n - 1);
	if (n >= 2) dumpCkTrace(out, "half", COV, (int) n / 2);

	gsl_matrix_free(COV);
	gsl_matrix_free(m);
	dispose_rng(randNumGen);

	// ---- cross-check the replication against the library's own function --------------------
	double viaLibrary = CalcApproximateFullComplexityWithMatrix(data, numPoints);
	double viaReplication;
	{
		gsl_matrix *m2 = gsl_matrix_alloc(data->size1, data->size2);
		gsl_rng *rng2 = create_rng(DEFAULT_SEED);
		for (size_t i = 0; i < data->size1; i++)
			for (size_t j = 0; j < data->size2; j++)
				gsl_matrix_set(m2, i, j,
					       gsl_matrix_get(data, i, j) + 0.00001 * gsl_ran_ugaussian(rng2));
		gsamp(m2);
		gsl_matrix *C2 = calcCOV(m2);
		double d2 = determinant(C2);
		double i2 = CalcI(C2, d2);
		viaReplication = calcC_k_exact(C2, i2, (int) C2->size1 - 1);
		gsl_matrix_free(C2);
		gsl_matrix_free(m2);
		dispose_rng(rng2);
	}
	putBits(out, "complexity_library", viaLibrary);
	putBits(out, "complexity_replication", viaReplication);
	fclose(out);

	if (viaLibrary != viaReplication) {
		fprintf(stderr,
			"complexityprobe: the pipeline replica does NOT reproduce "
			"CalcApproximateFullComplexityWithMatrix (%.17g vs %.17g) -- do not trust "
			"pieces.txt\n",
			viaLibrary, viaReplication);
		return 3;
	}
	printf("complexityprobe: wrote %s/pieces.txt (replica matches the library)\n", outdir.c_str());
	gsl_matrix_free(data);
	return 0;
}

int main(int argc, char **argv)
{
	if (argc < 3) {
		fprintf(stderr, "usage: %s <brain|pieces> <outdir> [args...]\n", argv[0]);
		return 2;
	}
	std::string mode = argv[1];
	std::string outdir = argv[2];
	if (mode == "brain") return runBrain(outdir, argc, argv);
	if (mode == "pieces") return runPieces(outdir, argc, argv);
	fprintf(stderr, "complexityprobe: unknown mode '%s'\n", mode.c_str());
	return 2;
}
