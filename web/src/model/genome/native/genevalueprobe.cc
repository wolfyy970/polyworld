/**
 * genevalueprobe.cc — the native read of an interpolated gene's `Scalar` (lane L5).
 *
 * A `$[gene, NAME, min|max]` cpp symbol expands to
 *
 *     genome::GeneType::to___Interpolated( genome::GenomeUtil::getGene( "NAME", err ) )
 *         ->smin|smax.__val
 *
 * and `CppProperties_Init()` uses it as the property's storage
 * (`metadata[i].value = &(…)`).  `smin`/`smax` are `Scalar`s and `__val` is the
 * first member of `Scalar`'s
 *
 *     union { void *__val; int ival; float fval; bool bval; };
 *
 * so `&(s.__val)` is the union's address and the *property's own* type decides
 * which member the native then reads:
 *
 *     PropertyMetadata::toString()   *(float *)value / *(int *)value / *(bool *)value
 *     the update body                *((float *)metadata[i].value) …
 *
 * That read is the part of the gene symbol a probe can measure without the
 * simulation: which `Scalar` a worldfile's gene holds is ground truth the native
 * binary writes itself (`run/genome/meta/generange.txt`, `Gene::printRanges`);
 * lane L5 reproduces those files byte-for-byte and the recorded farm logs carry
 * the value end to end (`tools/cppprops/fixtures/native/gene_dyn.farm.log`).
 * What is *not* reachable from a standalone probe is `GenomeUtil::getGene()`: it
 * needs `GenomeUtil::createSchema()`, which reads the worldfile through
 * `Config` / `Brain::config` / `agent::config` — the simulation's boot.  (That is
 * why PARITY.md calls this lane "byte-exact for everything the lane can produce
 * without the simulation".)
 *
 * So this probe pins the union read itself, over `Scalar`s built here — the three
 * cases the `gene` binding (`tools/cppprops/bindings/gene.mjs`) has to tell
 * apart:
 *
 *   FLOAT `Scalar`, FLOAT property  -> the value
 *   INT   `Scalar`, FLOAT property  -> the int's 32 bits read as an f32
 *   FLOAT `Scalar`, INT property    -> the float's 32 bits read as an int32
 *   BOOL  `Scalar`, FLOAT/INT property -> UNDEFINED: `Scalar::Scalar(bool)` writes
 *       one byte (bval) and the union's remaining bytes are never initialized.
 *       The port refuses this read rather than inventing a value; the probe prints
 *       `undefined` for it and says why.  (`*(bool *)value` touches only the
 *       written byte, so it is defined for every kind.)
 *
 * The native tree is the oracle and is READ-ONLY: this includes its headers and
 * links its already-built `libpolyworld.dylib` — see run_genevalueprobe.sh.
 */

#include <stdio.h>
#include <string.h>

#include "utils/Scalar.h"

namespace
{
	struct Row
	{
		const char *label;
		Scalar scalar;
	};

	const char *typeName( Scalar::Type type )
	{
		switch( type )
		{
		case Scalar::INVALID:
			return "INVALID";
		case Scalar::INT:
			return "INT";
		case Scalar::FLOAT:
			return "FLOAT";
		case Scalar::BOOL:
			return "BOOL";
		}
		return "?";
	}

	/** The first 4 bytes of the union, as the native's `*(float *)`/`*(int *)` see them. */
	unsigned int lowBits( const void *address )
	{
		unsigned int bits = 0;
		memcpy( &bits, address, sizeof( bits ) );
		return bits;
	}

	void printRow( const Row &row )
	{
		// The native read: `*(T *)( &(scalar.__val) )`, T the *property's* type.
		const void *address = (const void *)&(row.scalar.__val);
		const float asFloat = *(const float *)address;
		const int asInt = *(const int *)address;
		const bool asBool = *(const bool *)address;
		const Scalar::Type type = row.scalar.type;
		const unsigned int bits = lowBits( address );

		printf( "scalar label=%s kind=%s str=%s", row.label, typeName( type ), row.scalar.str().c_str() );
		if( type == Scalar::BOOL )
		{
			// Bytes 1..3 of the union were never written, so even the *bits* are
			// indeterminate here; the native float/int read of a BOOL Scalar is
			// undefined, and printing one would be inventing it.
			printf( " low32=undefined float=undefined int=undefined" );
		}
		else
		{
			printf( " low32=%08x float=%.17g int=%d", bits, (double)asFloat, asInt );
		}
		printf( " bool=%s\n", asBool ? "True" : "False" );
	}
}

int main()
{
	printf( "# genevalueprobe — the native union read of an interpolated gene's Scalar.\n" );
	printf( "# &(Scalar::__val) is the union's address; the property's own type picks the member.\n" );
	printf( "# float= / int= are undefined for a BOOL Scalar (Scalar::Scalar(bool) writes bval only).\n" );

	// 0.5 and 0.2 are measured gene minima: `MateEnergyFraction` is `FLOAT 0.500000`
	// in the gene_dyn recording and `FLOAT 0.200000` in the oracle scenarios'
	// `run/genome/meta/generange.txt`; -0.970895 is a barrier value from the
	// growers_dyn farm log, i.e. an f32 that is not exactly representable.
	const Row rows[] =
	{
		{ "float_0.2", Scalar( (float)0.2 ) },
		{ "float_0.5", Scalar( (float)0.5 ) },
		{ "float_-0.970895", Scalar( (float)-0.970895 ) },
		{ "int_7", Scalar( (int)7 ) },
		{ "int_-1", Scalar( (int)-1 ) },
		{ "int_1065353216", Scalar( (int)1065353216 ) },
		{ "bool_true", Scalar( (bool)true ) },
		{ "bool_false", Scalar( (bool)false ) },
	};

	for( size_t i = 0; i < sizeof( rows ) / sizeof( rows[0] ); i++ )
		printRow( rows[i] );

	return 0;
}
