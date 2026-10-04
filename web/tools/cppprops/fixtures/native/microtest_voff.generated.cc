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
    "FoodCount",
    CppProperties::PropertyMetadata::Runtime,
    datalib::INT,
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
  // FoodCount
  {
    metadata[2].value = &(objectxsortedlist::gXSortedObjects.foodCount);
  }
  // Step
  {
    metadata[3].value = &(context->sim->fStep);
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
    *result_count = 4;
  }
}

}
