// This file is machine-generated. See proplib/cppprops.cc

#include <assert.h>
#include <iostream>
#include <sstream>
#include "agent/Metabolism.h"
#include "environment/barrier.h"
#include "genome/GenomeUtil.h"
#include "proplib/cppprops.h"
#include "proplib/state.h"
#include "sim/globals.h"
#include "sim/Simulation.h"
#include "utils/misc.h"
using namespace std;
using namespace proplib;

static bool inited = false;

namespace proplib {

static proplib::CppProperties::PropertyMetadata metadata[] =
{
  { 
    "AgentCount",
    CppProperties::PropertyMetadata::Runtime,
    datalib::INT,
    NULL,
    NULL
  },
  { 
    "AgentMetabolisms[0].MetabolismAgentCount",
    CppProperties::PropertyMetadata::Runtime,
    datalib::INT,
    NULL,
    NULL
  },
  { 
    "Barriers[0].Z2",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::FLOAT,
    NULL,
    NULL
  },
  { 
    "Barriers[1].Z2",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::FLOAT,
    NULL,
    NULL
  },
  { 
    "Domains[0].FoodPatches[0].On",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::BOOL,
    NULL,
    NULL
  },
  { 
    "Domains[0].FoodPatches[1].On",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::BOOL,
    NULL,
    NULL
  },
  { 
    "Domains[0].FoodPatches[2].On",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::BOOL,
    NULL,
    NULL
  },
  { 
    "FoodCount",
    CppProperties::PropertyMetadata::Runtime,
    datalib::INT,
    NULL,
    NULL
  },
  { 
    "MinEnergyFractionToOffspring",
    CppProperties::PropertyMetadata::Dynamic,
    datalib::FLOAT,
    NULL,
    NULL
  },
  { 
    "Step",
    CppProperties::PropertyMetadata::Runtime,
    datalib::INT,
    NULL,
    NULL
  }
};

static int stage = -1;

// ------------------------------------------------------------
// --- CppProperties_Init()
// ---
// --- Invoked at init.
// ------------------------------------------------------------
void CppProperties_Init( proplib::CppProperties::UpdateContext *context )
{
  assert( !inited );
  // AgentCount
  {
    metadata[0].value = &(objectxsortedlist::gXSortedObjects.agentCount);
  }
  // AgentMetabolisms[0].MetabolismAgentCount
  {
    metadata[1].value = &(context->sim->fNumberAliveWithMetabolism[ Metabolism::get( 0 )->index ]);
  }
  // Barriers[0].Z2
  {
    metadata[2].value = &(barrier::gBarriers[ 0 ]->getPosition().zb);
  }
  // Barriers[1].Z2
  {
    metadata[3].value = &(barrier::gBarriers[ 1 ]->getPosition().zb);
  }
  // Domains[0].FoodPatches[0].On
  {
    metadata[4].value = &(context->sim->fDomains[ 0 ].fFoodPatches[ 0 ].on);
    // START EXPRESSION

                                    // C++ syntax
                                    FoodPatchTokenRing::add( context->sim->fDomains[ 0 ].fFoodPatches[ 0 ], // patch
                                                             150,            // maxPopulation
                                                             2000,           // timeout
                                                             400 );          // delay
    // END EXPRESSION
  }
  // Domains[0].FoodPatches[1].On
  {
    metadata[5].value = &(context->sim->fDomains[ 0 ].fFoodPatches[ 1 ].on);
    // START EXPRESSION
 FoodPatchTokenRing::add( context->sim->fDomains[ 0 ].fFoodPatches[ 1 ] );
    // END EXPRESSION
  }
  // Domains[0].FoodPatches[2].On
  {
    metadata[6].value = &(context->sim->fDomains[ 0 ].fFoodPatches[ 2 ].on);
    // START EXPRESSION
 FoodPatchTokenRing::add( context->sim->fDomains[ 0 ].fFoodPatches[ 2 ] );
    // END EXPRESSION
  }
  // FoodCount
  {
    metadata[7].value = &(objectxsortedlist::gXSortedObjects.foodCount);
  }
  // MinEnergyFractionToOffspring
  {
    metadata[8].value = &(genome::GeneType::to___Interpolated(genome::GenomeUtil::getGene("MateEnergyFraction", "./etc/worldfile.wfs:1619: Cannot find gene 'MateEnergyFraction'"))->smin.__val);
  }
  // Step
  {
    metadata[9].value = &(context->sim->fStep);
  }
  inited = true;
}

// ------------------------------------------------------------
// --- CppProperties_Update()
// ---
// --- Invoked once per step. Updates all dynamic properties.
// ------------------------------------------------------------
void CppProperties_Update( proplib::CppProperties::UpdateContext *context )
{
  assert( inited );
  // Barriers[0].Z2
  {
    struct local
    {
      static inline float update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION

          // We're now in C++ syntax

          // For first 10,000 steps we don't want barriers.
          if( *((int*)metadata[/*Step*/ 9].value) < 10 )
            return *((float*)metadata[/*Barriers[0].Z2*/ 2].value);

          // If population healthy, grow barrier.
          if( *((int*)metadata[/*AgentCount*/ 0].value) > 175 )
            return min( -0.1, *((float*)metadata[/*Barriers[0].Z2*/ 2].value) + 0.0001 ); // Don't let it go past -0.1

          // If population crashing, shrink barrier quickly.
          if( *((int*)metadata[/*AgentCount*/ 0].value) <= 90 )
            return max( -1.0, *((float*)metadata[/*Barriers[0].Z2*/ 2].value) - 0.001 );   // Don't let it go past -1.0

          // If population struggling, shrink barrier.
          if( *((int*)metadata[/*AgentCount*/ 0].value) < 120 )
            return max( -1.0, *((float*)metadata[/*Barriers[0].Z2*/ 2].value) - 0.0005 );   // Don't let it go past -1.0

          // Don't change anything
          return *((float*)metadata[/*Barriers[0].Z2*/ 2].value);
        // END EXPRESSION
      }
    };
    float newval = local::update( context );
    if( newval != *((float*)metadata[/*Barriers[0].Z2*/ 2].value))
    {
      *((float *)metadata[2].value) = newval;
    }
  }
  // Barriers[1].Z2
  {
    struct local
    {
      static inline float update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION
return ( *((float*)metadata[/*Barriers[0].Z2*/ 2].value) );
        // END EXPRESSION
      }
    };
    float newval = local::update( context );
    if( newval != *((float*)metadata[/*Barriers[1].Z2*/ 3].value))
    {
      *((float *)metadata[3].value) = newval;
    }
  }
  // Domains[0].FoodPatches[0].On
  {
    struct local
    {
      static inline bool update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION
return 
                                    // C++ syntax
                                    FoodPatchTokenRing::update( context->sim->fDomains[ 0 ].fFoodPatches[ 0 ] );
        // END EXPRESSION
      }
    };
    bool newval = local::update( context );
    if( newval != *((bool*)metadata[/*Domains[0].FoodPatches[0].On*/ 4].value))
    {
      *((bool *)metadata[4].value) = newval;
    }
  }
  // Domains[0].FoodPatches[1].On
  {
    struct local
    {
      static inline bool update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION
return  FoodPatchTokenRing::update( context->sim->fDomains[ 0 ].fFoodPatches[ 1 ] );
        // END EXPRESSION
      }
    };
    bool newval = local::update( context );
    if( newval != *((bool*)metadata[/*Domains[0].FoodPatches[1].On*/ 5].value))
    {
      *((bool *)metadata[5].value) = newval;
    }
  }
  // Domains[0].FoodPatches[2].On
  {
    struct local
    {
      static inline bool update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION
return  FoodPatchTokenRing::update( context->sim->fDomains[ 0 ].fFoodPatches[ 2 ] );
        // END EXPRESSION
      }
    };
    bool newval = local::update( context );
    if( newval != *((bool*)metadata[/*Domains[0].FoodPatches[2].On*/ 6].value))
    {
      *((bool *)metadata[6].value) = newval;
    }
  }
  // MinEnergyFractionToOffspring
  {
    struct local
    {
      static inline float update( proplib::CppProperties::UpdateContext *context ) 
      {
        // START EXPRESSION

  // C++ syntax from here on.
  if( *((int*)metadata[/*Step*/ 9].value) < 10 )
    return *((float*)metadata[/*MinEnergyFractionToOffspring*/ 8].value);

  return min( 0.5, *((float*)metadata[/*MinEnergyFractionToOffspring*/ 8].value) + 0.001 );
        // END EXPRESSION
      }
    };
    float newval = local::update( context );
    if( newval != *((float*)metadata[/*MinEnergyFractionToOffspring*/ 8].value))
    {
      *((float *)metadata[8].value) = newval;
    }
  }
}


// These provide public symbols we can access via dlsym()
extern "C"
{
  void __clink__CppProperties_Init( proplib::CppProperties::UpdateContext *context )
  {
    CppProperties_Init( context );
  }
  void __clink__CppProperties_Update( proplib::CppProperties::UpdateContext *context )
  {
    CppProperties_Update( context );
  }
  void __clink__CppProperties_GetMetadata( proplib::CppProperties::PropertyMetadata **result_metadata, int *result_count )
  {
    assert( inited );
    *result_metadata = metadata;
    *result_count = 10;
  }
}

}
