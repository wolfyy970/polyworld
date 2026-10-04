# sim-spec — port spec for the simulation loop (lane L11, fan-in)

Owner: lane W1i (this file). Native source: `../polyworld/src/library/sim/**`.
Written for the TypeScript port; every fact below is quoted from the native tree with
`file:line`, and every claim that was *measured* rather than *read* is marked
**[measured]** with the command that produced it.

Extracted: 2026-09-28. Native tree at `polyworld`
(commit state of that checkout — the tree is the oracle and is now frozen by parity).

> Read this with `PORT_SPEC.md` (rules) and `PARITY.md` (status) open. Where this spec
> makes a decision that the C++ leaves implicit, it is tagged `PORT-NOTE(name)`; each of
> those names has a row in "PORT-NOTEs" at the end and must be mirrored into `PARITY.md`.

---

## 0. Scope

Covers the step loop and everything the step loop owns:

* object construction / `Init` phase order (`TSimulation::TSimulation`, `Simulation.cc:189-473`)
* `TSimulation::Step` and its callees (`Simulation.cc:560-3420`, `3706-3817`)
* iteration-order and scheduler semantics (`Scheduler.cc`, `objectxsortedlist.cc`)
* fitness / epoch logic and the fittest lists (`2864-2909`, `3642-3701`, `FittestList.cc`)
* seeding, `srand48` calls, and lockstep replay (`1051-1215`, `1925-2035`, `5303-5362`)
* the `End` / destructor phase (`744-781`, `479-554`)
* every clock read and every RNG read reachable from the loop

Out of scope (owned elsewhere, referenced only as interfaces): agent physiology
(`agent::UpdateBody`, L8), retina/vision (`agent::UpdateVision`, `Retina.cc`, L9/L16),
brains (`NervousSystem::update`, L6/L7), environment (`FoodPatch`, `Patch`, `brick`,
`barrier`, L10), loggers (L12), monitors (L14).

Acceptance test for this document: a reader can implement `Step()` in TypeScript, in the
order given in §4 + §11, without opening the C++.

---

## 1. Where the loop lives

| Concern | Native | Lines |
|---|---|---|
| Simulation object, all phases | `library/sim/Simulation.cc` | 5374 |
| Its surface + inline helpers | `library/sim/Simulation.h` | 588 |
| Per-step parallel-serial scheduler | `library/sim/Scheduler.{h,cc}` | 29 / 83 |
| Thread pool | `library/utils/ThreadPool.{h,cc}` | — / 151 |
| Global x-sorted object list | `library/utils/objectxsortedlist.{h,cc}` | 60 / 530 |
| Domain record | `library/sim/Domain.h` | 89 |
| Fittest lists | `library/sim/FittestList.{h,cc}` | 52 / 124 |
| Gene stats | `library/sim/GeneStats.cc` | 100 |
| Eat statistics | `library/sim/EatStatistics.cc` | 129 |
| Constants (`MAXDOMAINS=10`, `MAXMETABOLISMS=10`, `MAXFITNESSITEMS=5`, mate/fight/give status bits) | `library/sim/simconst.h` | 89 |
| Globals (`worldsize`, edge mode, energy types, record file type) | `library/sim/globals.{h,cc}` | 41 / 17 |
| RNG façade | `library/utils/RandomNumberGenerator.{h,cc}` | 64 / 134 |
| `randpw()` etc. | `library/utils/misc.h:40-44`, `misc.cc` | — |
| App driver (outer loop) | `app/ui/SimulationController.cc:173-178` | — |
| Birth/death reason enums | `library/agent/LifeSpan.h` | 77 |
| Per-step event matrix (`eat`/`mate` flags used by the events logger) | `library/utils/Events.h` | 80 |

Outer loop: `SimulationController::execStep()` (`SimulationController.cc:173-178`) calls
`simulation->Step()` once per `QTimer` tick; the tick interval is `1000/stepsPerSecond`
ms, and `StepsPerSecond 0` means "as fast as the event loop allows"
(`SimulationController.cc:63-77`). `End()` fires the `ended` signal
(`Simulation.h:144`) which exits the Qt event loop (`SimulationController.cc:183-186`).
**The timer is pacing only — it never changes model state** (`Simulation.h:247-249`).

---

## 2. State the loop owns

* `fStep` (static, `Simulation.cc:92`) — 1-based; incremented at the top of `Step()`.
* `objectxsortedlist::gXSortedObjects` — *the* ordered list of **all** world objects
  (agents, food, bricks). See §3.2. Its counts (`agentCount`, `foodCount`, `brickCount`)
  are maintained by add/remove, and `agentCount` must equal `fNumberAlive`
  (asserted at `Simulation.cc:682`).
* Per-domain records `fDomains[MAXDOMAINS]` (`Domain.h:12-64`): bounds, agent/food
  counts, per-domain min/max/init agents, creation bookkeeping, `energyScaleFactor`,
  `fittest`, and the smite queue `fLeastFit` / `fNumLeastFit` / `fNumSmited`.
* Population & tallies: `fNumberAlive`, `fNumberAliveWithMetabolism[]`,
  `fNumberBorn`, `fNumberBornVirtual`, `fNumberDied*`, `fNumberCreated*`,
  `fNewLifes`, `fNewDeaths`, `fNumberFights`, `fBirthDenials`, `fMiscDenials`
  (`Simulation.h:351-372`).
* Energy accounting: `fFoodEnergyIn`, `fFoodEnergyOut`, `fEnergyEaten` (per-step) and
  `fTotalFoodEnergyIn/Out`, `fTotalEnergyEaten`, `fAverageFoodEnergyIn/Out`
  (`Simulation.h:404-411`).
* Fitness: `fCurrentFittestAgent[]`/`fCurrentMaxFitness[]`/`fCurrentFittestCount`
  (heuristic fitness, cap 5), `fFittest` (overall, genome-storing), `fRecentFittest`
  (per-epoch, no genomes), `fMaxFitness`, `fAverageFitness`, `fNumAverageFitness`,
  `fPrevAvgFitness` (`Simulation.h:289-314`).
* `fEpoch`, `fEpochFrequency` (`Simulation.h:106-107`).
* `fStage` (graphics stage, `gstage`) + `fWorldCast`/`fWorldSet`, and
  `agentPovRenderer`. Only `fStage` touches the model, and only through POV rendering
  when vision is on (§4.6, §8).

---

## 3. Execution model the port must reproduce

### 3.1 Scheduler (`Scheduler.cc:26-83`)

```
execMasterTask(masterTask, forceAllSerial):
    forceAllSerial = forceAllSerial
    if forceAllSerial:  masterTask()                       # everything inline, FIFO
    else:
        state = Master;      masterTask()                  # inline, in the caller's thread
        state = Parallel;    threadPool.join()             # wait for all postParallel work
        state = Serial;      for task in serialTasks: task()   # FIFO, in push order
                             serialTasks.clear()
        state = Idle
postParallel(t): forceAllSerial ? t() : threadPool.schedule(t)   # may run ANY time before join()
postSerial(t):   forceAllSerial ? t() : serialTasks.push_back(t)
```

Consequences that the port must encode (they are observable — see §3.3):

1. `postSerial` work in non-forced mode runs **after the master task has finished**, in
   push order. In forced-serial mode the same work runs **inline, immediately**.
2. `postParallel` work runs at an unspecified point during the master task (thread pool
   starts it as soon as it is scheduled); it is only guaranteed complete before the
   serial phase.
3. `forceAllSerial = !fParallelX` for each call site, so the *worldfile* decides which of
   the two behaviours a run has: `ParallelInitAgents`, `ParallelInteract`,
   `ParallelCreateAgents`, `ParallelBrains` (`Simulation.cc:3869-3872`, read from the
   worldfile at `Simulation.cc:3869`).

`ThreadPool::schedule` (`ThreadPool.cc:75-95`) spawns a worker up to
`hardware_concurrency()-1` and runs the *oldest queued* task in each worker; `join()`
(`ThreadPool.cc:30-73`) drains the queue in the calling thread. So with one task at a
time the order is FIFO; with several workers the interleaving is scheduler-dependent.

### 3.2 The x-sorted object list — cursor semantics

`objectxsortedlist` is a doubly-linked list with a cursor (`currItem`) plus one mark per
object type (`markedAgent`, `markedFood`, `markedBrick`) (`objectxsortedlist.h:21-53`).

* `add(o)` (`objectxsortedlist.cc:146-191`): linear scan from the head, inserting `o`
  before the first object whose **key** `x - radius` is strictly greater than `o`'s;
  otherwise append. So the list stays ordered by `key = x - radius`, and ties (equal key)
  keep insertion order (a new object goes *after* equal-key peers).
* `sort()` (`objectxsortedlist.cc:323-360`): one backward-insertion pass assuming the
  list is *nearly* sorted. Comparison key is again `x - radius`; equal keys keep their
  relative order. Called once per step, at the top of `Interact()` (`Simulation.cc:1465`).
* `nextObj(type, &o)` / `prevObj(type, &o)` (`79-97`, `104-122`): advance/find the next
  object whose `getType() & type` is non-zero; the cursor ends up on the returned object.
  `lastObj` (`57-70`) scans backwards from the tail.
* `setMark(type)` (`404-434`) marks the *current* object (fatal if the type is wrong);
  `toMark(type)` (`490-500`) rewinds the cursor to the mark.
* `removeObjectWithLink(o)` (`286-317`): sets the cursor to `o`'s link, removes it, and
  restores the previous cursor **unless** it was pointing at `o` — then it is left one
  item back. `removeCurrentObject()` (`198-278`) additionally fixes up marks and counts.
* `Release`/delete of food/bricks happens by the environment lane; `gXSortedObjects` is
  the single ordering authority for interactions.

**PORT-NOTE(list-cursor):** the port must model this list *as a list with a cursor and a
per-type mark*, not as arrays with indexes. Every interaction routine below relies on
"the cursor is where I left it" (Eat/Pickup scan backwards from the mark, then forwards;
`Kill` leaves the cursor one item back). A port that re-sorts into fresh arrays per scan
will diverge. Required operations: `reset`, `next`, `nextObj(type)`, `prevObj(type)`,
`lastObj(type)`, `setMark(type)`, `toMark(type)`, `getcurr`/`setcurr`, `add`,
`removeObjectWithLink`, `removeCurrentObject`, `sort`, `getCount(type)`.

### 3.3 Is it parallel, and does order matter? — **[measured]**

Probe: native binary copied to a scratch dir (`Polyworld`, `etc/`, `worldfiles/`,
`lib/`, `bin/`, `src/library/proplib/interpreter.py`), run as
`./Polyworld --ui term --Vision False [--ParallelX False] worldfiles/tests/low-spec-pc/minitest.wf`,
each run snapshotted and compared against the recorded golden with
`tools/check_parity.py --golden oracle/minitest_voff --candidate <snap>`.
Baseline (the worldfile's own settings: `StaticTimestepGeometry True`,
`ParallelInitAgents True`, `ParallelInteract True`, `ParallelCreateAgents True`,
`ParallelBrains True`, `Vision False`) reproduces the golden **1369/1369 manifested
files** (the only "extra" files are `run/.cppprops/**`, which the manifest excludes).

| Override | Files differing vs golden (excl. `.cppprops`) | Verdict |
|---|---|---|
| none (as recorded) | 0 | reference |
| `--ParallelBrains False` | 2 — `converted.wf`, `normalized.wf` (they record the CLI override) | **model-identical** |
| `--ParallelCreateAgents False` | 2 — same two | **model-identical** |
| `--ParallelInitAgents False` | 379 | **differs** |
| `--ParallelInteract False` | 684 differing + 461 missing + 493 extra | **differs** |

First divergence for `--ParallelInteract False` vs baseline **[measured]**:
`BirthsDeaths.log` line 6 (`38 DEATH 20` / `38 BIRTH 28 2 15` vs `37 DEATH 20` /
`37 BIRTH 28 2 15`) → the trajectories part at **step 37**; population.txt first differs
at the row for step 39 (24 vs 23 agents); `energy/consumption.txt` at step 44.
For `--ParallelInitAgents False`: population/lifespans/BirthsDeaths are *identical*; the
first difference is `energy/consumption.txt` line 69 (step 31, `73.305176` vs
`73.432007`), and 379 files differ overall (mostly `brain/Recent/**` dumps).

**Therefore:**

* Brain-update parallelism and creation-grow parallelism are behaviour-neutral for the
  oracle scenario (per-agent RNG + per-agent log files, §8.2) → the port may execute
  them **inline, in list order**, and still match.
* **Interaction and init parallelism are behaviour-affecting.** The mechanism the code
  implies is the `postSerial` deferral (§3.1 consequence 1): in the recorded (parallel)
  configuration the newly born agent is appended to `gXSortedObjects` *after* the whole
  `Interact()` pass has finished (`Simulation.cc:2273-2278`), whereas in forced-serial
  mode it is appended mid-pass and is therefore visible as a contact partner `d` in the
  same step (note the inner contact loop has **no** age filter on `d`, only the outer
  loop skips `c` with `Age() <= 0`, `Simulation.cc:1566`, `1573-1581`). The init case
  (grow before/after `FoodEnergyIn`, `Simulation.cc:875-916`) shows up as float
  accumulation-order drift in the energy accounting.

**PORT-NOTE(sched-deferral):** the port implements the *parallel-mode* (recorded)
semantics single-threaded: a step gathers `postParallel` work and runs it immediately
before the serial phase, and runs `postSerial` work after the master task completes, in
push order. It must not "simplify" `postSerial` to inline execution — that is a
measurably different model (§3.3) and fails the oracle.
**PORT-NOTE(sched-flags):** `ParallelBrains` / `ParallelCreateAgents` may be treated as
no-ops by the port (measured identical); `ParallelInitAgents=false` and
`ParallelInteract=false` are **unsupported** in v1 — the port either reproduces the
deferred ordering (recommended) or refuses the worldfile with a clear error, and
`PARITY.md` records the choice.

---

## 4. Init phase — `TSimulation::TSimulation(worldfilePath, params)`

Order is load-bearing: RNG is consumed at several of these steps. (`Simulation.cc:189-473`.)

| # | Action | Lines |
|---|---|---|
| 1 | Member-init list: all flags/counters to their defaults (`fLowPopulationAdvantageFactor=1.0`, `fGlobalEnergyScaleFactor=1.0`, `fFitI=0`, `fFitJ=1`, …) | 190-233 |
| 2 | `fStep = 0`; zero `fNumberAliveWithMetabolism[]`; allocate `fCurrentBrainStats.sheets.synapseCount[__NTYPES][__NTYPES]` | 235-240 |
| 3 | **`srand(1)`** — seeds libc `rand()`; the model never calls `rand()`, only `graphics/gobject.cc` does (`rand` occurrences: 3, all in that file) | 242 |
| 4 | Rename existing `run` → `run_<time(NULL)>`, then `mkdir run` (`PwDirMode`) | 247-261 |
| 5 | Build schema from `./etc/worldfile.wfs`; build the worldfile document from the file **plus the CLI `--key value` parameter map**; write `run/converted.wf`; `schema->apply()` (this is where Python expressions in the worldfile are evaluated) | 266-280 |
| 6 | `processWorldFile(worldfile)` — reads every sim parameter (§10) | 281 |
| 7 | `agent::processWorldfile`, `GenomeSchema::processWorldfile`, `Brain::processWorldfile` | 282-284 |
| 8 | If `PassiveLockstep` (a.k.a. `PassiveLockstep`) → `initLockstepMode()` (forces config, §9.2) | 287-290 |
| 9 | If `HeuristicFitnessWeight != 0` or `ComplexityFitnessWeight != 0` → `initFitnessMode()` | 292-295 |
| 10 | If `AdaptivityMode` → `initAdaptivityMode()` | 297-300 |
| 11 | `Brain::init()`, `agent::agentinit()`, `SeparationCache::init()`, `GenomeUtil::createSchema()` | 305-309 |
| 12 | `InitCppProperties(worldfile)` → `CppProperties::init()`: generates `run/.cppprops/generated.cc`, needs `clang++` from `Makefile.conf`, `make -C run/.cppprops`, `dlopen` the result, then `__clink__CppProperties_Init(context)` (`cppprops.cc:63-86`) | 314, 781-786 |
| 13 | Compute `food::gMaxFoodRadius` and `agent::config.maxRadius` (uses `sqrt`) | 321-328 |
| 14 | `InitFittest()` — sizes each domain's least-fit queue to `lround(fSmiteFrac * domain.maxNumAgents)` | 330, 791-815 |
| 15 | Lockstep only: print banner, open `LOCKSTEP-BirthsDeaths.log`, skip `#`/`%` header lines, `cp` it into `run/`, `SetNextLockstepEvent()` | 332-362 |
| 16 | `fStage.SetCast(&fWorldCast)` | 365 |
| 17 | `fFoodEnergyIn = fFoodEnergyOut = 0`; `fEnergyEaten.zero()` | 367-369 |
| 18 | **`srand48(fGenomeSeed)`** — the model-wide `drand48` stream starts here (`fGenomeSeed` = worldfile `InitSeed`) | 371 |
| 19 | `agentPovRenderer = AgentPovRenderer::create(fMaxNumAgents, Brain::config.retinaWidth, retinaHeight)` | 373-375 |
| 20 | `logs = new Logs(this, worldfile)` | 380 |
| 21 | `SetMaximumFiles(100 + logs->getMaxOpenFiles())` | 385-395 |
| 22 | `InitGround()` — loads `ground` polygons, sets y, scale, color, adds to `fWorldSet` | 400, 820-828 |
| 23 | If `!fLoadState`: `execMasterTask(InitAgents, !fParallelInitAgents)` then `InitFood()`, `InitBricks()`, `InitBarriers()` | 405-416 |
| 24 | `fEatStatistics.Init()` | 418 |
| 25 | Snapshot `fTotalFoodEnergyIn/Out`, `fTotalEnergyEaten`; zero the step averages | 420-424 |
| 26 | `fStage.SetSet(&fWorldSet)` | 426 |
| 27 | If complexity is on and any complexity type is lowercase: `fEvents = new Events(fMaxSteps)` (event filtering) | 431-444 |
| 28 | `cp <worldfile> run/original.wf`, `cp <schema> run/original.wfs`, write `run/normalized.wf` (the post-override values — this is why CLI overrides show up in that file), delete both documents | 449-461 |
| 29 | `logs->postEvent(SimInitedEvent())` | 472 |

### 4.1 `InitAgents()` (`833-990`) — RNG-heavy

```
numSeededTotal = 0
for id in 0..fNumDomains-1:
    numSeededDomain = 0
    limit = min(fMaxNumAgents - gXSortedObjects.count(AGENTTYPE), fDomains[id].initNumAgents)
    for i in 0..limit-1:
        c = agent::getfreeagent(this, &fStage)     # agentsEver++, c's CNS rng seeded(agentsEver)
        fNumberCreated++, fNumberCreatedRandom++, fDomains[id].numcreated++
        if numSeededDomain < fDomains[id].numberToSeed:
            isSeed = true; SeedGenome(c, c->Genes(), fDomains[id].probabilityOfMutatingSeeds, numSeededDomain+numSeededTotal)
            numSeededDomain++
        else: c->Genes()->randomize()
        c->setGenomeReady()                        # metabolism selection (Gene → from genome)
        postParallel( c->grow(fMateWait, /*seeding*/ true) )     # 875-877
        fStage.AddObject(c)
        (x,z) = fDomains[id].initAgentsPatch->setPoint()         # 882
        y = 0.5 * agent::config.agentHeight
        isSeed ? SetSeedPosition(c, numSeededDomain+numSeededTotal-1, x, y, z) : c->settranslation(x,y,z)
        c->SaveLastPosition()
        c->setyaw(360.0 * randpw())                              # 899
        gXSortedObjects.add(c); c->Domain(id); fDomains[id].numAgents++
        postSerial( FoodEnergyIn(c->GetFoodEnergy()) )           # 914-916
        Birth(c, LifeSpan::BR_SIMINIT)                           # 918
    numSeededTotal += numSeededDomain
# global top-up
while gXSortedObjects.count(AGENTTYPE) < fInitNumAgents:          # 927-989
    isSeed = true; c = getfreeagent()
    fNumberCreated++, fNumberCreatedRandom++
    if numSeededTotal < fNumberToSeed: SeedGenome(...); numSeededTotal++
    else: c->Genes()->randomize()
    c->setGenomeReady(); postParallel(c->grow(fMateWait, true))
    fStage.AddObject(c)
    x = 0.01 + randpw()*(worldsize-0.02); z = -0.01 - randpw()*(worldsize-0.02); y = 0.5*agentHeight
    isSeed ? SetSeedPosition(c, numSeededTotal-1, x, y, z) : c->settranslation(x,y,z)
    c->setyaw(360.0 * randpw())
    gXSortedObjects.add(c); id = WhichDomain(x, z, 0); c->Domain(id); fDomains[id].numAgents++
    postSerial( FoodEnergyIn(c->GetFoodEnergy()) )
    Birth(c, LifeSpan::BR_SIMINIT)
```

`SeedGenome` (`1051-1069`): if `SeedGenomeFromRun` → load genome from `genomeSeeds.txt`
list (`1084`); else `GenomeUtil::seed(genes)`; then `if (randpw() < probabilityOfMutatingSeeds) genes->mutate()`
(one `randpw()` draw **per seed**, always evaluated) and `genes->mutate(fRawSeedMutationRate)`.

`SetSeedPosition` (`1138-1158`): if `SeedPositionFromRun`, take `fSeedPositions[numSeeded]`
when in range, else the jittered/random position.

### 4.2 `InitFood()` (`995-1018`)

For each domain, for each **on** food patch, up to `initFoodCount` × `AddFood(domain, patch)`
while `domain.foodCount < domain.maxFoodCount`; then `initFoodGrown(true)`,
`numFoodPatchesGrown++`. `AddFood` (`3706-3717`) uses `fStep` as the food's birth step
(or `trand(-food::gMaxLifeSpan, 0)` when `fStep == 0 && RandomInitFoodAge`), increments
`domain.foodCount`, and calls `FoodEnergyIn(f->getEnergy())`.

### 4.3 `InitBricks()` (`1023-1033`) — `updateOn()` for every brick patch.

### 4.4 `InitBarriers()` (`1038-1045`) — add every barrier to `fWorldSet`.

### 4.5 `InitCppProperties` / per-step property update

`CppProperties::init` (Init phase 12) generates and dlopens `run/.cppprops`. Each step,
`proplib::CppProperties::update()` (`Simulation.cc:648`) refreshes the **runtime**
properties declared in `etc/worldfile.wfs:2865-2890` — `Step` (`$[sim]->fStep`),
`AgentCount`, `FoodCount`, `MetabolismAgentCount` (`worldfile.wfs:396-400`) and the
user `Variables` array. It touches model state only if the worldfile declares
*dynamic* properties that read them; the oracle worldfiles fold all expressions at load
(see `oracle/*/run/normalized.wf`). The port must still expose those runtime values if it
implements dynamic properties; otherwise this line is a no-op.

---

## 5. Step phase — `TSimulation::Step()` (`561-739`), exact order

```
  1  if (frame == 0 && fSimulationSeed != 0) srand48(fSimulationSeed)   # 567-570
  2  frame++                                                            # 572
  3  if (fMaxSteps && fStep+1 > fMaxSteps) { End("MaxSteps"); return }   # 575-579
  4  else if (fEndOnPopulationCrash && count(AGENTTYPE) <= fMinNumAgents)
         { End("PopulationCrash"); return }                             # 580-586
  5  fStep++                                                            # 588
  6  FPS bookkeeping (hirestime(); static sTimePrevious[10])             # 592-625
  7  fMaxGapCreate update; if fNumDomains>1 also per-domain maxgapcreate  # 627-640
  8  fFoodEnergyIn = 0.0; fFoodEnergyOut = 0.0; fEnergyEaten.zero()       # 643-645
  9  proplib::CppProperties::update()                                     # 648
 10  for b in barrier::gXSortedBarriers: b->update(); xsort()             # 651-655
 11  MaintainEnergyCosts()                                                # 657
 12  agentPovRenderer->beginStep()
       if fStaticTimestepGeometry: UpdateAgents_StaticTimestepGeometry()
       else:                       UpdateAgents()
       agentPovRenderer->endStep()                                        # 660-674
 13  execMasterTask(Interact, !fParallelInteract)                          # 679-680
 14  assert(fNumberAlive == count(AGENTTYPE))                              # 682
 15  if (fNumAverageFitness > 0) fAverageFitness /= fNumAverageFitness * fTotalHeuristicFitness  # 686-687
 16  execMasterTask(CreateAgents, !fParallelCreateAgents)                  # 699-700
 17  MaintainBricks()                                                      # 706
 18  MaintainFood()                                                        # 712
 19  fTotalFoodEnergyIn += fFoodEnergyIn; fTotalFoodEnergyOut += fFoodEnergyOut;
       fTotalEnergyEaten += fEnergyEaten                                     # 714-716
 20  fAverageFoodEnergyIn  = (float(fStep-1)*fAverageFoodEnergyIn  + fFoodEnergyIn ) / float(fStep)
       fAverageFoodEnergyOut = (float(fStep-1)*fAverageFoodEnergyOut + fFoodEnergyOut) / float(fStep)  # 718-719
 21  stepEnding()                     # monitor hook (L14; consumes no RNG)   # 724
 22  if (fEpochFrequency && fStep % fEpochFrequency == 0)
         { logs->postEvent(EpochEndEvent(fStep)); fEpoch += fEpochFrequency; fRecentFittest->clear() }  # 729-736
 23  logs->postEvent(StepEndEvent())                                        # 738
```

Notes that a port gets wrong easily:

* The `MaxSteps` test happens **before** `fStep++`, using `fStep+1`, so exactly
  `fMaxSteps` steps execute (measured: `MaxSteps 301` ⇒ `run/endStep.txt` is `301`;
  `MaxSteps 1` ⇒ `1`).
* `fEndOnPopulationCrash` compares against `fMinNumAgents` **before** incrementing, and
  only if the *global* agent count is ≤ that value (`580-586`).
* Step 1 and step 2 differ: the RNG re-seed in step 1 happens only on the first call
  (`frame == 0`); with `SimulationSeed 0` (the oracle scenarios) it is skipped entirely,
  so the `drand48` stream flows straight from `InitAgents` into step 1.
* Step 15 divides `fAverageFitness` by `fNumAverageFitness * fTotalHeuristicFitness`
  *after* `Interact()` and *before* `CreateAgents()`; `fTotalHeuristicFitness` is the sum
  of the five fitness weights (`processWorldFile`, `3933`).
* `fEpoch` starts at `fEpochFrequency` (`3913`), so it counts *next* boundaries:
  after the first epoch event `fEpoch == 2*fEpochFrequency`.

### 5.1 `MaintainEnergyCosts()` (`1277-1363`)

Two mutually exclusive regimes:

* `fEnergyBasedPopulationControl` (`1279-1304`): if `fPopControlGlobal`,
  `fGlobalEnergyScaleFactor = EnergyScaleFactor(fMinNumAgents, fMaxNumAgents, count(AGENTTYPE))`;
  if `fPopControlDomains` **and** (`fNumDomains > 1 || !fPopControlGlobal`), each
  `fDomains[i].energyScaleFactor = EnergyScaleFactor(domain.min, domain.max, domain.numAgents)`.
* else if `fApplyLowPopulationAdvantage || fNumDepletionSteps` (`1305-1362`): computes
  the *worst* excess across the world and domains (only when `fNumDomains > 1`), then
  either `fLowPopulationAdvantageFactor = clamp(1 - (init-num)/(init-min), 0, 1)` or
  `fPopulationPenaltyFraction = fMaxPopulationPenaltyFraction * (num-init)/(max-init)`
  clamped to `[0, fMaxPopulationPenaltyFraction]`.

`EnergyScaleFactor` (`1246-1271`): `topFixedRange = minAgents + lround(fPopControlMaxFixedRange*(max-min))`,
`botFixedRange = minAgents + lround(fPopControlMinFixedRange*(max-min))`; below
`botFixedRange`, `scale = 1 - (1-fPopControlMinScaleFactor) * (bot-num)/(bot-min)` floored
at 0; above `topFixedRange`, `scale = 1 + (fPopControlMaxScaleFactor-1) * pow((num-top)/(max-top), 4.0)`.
`pow` is float-sensitive (see §11.3). The returned scale is consumed by the agents'
metabolism in `agent::UpdateBody` (L8).

### 5.2 Agent update pass A — `UpdateAgents()` (non-static geometry, `1369-1395`)

```
for a in gXSortedObjects (AGENTTYPE, x order):
    a->UpdateVision()          # no-op unless agent::config.vision (agent.cc:1065-1093)
    a->UpdateBrain()           # fCns->update(false) + logs->postEvent(BrainUpdatedEvent(a))  (agent.cc:1099-1104)
    if (!a->BeingCarried()) fFoodEnergyOut += a->UpdateBody(fMoveFitnessParameter,
                                                            agent::config.speed2DPosition,
                                                            fSolidObjects, NULL)
```

Comment at `1371-1373` states the intent: the world changes as each agent is processed,
so no stage compile / no parallelisation. **Order within the pass is model state.**

### 5.3 Agent update pass B — `UpdateAgents_StaticTimestepGeometry()` (`1401-1446`)

Used by all oracle scenarios (`StaticTimestepGeometry True`).

```
execMasterTask(master, forceAllSerial = !fParallelBrains):
  master:
    fStage.Compile()
    for a in gXSortedObjects (AGENTTYPE, x order):
        a->UpdateVision()                          # serial, in the master thread
        postParallel( a->UpdateBrain() )           # concurrent with the rest of the master loop
    fStage.Decompile()
# after the join (always serial, in x order):
for a in gXSortedObjects (AGENTTYPE, x order):
    if (!a->BeingCarried()) fFoodEnergyOut += a->UpdateBody(...)
```

Because `processWorldFile` sets `RandomNumberGenerator::set(NERVOUS_SYSTEM, LOCAL)`
when `StaticTimestepGeometry` is true (`3863-3868`), each agent's nervous-system RNG is
its own MT19937 instance (`NervousSystem.cc:18`, seeded per agent in
`agent::getfreeagent` → `seedIfLocal(agent::agentsEver)`, `agent.cc:353`). That is why
brain parallelism is behaviour-neutral **[measured]**, and it is a hard requirement for
the port: **per-agent RNG state, seeded with the agent's ever-increasing number.**
If `StaticTimestepGeometry` is false the nervous-system stream is the shared global
`drand48`, and brain work must then be strictly serial (see §8.2).

### 5.4 `Interact()` (`1452-1683`) — master task of `execMasterTask`

```
 0  fNewLifes = 0; fNewDeaths = 0; fEatStatistics.StepBegin()                 # 1459-1462
 1  gXSortedObjects.sort()                                                    # 1465
 2  fCurrentFittestCount = 0; fPrevAvgFitness = fAverageFitness;
    fAverageFitness = 0.0; fNumAverageFitness = 0;                            # 1490-1494
    for each domain: fNumLeastFit = 0; fNumSmited = 0                         # 1497-1501
 3  DeathAndStats()                                                           # 1508
 4  if (fHealing) for c in agents (x order): c->Heal(fAgentHealingRate, 0.0)  # 1537-1542
 5  if (fLockStepWithBirthsDeathsLog && fLockstepTimestep == fStep)
        { MateLockstep(); SetNextLockstepEvent(); }                           # 1547-1554
 6  contact loop (below)                                                       # 1559-1669
 7  fEatStatistics.StepEnd()                                                   # 1671
```

Contact loop (`1559-1669`):

```
gXSortedObjects.reset()
while nextObj(AGENTTYPE, &c):                       # outer, x order, live list
    if (c->Age() <= 0) continue                     # newborns are skipped this step
    gXSortedObjects.setMark(AGENTTYPE)              # mark = c
    cDied = false
    while nextObj(AGENTTYPE, &d):                   # inner: objects AFTER c, no age filter
        if (d == c) { print "d == c"; continue }
        if ((d->x() - d->radius()) >= (c->x() + c->radius())) break     # x-sorted early out
        if (dist(c,d) <= d->radius() + c->radius()):                    # real overlap
            ev = AgentContactBeginEvent(c, d); logs->postEvent(ev)
            Mate(c, d, &ev)
            dDied = false
            if (fPower2Energy > 0.0) Fight(c, d, &ev, &cDied, &dDied)
            if (agent::config.enableGive && !cDied && !dDied):
                Give(c, d, &ev, &cDied, /*toMarkOnDeath*/ true)
                if (!cDied) Give(d, c, &ev, &dDied, /*toMarkOnDeath*/ false)
            logs->postEvent(AgentContactEndEvent(ev))
            if (cDied) break
    if (cDied) continue
    Eat(c, &cDied);        if (cDied) continue
    if (agent::config.enableCarry) Carry(c)
    Fitness(c)
```

Facts to preserve:

* Each unordered pair is visited **once**, when the left-hand agent is `c` (the inner
  scan starts one past `c`). There is no reverse pass.
* `break` on `d->x() - d->radius() >= c->x() + c->radius()` is only valid because the
  list is sorted by `x - radius`; the port must keep that invariant, or use a filter that
  is provably equivalent.
* The distance test uses `sqrt(dx*dx + dz*dz)` (`1591`) — `double sqrt` on `float`
  arguments, i.e. the C++ promotes and then compares to a `float` sum. Use
  `Math.sqrt` on f64-promoted values and compare in f64 (**PORT-NOTE(sqrt-cmp)**).
* Agents born during this pass are `Age() <= 0`, so the outer loop skips them; but they
  are *visible* to the inner loop on the next outer iteration in forced-serial mode. In
  the recorded (parallel) mode they are appended in the serial phase, i.e. after the
  pass — see §3.1/§3.3.

#### 5.4.1 `DeathAndStats()` (`1689-1920`)

```
1  if (fCalcFoodPatchAgentCounts): reset agent counts on every FoodPatch       # 1695-1704
2  if (fLockStepWithBirthsDeathsLog && fLockstepTimestep == fStep):
       for count in 0..fLockstepNumDeathsAtTimestep-1:                         # 1706-1746
           randomIndex = int(floor(randpw() * count(AGENTTYPE)))
           walk agents x order to the (randomIndex+1)-th agent, keeping cursor;  # last agent seen wins
           restore cursor; assert(randAgent != NULL); Kill(randAgent, DR_LOCKSTEP)
3  reset the brain-stats accumulators (per architecture: Groups or Sheets)      # 1748-1763
4  for c in agents (x order):                                                   # 1764-1913
       accumulate brain stats (neuron/synapse/group counts)
       id = c->Domain()
       if (!fLockStepWithBirthsDeathsLog):
           if ( (!fApplyLowPopulationAdvantage && !fEnergyBasedPopulationControl)
                || (count(AGENTTYPE) > fMinNumAgents
                    && fNumberAliveWithMetabolism[c->metabolism] > fMinNumAgentsWithMetabolism[c->metabolism]
                    && fDomains[c->Domain()].numAgents > fDomains[c->Domain()].minNumAgents)
                || (fAllowMinDeaths && randpw() > fNumberBorn/(fNumberCreated+fNumberBorn)) )
           {
               if (energy depleted || age >= maxAge || (edge && out of bounds) || deathByPatch):
                   reason = DR_NATURAL (DR_PATCH if patch death); count the sub-reason
                   Kill(c, reason); continue
           }
       if (fCalcFoodPatchAgentCounts): update inside/neighbourhood counts          # 1842-1856
       least-fit bookkeeping (see §6.2)                                            # 1867-1912
5  fGeneStats.compute(fScheduler)     # snapshot + postParallel; no RNG             # 1919
```

Port-critical details:

* The `randpw()` in the death test is inside a short-circuit chain: in the oracle
  configuration `fEnergyBasedPopulationControl` is `True` and `ApplyLowPopulationAdvantage`
  is `False`, so clause 1 is false and clause 3 can be reached — but `AllowMinDeaths` is
  `False` in the oracle worldfiles, so **no** `randpw()` is consumed here. Any port that
  evaluates the draw unconditionally will desynchronise the global stream for step 1
  onwards. Reproduce short-circuit evaluation exactly (**PORT-NOTE(rng-shortcircuit)**).
* `fNumberAliveWithMetabolism[]` / `fMinNumAgentsWithMetabolism[]` gate natural deaths
  whenever energy-based population control is on.
* Deaths here are what make `fDomains[id].numAgents` shrink; `Kill` (§5.5.7) updates
  `fDomains`, `fNumberDied*`, `fLifeSpanStats`, carcass→food, and updates the fittest
  lists in its serial phase.

#### 5.4.2 `Mate(c, d, contactEvent)` (`2154-2287`)

```
cPot = GetMatePotential(c); dPot = GetMatePotential(d)
cStat = GetMateStatus(cPot, dPot); dStat = GetMateStatus(dPot, cPot)
if (cStat == MATE__DESIRED && dStat == MATE__DESIRED):
    if (fHeuristicFitnessWeight != 0 || fComplexityFitnessWeight != 0 || fLockStepWithBirthsDeathsLog):
        # steady-state GA / lockstep: virtual births
        c->mating(fMateFitnessParameter, fMateWait, lockstep=false)
        d->mating(fMateFitnessParameter, fMateWait, lockstep=false)
        fNumberBornVirtual++; Birth(NULL, BR_VIRTUAL, c, d)
    else:
        kd = WhichDomain(0.5*(c->x()+d->x()), 0.5*(c->z()+d->z()), 0)
        Smite(kd, c, d)                                    # may kill a third agent!
        if (GetMateDenialStatus(c,&cStat,d,&dStat,kd) != MATE__NIL):
            fBirthDenials++; if (MISC bit) fMiscDenials++
        else:
            fNumBornSinceCreated++; fDomains[kd].numbornsincecreated++
            e = agent::getfreeagent(this, &fStage)
            e->Genes()->crossover(c->Genes(), d->Genes(), true); e->setGenomeReady()
            eenergy = c->mating(...,lockstep=false) + d->mating(...,lockstep=false)
            x = 0.5*(c->x()+d->x()); y = 0.5*(c->y()+d->y()); z = 0.5*(c->z()+d->z())
            yaw = AverageAngles(c->yaw(), d->yaw())
            if (fRandomBirthLocation):
                distance = worldsize * fRandomBirthLocationRadius * randpw()
                angle = 2*M_PI * randpw()                   # two draws
                x += distance*cosf(angle); z -= distance*sinf(angle)
                x = clamp(x, 0.01, worldsize-0.01); z = clamp(z, -worldsize+0.01, -0.01)
            e->settranslation(x,y,z); e->setyaw(yaw); e->Domain(kd)
            fNewLifes++; fDomains[kd].numAgents++; fNumberBorn++; fDomains[kd].numborn++
            Birth(e, BR_NATURAL, c, d)
            postParallel( e->grow(fMateWait); eenergy.constrain(0, e->GetMaxEnergy());
                          e->SetEnergy(eenergy); e->SetFoodEnergy(eenergy) )     # 2262-2268
            postSerial( fStage.AddObject(e); save cursor; gXSortedObjects.add(e);
                        restore cursor )                                        # 2273-2278
contactEvent->mate(c, cStat); contactEvent->mate(d, dStat)
```

* `AverageAngles` (`114-128`): if `|a-b| > 180`, `0.5*(a+b)+180` wrapped below 360, else
  `0.5*(a+b)`.
* `fRandomBirthLocation` is `False` in the oracle worldfiles ⇒ no birth-location draws.
* `Birth(NULL, BR_VIRTUAL, ...)` is a real accounting event (`Birth`, §5.5.8) but does
  not touch an agent.

`GetMatePotential(x)` (`2040-2078`): `desiresMate = x->Mate() > fMateThreshold`; if
`fProbabilisticMating` **and** desires, one `randpw()` draw replaces the test. Then the
prevented bits: carry (`IS_PREVENTED_BY_CARRY`, §8.3), mate-wait
(`Age()-LastMate() < fMateWait`), energy (`NormalizedEnergy() <= fMinMateFraction`),
eat-mate-span (`fEatMateSpan > 0 && fStep - LastEat() >= fEatMateSpan`), eat-mate-min-distance
(`fEatMateMinDistance > 0 && LastEat() > 0 && LastEatDistance() < fEatMateMinDistance`),
max-velocity (`NormalizedSpeed() > fMaxMateVelocity`).

`GetMateStatus(xPot, yPot)` (`2083-2096`): adds `MATE__PREVENTED__PARTNER` unless the
partner's potential is exactly `MATE__DESIRED`.

`GetMateDenialStatus` (`2101-2149`): `MAX_DOMAIN` (`domain.numAgents >= domain.maxNumAgents`),
`MAX_WORLD` (`fNumberAlive >= fMaxNumAgents`), `MAX_METABOLISM` (only when >1 metabolism
definition; `fNumberAliveWithMetabolism[x] >= fMaxNumAgents/nmetabolisms`),
then **only if status is still NIL** `MISC` = `fMiscAgents >= 0 && domain.numbornsincecreated >= fMiscAgents && randpw() >= x->MateProbability(y)`
(the comment at `2130-2131` says the ordering is deliberate to keep the RNG stream
identical to older versions), finally `WORLDFILE` = `!fAllowBirths`.

`Smite(kd, c, d)` (`2292-2361`): mode `'L'` walks the domain's least-fit queue from
`fNumSmited`, skipping the two parents and any agent whose heuristic fitness is ≥ the
worst current fittest, killing the first acceptable one (`DR_SMITE`, `fNumberDiedSmite++`);
mode `'R'` picks `randomIndex = floor(randpw()*domain.numAgents)`, scans agents in x order
counting only those in `kd`, requires `Age() > fSmiteAgeFrac*MaxAge()` and not a parent,
restores the cursor and kills it. `fSmiteMode` is `'O'` (off) in the oracle worldfiles.

#### 5.4.3 `Fight(c, d, ev, cDied, dDied)` (`2407-2473`) — only if `fPower2Energy > 0`

`GetFightStatus(x,y,&power)` (`2366-2402`): `desiresFight = x->Fight() > fFightThreshold`;
`power = fFightFraction * x->Strength() * x->SizeAdvantage() * x->Fight() * x->NormalizedEnergy()`;
prevented bits: carry, `y->IsCarrying(fShieldObjects)`, `power <= 0`; if the status is not
exactly `FIGHT__DESIRED`, power is zeroed. Then: `fNumberFights++`, `d->damage(cpower*fPower2Energy, fFightMode==FM_NULL)`
posts an `EnergyEvent` when non-zero, then the mirror for `c`, then (**not** in lockstep):
`if (d->GetEnergy().isDepleted()) { Kill(d, DR_FIGHT); fNumberDiedFight++; dDied = true }`
and the same for `c` with `gXSortedObjects.toMark(AGENTTYPE)` first.

#### 5.4.4 `Give` (`2478-2554`)

`GetGiveStatus(x,&energy)`: `desiresGive = x->Give() > fGiveThreshold`;
`energy = x->GetEnergy() * x->Give() * fGiveFraction`; prevented by carry or by
`energy.isDepleted()`; zeroed unless exactly `GIVE__DESIRED`. Then
`y->receive(x, energy)`, `EnergyEvent`, and (not in lockstep) a depletion kill of `x`
with `toMark` when `toMarkOnDeath`.

#### 5.4.5 `Eat(c, cDied)` (`2561-2739`)

`eatAllowed` is false if any of: carry-prevented (`IS_PREVENTED_BY_CARRY`),
`NormalizedSpeed() > fMaxEatVelocity`, `< fMinEatVelocity`, `|NormalizedYaw()| > fMaxEatYaw`,
`Age() < metabolism.minEatAge`, `fStep - LastEat() < fEatWait`.

With `CompatibilityMode 1` (`Simulation.cc:26`) the search is:

1. `toMark(AGENTTYPE)` (cursor back to `c`), then scan **backwards** through FOODTYPE,
   breaking when `f->x() + 2*gMaxFoodRadius < c->x() - c->radius()`; on overlap in x and
   `|fz-cz| < f->radius()+c->radius()`, set `eatAttempted`, stop if `!eatAllowed`,
   otherwise `c->eat(f, fEatFitnessParameter, fEat2Consume, fEatThreshold, fStep, ...)`,
   post `EnergyEvent(Eat)`, `fEvents->AddEvent(fStep, c->Number(), 'e')` when events are
   on, `FoodEnergyOut(foodEnergyLost)`, `fEnergyEaten += energyEaten`, remove the food if
   depleted or `fFoodRemoveFirstEat`, and stop (one food piece per agent per step).
2. If nothing was eaten **and** no attempt was made, scan **forwards** from the mark, with
   the mirrored bounds test (in compatibility mode it also requires
   `f->x()+f->radius() > c->x()-c->radius()`).
3. `if (eatAttempted) fEatStatistics.AgentEatAttempt(eatAllowed, failedYaw, failedVel, failedMinAge)`,
   then `toMark(AGENTTYPE)`, then (**not** in lockstep) the eat-death test:
   `c->GetEnergy().isDepleted() || ((c->IsSeed() || c->Age() >= agent::config.starvationWait) && c->GetFoodEnergy().isDepleted(c->GetStarvationFoodEnergy()))`
   ⇒ `Kill(c, DR_EAT); fNumberDiedEat++; cDied = true`.

`RemoveFood(f)` (`3722-3745`) asserts the cursor is on `f`, decrements patch and domain
food counts, removes it from the x-sorted list and the stage, drops it from a carrier,
`FoodEnergyOut(f->getEnergy())`, deletes it.

#### 5.4.6 `Carry` / `Pickup` / `Drop` (`2744-2859`)

`Carry(c)`: if `c->Pickup() > fPickupThreshold` and `NumCarries() < agent::config.maxCarries`
→ `Pickup(c)`; if `c->Drop() > fDropThreshold` and `NumCarries() > 0` → `Drop(c)`
(`c->DropMostRecent()`).

`Pickup(c)` scans **backwards** from the mark then (if still below `maxCarries`)
**forwards**, over the object mask `fCarryObjects`, skipping objects that are carried or
carrying, with x/z overlap tests; the backwards early-out uses
`o->x() + 2*max(food::gMaxFoodRadius, agent::config.maxRadius, brick::gBrickRadius)`.
Each pickup calls `c->PickupObject(o)`; the scan stops when `maxCarries` is reached; the
cursor is re-marked to `c` at the end.

#### 5.4.7 `Fitness(c)` (`2864-2909`) — heuristic fitness bookkeeping

```
if (c->Age() >= fSmiteAgeFrac * c->MaxAge()):
    fAverageFitness += c->HeuristicFitness(); fNumAverageFitness++
if (fCurrentFittestCount < MAXFITNESSITEMS(5) || c->HeuristicFitness() > fCurrentMaxFitness[fCurrentFittestCount-1]):
    insert (descending by HeuristicFitness) into fCurrentMaxFitness[]/fCurrentFittestAgent[],
    capped at 5; equal fitness appends after existing equals
```

The lists keep insertion order among equals, so the *order in which agents reach this
call* (x order, then in `Kill`'s serial phase) is part of the result.

#### 5.4.8 `Birth` and `Kill`

`Birth(a, reason, p1, p2)` (`3384-3436`): posts `AgentBirthEvent(a, reason, p1, p2)`;
if `a != NULL` then `fNumberAlive++`, `fNumberAliveWithMetabolism[a->metabolism]++`,
`a->GetLifeSpan()->set_birth(fStep, reason)`, `SeparationCache::birth(event)`. If events
are on and the reason is not `BR_SIMINIT`, adds `'m'` events for both parents
(`BR_NATURAL`/`BR_LOCKSTEP`/`BR_VIRTUAL`), no-op for `BR_CREATE`.

`Kill(c, reason)` (`3443-3603`):

```
ev = AgentDeathEvent(c, reason)
fNumberAlive--; fNumberAliveWithMetabolism[c->metabolism]--
c->GetLifeSpan()->set_death(fStep, reason)
if (reason == DR_SIMEND):            # End-phase path only
    logs->postEvent(ev); SeparationCache::death(ev); c->Die(); return
fNewDeaths++; fNumberDied++; fDomains[id].numdied++; fDomains[id].numAgents--
fLifeSpanStats.add(c->Age()); fLifeSpanRecentStats.add(...); fLifeFractionRecentStats.add(c->Age()/c->MaxAge())
c->lastrewards(fEnergyFitnessParameter, fAgeFitnessParameter)
if (carcass food applies and counts allow):  create food at (c->x(), c->z()) with
    energy = constrainc(c->GetFoodEnergy()...), FoodEnergyIn/Out per the min-energy rules,
    fp->foodCount++, f->setPatch(fp), f->domain(id), fDomains[id].foodCount++
else: FoodEnergyOut(c->GetFoodEnergy())
logs->postEvent(ev); SeparationCache::death(ev); c->Die()
fStage.RemoveObject(c)
gXSortedObjects.removeObjectWithLink(c)      # leaves cursor one item back
postParallel( analyzeBrain(c) )              # complexity only (fCalcComplexity)
postSerial( updateFittest(c); delete c )     # FIFO; deferred in non-forced mode
```

`analyzeBrain` (`3610-3635`): posts `BrainAnalysisBeginEvent`, computes complexity when
`fCalcComplexity` (Adami P/I/D via `CalcComplexity_brainfunction`, L13), posts
`BrainAnalysisEndEvent`.

`updateFittest(c)` (`3642-3701`): removes `c` from `fCurrentFittestAgent[]` if present
(keeping the order of the rest), computes `cFitness = AgentFitness(c)`,
`fMaxFitness = max(cFitness, fMaxFitness)`, updates `fDomains[c->Domain()].fittest`
(genomes stored) and `fFittest` (genomes stored) and, if it exists, `fRecentFittest`
(no genomes), and removes `c` from its domain's least-fit queue.

`AgentFitness(c)` (`3772-3817`): must be called on a dead agent (exits otherwise);
`fComplexityFitnessWeight == 0` ⇒ `HeuristicFitness()/fTotalHeuristicFitness`;
`fComplexityType == "Z"` ⇒ `0.01/(MaxSpeed()+0.01)`; else the weighted sum
`(fHeuristicFitnessWeight*H/fTotalHeuristicFitness + fComplexityFitnessWeight*complexity) / (fHeuristicFitnessWeight+fComplexityFitnessWeight)`,
lazily computing complexity from `run/brain/function/brainFunction_<n>.txt` when it is
still negative.

### 5.5 `CreateAgents()` (`2914-3148`) — master task of `execMasterTask`

```
maxToCreate = fMaxNumAgents - count(AGENTTYPE)
if (maxToCreate > 0):
    for id in domains: fDomains[id].numToCreate = max(0, fDomains[id].minNumAgents - fDomains[id].numAgents)
                       numToCreate += numToCreate
    # load balance: while the sum exceeds the room, decrement the domain that needs the least
    while (numToCreate > maxToCreate):
        pick the domain with the smallest positive numToCreate; numToCreate--
    for id in domains:
        for ic in 0..fDomains[id].numToCreate-1:
            fNumberCreated++; fDomains[id].numcreated++
            fNumBornSinceCreated = 0; fDomains[id].numbornsincecreated = 0
            fLastCreated = fStep; fDomains[id].lastcreate = fStep
            newAgent = agent::getfreeagent(this, &fStage)
            # genome source, in this priority:
            #   1. domain fittest list is full and fFitness1Frequency divides numcreated  → copyFrom(fittest.get(0))
            #   2. else fFitness2Frequency divides numcreated → crossover of two fittest
            #        (fTournamentSize > 0 → PickParentsUsingTournament, else ifit/jfit + ijfitinc)
            #   3. else → randomize()
            newAgent->setGenomeReady()
            postParallel( newAgent->grow(fMateWait) )
            x = randpw()*(domain.absoluteSizeX-0.02) + domain.startX + 0.01      # draw 1
            z = randpw()*(domain.absoluteSizeZ-0.02) + domain.startZ + 0.01      # draw 2
            y = 0.5*agent::config.agentHeight; yaw = randpw()*360.0              # draw 3
            newAgent->settranslation(x,y,z); newAgent->setyaw(yaw); newAgent->Domain(id)
            fStage.AddObject(newAgent); fDomains[id].numAgents++; gXSortedObjects.add(newAgent); fNewLifes++
            postSerial( FoodEnergyIn(newAgent->GetFoodEnergy()) )
            Birth(newAgent, BR_CREATE)
    # then the global top-up (note: the *global* body runs grow() inline, not posted)
    while (count(AGENTTYPE) < fMinNumAgents):
        fNumberCreated++; numglobalcreated++
        fNumBornSinceCreated = 0; fLastCreated = fStep
        newAgent = getfreeagent(...)
        genome from fFittest (same three-way choice, using numglobalcreated and fFitI/fFitJ)
        newAgent->setGenomeReady(); newAgent->grow(fMateWait); FoodEnergyIn(newAgent->GetFoodEnergy())
        newAgent->settranslation(randpw()*worldsize, 0.5*agentHeight, randpw()*-worldsize)  # 2 draws
        newAgent->setyaw(randpw()*360.0)                                                       # 1 draw
        id = WhichDomain(x, z, 0); newAgent->Domain(id); fDomains[id].numcreated++/lastcreate/numAgents++
        fStage.AddObject(newAgent); gXSortedObjects.add(newAgent); fNewLifes++
        Birth(newAgent, BR_CREATE)
```

`PickParentsUsingTournament(n,&i,&j)` (`1221-1240`): `i = min over fTournamentSize draws
of floor(randpw()*n)` starting from `n-1`; then the same for `j`, redrawn until `j != i`
(this loop can consume an unbounded number of draws).
`ijfitinc(n,&i,&j)` (`3360-3378`): `j++; if (j == i) j++; if (j > n-1) { j = 0; i++; if (i > n-1) { i = 0; j = 1 } }`
(note the `short` types and the `(short)` promotion in the call site).

### 5.6 `MaintainBricks()` (`3153-3163`)

`updateOn()` on every brick patch of every domain.

### 5.7 `MaintainFood()` (`3168-3355`)

```
1  if (food::gMaxLifeSpan > 0): while food::gAllFood head is old enough:
       set cursor to that food's link; RemoveFood(it)                        # 3171-3190
2  if (count(FOODTYPE) < fMaxFoodCount):
     for each domain:
       a. grow patches that have not had their initial growth but are now on  # 3200-3219
       b. if fUseProbabilisticFoodPatches:                                    # 3221-3267
            if (domain.foodCount < domain.maxFoodGrownCount):
                probAdd = (fFoodGrowthModel==MaxRelative)
                            ? (maxFoodGrownCount-foodCount) * frac(foodRate)
                            : frac(foodRate)                       # frac = x - floor(x)
                if (randpw() < probAdd): patch = getRandomPatch(domain); if (patch >= 0) AddFood(domain, patch)
                for i in 0..(int)domain.foodRate-1: patch = getRandomPatch(domain);
                    if (patch < 0) break; AddFood(domain, patch)
                for i in 0..(domain.minFoodCount - domain.foodCount)-1: same, break on -1
          else: per patch, the same three-part growth using the patch's own growthRate,
                minFoodCount, maxFoodGrownCount and growth model             # 3268-3303
3  if (fFoodRemovalNeeded): collect patches with removeFood && !isOn() && isOnChanged();
     if any, walk FOODTYPE in x order and RemoveFood the food of those patches  # 3308-3344
4  for each domain, for each food patch: patch.endStep()                        # 3346-3352
```

`getRandomPatch(domain)` (`5261-5301`): sums `fraction` over on-patches (`maxFractions`);
if > 0, `ranval = randpw() * maxFractions`, then walk the patches accumulating fractions
and return the first whose cumulative fraction reaches `ranval`; else return `-1`
(fallback path prints an error and derives an index from `floor(ranval*numPatches)`).

`AddFood` (`3706-3717`): `step = fStep` (or `(int)trand(-food::gMaxLifeSpan, 0)` when
`fStep == 0 && RandomInitFoodAge`), `patch.addFood(step)` → if non-NULL,
`domain.foodCount++` and `FoodEnergyIn(f->getEnergy())`.

### 5.8 End-of-step hooks

* `stepEnding()` (`724`) — `util::Signal<>`, connected by the app to
  `MonitorManager::step()` (`SimulationController.cc:26`). Monitors consume **no** RNG and
  no wall clock (`grep -rn "randpw|drand|hirestime" library/monitor` → 0 hits), so the
  port can treat them as observers; the scene/POV selection they drive (L14) and the movie
  recorder (Tier C, not frozen) hang off this hook.
* Epoch block (`729-736`): `EpochEndEvent(fStep)` is posted **before** `fEpoch` advances
  and **before** `fRecentFittest->clear()`; loggers that dump "recent" brains therefore
  still see the epoch's list.
* `StepEndEvent()` (`738`) is the last thing in the step; every per-step log row
  (`population.txt`, `energy/**`, `stats/**`, `motion/**`, gene stats, separation log, …)
  is written from that handler (L12).

### 5.9 End phase

`End(reason)` (`744-759`) runs at most once (`fEnded`): writes `run/endReason.txt`,
posts `SimEndEvent()`, then `ended()` → the app quits (`SimulationController.cc:183-186`).

`~TSimulation()` (`479-554`) then:

1. walks `gXSortedObjects` for AGENTTYPE and `Kill(a, DR_SIMEND)` on each — **these are
   real logged deaths** (measured: `oracle/minitest_voff/run/lifespans.txt` contains 23
   `SIMEND` rows). Note the `DR_SIMEND` path inside `Kill` returns *before* its own
   `delete c` (`Simulation.cc:3460-3467`); the objects themselves are freed later by
   `agent::agentdestruct()` (`543`) — see the comment at `519-520`;
2. `delete logs` (flush), close the lockstep file, delete barriers, clear the stage;
3. delete `fDomains[id].fittest` / `fLeastFit`, `fFittest`, `fRecentFittest`,
   `agent::agentdestruct()`, `delete agentPovRenderer`;
4. print `Simulation stopped after step <fStep>`, then write `run/endStep.txt` with
   `fStep`.

So the ordered End sequence is: **last step → `MaxSteps`/`PopulationCrash`/`userExit` at
the top of the *next* `Step()` → `endReason.txt` + `SimEndEvent` → all survivors die with
`DR_SIMEND` (logged) → `endStep.txt`**.

---

## 6. Fitness, epochs, generations

### 6.1 Two different fitness notions

| | heuristic | complete (`AgentFitness`) |
|---|---|---|
| source | `agent::HeuristicFitness()` (L8) | `Simulation::AgentFitness`, §5.4.8 |
| weights | `FitnessWeight{Eating,Mating,Moving,EnergyAtDeath,Longevity}` summed into `fTotalHeuristicFitness` (`3933`) | same, plus `ComplexityFitnessWeight` |
| used by | natural-selection mating/smite/thresholds, `fCurrentFittest*`, `fAverageFitness` | `fFittest`, `fRecentFittest`, `fMaxFitness`, regeneration of genome in `CreateAgents` |
| evaluated | live agents, every step (`Fitness(c)`) | dead agents only, in `Kill`'s serial phase (`updateFittest`) → `lastrewards()` at death adds the final terms |

`fAverageFitness` is accumulated **only** for agents with
`Age() >= fSmiteAgeFrac*MaxAge()` (`2866`), reset in `Interact` step 2, and normalized in
`Step` step 15 (so it is the mean heuristic fitness ÷ total weight, i.e. a fraction).

### 6.2 Least-fit queue (smiting)

Filled during `DeathAndStats` (`1867-1912`) for a domain only when
`domain.numAgents > domain.maxNumAgents - domain.fMaxNumLeastFit` **and**
`c->Age() >= fSmiteAgeFrac*MaxAge()` **and** `c->HeuristicFitness() < fPrevAvgFitness`
(`fPrevAvgFitness` is the *previous* step's averaged fitness, captured at `Interact:1492`).
The queue is a fixed-capacity array of the worst-fitting agents, kept descending by
fitness (`fLeastFit[0]` is worst); ties insert **before** the first entry with strictly
greater fitness, i.e. equal-fitness newcomers displace later equals —
`fLeastFit[i].fitness` comparisons are strict `<` throughout.
`fMaxNumLeastFit = lround(fSmiteFrac * domain.maxNumAgents)` (`InitFittest`, `798`).

### 6.3 Epochs

`fEpochFrequency = EpochFrequency` (`3912`, in the oracle worldfiles `EpochFrequency RecordFrequency` = 100),
`fEpoch = fEpochFrequency` initially (`3913`); the event fires at the end of every step
where `fStep % fEpochFrequency == 0`; `fEpoch += fEpochFrequency`; `fRecentFittest->clear()`.
`fRecentFittest` exists only when `NumberRecentFittest > 0 && fEpochFrequency > 0` (`3921-3927`).

---

## 7. Regeneration / steady-state-GA modes

`CreateAgents` picks new genomes from the fittest lists, with these gates (`2969-3020`,
`3077-3126`):

* domain/global list exists **and** `isFull()`;
* `fFitness1Frequency` (worldfile `EliteFrequency`) divides the creation counter
  (`(n/F)*F == n`) → copy the best genome (`copyFrom`) (`fNumberCreated1Fit++`);
* else `fFitness2Frequency` (`PairFrequency`) divides the counter → crossover of two
  fittest (tournament when `fTournamentSize > 0`, else the `ifit`/`jfit` walker);
* else (or no list) → `randomize()` (`fNumberCreatedRandom++`).

Mode forcing (`initFitnessMode` `4636-4672`, `initAdaptivityMode` `4677-4725`,
`initLockstepMode` `4584-4631`) rewrites parameters after the worldfile is read; see §9.
The counters used in the divisibility tests are `fDomains[id].numcreated` for domain
creation and the **static global** `numglobalcreated` (`Simulation.cc:89`, warned about
once) for global top-ups.

---

## 8. RNG inventory (every read reachable from the loop)

### 8.1 Streams and seeds

| Stream | Implementation | Seed / init | Notes |
|---|---|---|---|
| `randpw()` = `drand48()` (`misc.h:40`) | glibc-style 48-bit LCG, global | `srand48(fGenomeSeed)` at `Simulation.cc:371` (worldfile `InitSeed`, oracle = 42); re-seeded with `fSimulationSeed` before step 1 only if non-zero (`567-570`) | everything in §8.3 |
| libc `rand()` | glibc `rand` | `srand(1)` at `Simulation.cc:242` | used **only** by `graphics/gobject.cc` (3 sites) |
| `RandomNumberGenerator::NERVOUS_SYSTEM` | `GLOBAL` ⇒ `drand48`; `LOCAL` ⇒ GSL `gsl_rng_mt19937` | `processWorldFile:3863-3868` sets `LOCAL` iff `StaticTimestepGeometry`; per-agent instance seeded `agentsEver` (`agent.cc:353`) | sensors, `Retina` init, spiking model, metabolism selection |
| `INIT_WEIGHT`, `TOPOLOGICAL_DISTORTION` | set to `LOCAL` by `GroupsBrain.cc:73-76` at brain-config time | per-brain; seeds from genome genes only when `enableTopologicalDistortionRngSeed` / `enableInitWeightRngSeed` (`GroupsBrain.cc:694-709`) | both **False** in the oracle worldfiles ⇒ brain growth draws come from the agent's nervous-system stream |
| `gsl_ran_ugaussian` / `nrand()` | `drand`-based normal (`misc.cc`) | same streams | used by `RqSensor`, brain weight init |

### 8.2 Why parallel execution is deterministic *today*

* Under `StaticTimestepGeometry True`, every RNG read inside `UpdateBrain` /
`UpdateVision` / `grow` belongs to an object that owns its own MT19937, seeded from a
  deterministic counter ⇒ no cross-thread data race.
* Per-agent loggers write per-agent files (`Logs::BrainFunctionLog::processEvent`,
  `Logs.cc:792`), so the concurrent event order is not observable.
* That is exactly why `--ParallelBrains False` and `--ParallelCreateAgents False`
  reproduce the golden byte-for-byte **[measured]**, while the parallel paths that defer
  *list mutation* (`Interact`) or energy accounting (`InitAgents`) do not change the
  schedule but do change **the order of effects** (§3.3).

**PORT-NOTE(rng-local-per-agent):** the port must give each agent its own MT19937
nervous-system stream seeded with the agent's ever-number (1-based, `agentsEver`), and
must set the map/table streams per the flag; a single global RNG for the model will not
reproduce the golden once `StaticTimestepGeometry` is true.

### 8.3 `drand48` (`randpw()`) call sites — order matters

`Simulation.cc` (line → context):

| Line | Phase | Draws |
|---|---|---|
| 899, 960-972 | Init `InitAgents` | `360*randpw()` yaw; global top-up x/z/yaw |
| 1064 | Init `SeedGenome` | 1 per seeded genome (`< probabilityOfMutatingSeeds`) |
| 1226, 1235 | Init/Create `PickParentsUsingTournament` | `fTournamentSize` per parent (×2, redrawn while equal) |
| 1720 | Step `DeathAndStats` lockstep | 1 per lockstep death |
| 1802 | Step `DeathAndStats` natural death gate | only if clauses 1-2 fail **and** `fAllowMinDeaths` |
| 1832 | `#ifdef OF1` (not compiled) | — |
| 1943, 1964, 2011-2015 | Step `MateLockstep` | 2 parent picks + x/z/yaw per birth |
| 2046 | Step `GetMatePotential` | only if `fProbabilisticMating` |
| 2135 | Step `GetMateDenialStatus` | only when status == NIL and `fMiscAgents >= 0` and domain born-count ≥ it |
| 2232-2233 | Step `Mate` birth location | only if `fRandomBirthLocation` |
| 2328 | Step `Smite` mode `'R'` | 1 |
| 3031-3034 | Step `CreateAgents` (domain) | 3 per creature |
| 3129-3130 | Step `CreateAgents` (global) | 3 per creature |
| 3231, 3282 | Step `MaintainFood` | 1 per probabilistic food growth |
| 3710 | `AddFood` | `trand()` when `fStep == 0 && RandomInitFoodAge` |
| 5279 | `getRandomPatch` | 1 per successful patch pick |

Elsewhere in the model: genome `randomize`/`mutate`/`crossover` (`Genome.cc`, 7 sites;
`GroupsGenome.cc`, 6), `Patch.cc` (6, patch-point sampling), `food.cc` (3),
`brick.cc` (1), `GenomeSchema.cc`, `SheetsCrossover.cc`, `distributions.cc` (4),
`misc.cc` (`trand`, `nrand`, `logistic`). All of these are **global** `drand48` unless the
caller passes an RNG object — so any change in the number of draws before them shifts
every subsequent genome, position, and food placement.

**PORT-NOTE(rng-shortcircuit):** implement every `&&`/`||` condition that contains a draw
with C++ short-circuit semantics (`IS_PREVENTED_BY_CARRY` at `Simulation.cc:182-183` is
the clearest case: with `CarryPrevents* == 0.0` the draw must not happen).

`IS_PREVENTED_BY_CARRY(ACTION, AGENT)` ≡
`fCarryPrevents<ACTION> != 0 && AGENT->NumCarries() > 0 && randpw() < fCarryPrevents<ACTION>`
with `ACTION ∈ {Eat, Fight, Give, Mate}`; `fFightThreshold`, `fGiveThreshold`,
`fPickupThreshold`, `fDropThreshold`, `fMateThreshold`, `fEatThreshold` are plain
comparisons (no draws).

---

## 9. Seeding & lockstep replay

* **Seeds.** `InitSeed` → `srand48` (`371`); `SimulationSeed` → optional re-seed before
  step 1 (`567-570`); `PositionSeed` is read into `fPositionSeed` (`3898`) but **never
  used** anywhere in the tree (grep: only the header declaration and that assignment) —
  dead parameter, `PORT-NOTE(position-seed-unused)`. `genomeSeeds.txt` +
  `SeedGenomeFromRun` and `seedPositions.txt` + `SeedPositionFromRun` provide
  reproducible seeding (`1056-1215`); `ReadSeedFilePaths` copies the file to
  `run/genome/`, `ReadSeedPositionsFromFile` to `run/motion/position/`.
* **Lockstep (`PassiveLockstep`/`fLockStepWithBirthsDeathsLog`).** `initLockstepMode()`
  (`4584-4631`) forces: `dieAtMaxAge = false`, all energy-cost coefficients
  (`eat2Energy`, `mate2Energy`, `fight2Energy`, `maxSizePenalty`, `speed2Energy`,
  `yaw2Energy`, `light2Energy`, `focus2Energy`, `pickup2Energy`, `drop2Energy`,
  `carryAgent2Energy`, `carryAgentSize2Energy`, `fixedEnergyDrain`,
  `food::gCarryFood2Energy`, `brick::gCarryBrick2Energy`) to 0, `fNumDepletionSteps = 0`,
  `fMaxPopulationPenaltyFraction = 0`, `fApplyLowPopulationAdvantage = false`,
  `fEnergyBasedPopulationControl = false`.
  A pre-recorded `LOCKSTEP-BirthsDeaths.log` (from an earlier natural run) is read
  (`332-362`): header lines beginning `#` or `%` are skipped, the file is copied to
  `run/`, and `SetNextLockstepEvent()` (`5303-5362`) parses the *next* line into
  `fLockstepTimestep` and counts the `B`/`D`/`C` events on that timestep (`C` is treated
  as a birth with a warning; anything else is fatal).
  During the run: deaths at `fLockstepTimestep == fStep` are *forced* at the top of
  `DeathAndStats` (**1 draw per death**), all natural deaths, fight/eat/give deaths, and
  mating births are suppressed (`if (!fLockStepWithBirthsDeathsLog)` guards), successful
  matings produce **virtual** births (`fNumberBornVirtual`, `Birth(NULL, BR_VIRTUAL, …)`),
  and at `Interact` step 5 the forced births happen (`MateLockstep`). Both directions
  draw from the global `drand48` and the `'R'`-style random-index selection walks the
  live x-sorted list, so lockstep replay is exact only if the list state matches the
  original run — i.e. it is a *replay* mechanism, not an independent seed.
* **Determinism envelope.** Two native runs of the same worldfile are byte-identical
  (measured here: baseline == recorded golden, 1369/1369) with vision both off and on,
  the only exception being `run/movie.pmv` (delta-compressed, written by the graphics
  path, Tier C — not frozen).

---

## 10. Parameters read from the worldfile (`processWorldFile`, `3822-4579`)

Grouped as they appear; the port's config layer (L1/L3) must expose them under the same
names. Defaults come from `etc/worldfile.wfs`, not from this function.

* Top level: `PassiveLockstep`, `AdaptivityMode`, `MaxSteps`, `StepsPerSecond`,
  `EndOnPopulationCrash`, `CheckPointFrequency`, `Edges` (`B`=blocked `W`=wrap `T`=toroidal
  `S`=sticky, mapped to `globals::blockedEdges/wraparound/stickyEdges`), `NumEnergyTypes`,
  `StaticTimestepGeometry`, `ParallelInitAgents`, `ParallelInteract`,
  `ParallelCreateAgents`, `ParallelBrains`, `MinAgents`, `MaxAgents`, `InitAgents`,
  `SeedAgents`, `SeedMutationProbability`, `RawSeedMutationRate`, `SeedGenomeFromRun`,
  `SeedPositionFromRun`, `MiscegenationDelay`, `InitFood`, `MinFood`, `MaxFood`,
  `MaxFoodGrown`, `FoodGrowthRate`, `FoodGrowthModel`, `FoodRemoveEnergy`,
  `FoodRemoveFirstEat`, `FoodMaxLifeSpan`, `RandomInitFoodAge`, `PositionSeed`,
  `InitSeed`, `SimulationSeed`, `AgentsAreFood` (`Fight`/bool), `EliteFrequency`,
  `PairFrequency`, `EpochFrequency`, `NumberFittest`, `NumberRecentFittest`,
  `FitnessWeight{Eating,Mating,Moving,EnergyAtDeath,Longevity}`, `MinFoodEnergy`,
  `MaxFoodEnergy`, `FoodEnergySizeScale`, `FoodConsumptionRate`, `Carry{Agents,Food,Bricks}`,
  `Shield{Agents,Food,Bricks}`, `CarryPrevents{Eat,Fight,Give,Mate}`, `EatWait`,
  `ProbabilisticMating`, `MateWait`, `EatMateWait`, `EatMateMinDistance`,
  `MaxMateVelocity`, `MinEatVelocity`, `MaxEatVelocity`, `MaxEatYaw`,
  `MinMateEnergyFraction`, `DamageRate`, `EnergyUseCarryFood`, `EnergyUseCarryBrick`,
  `AgentHealingRate`, `EatThreshold`, `MateThreshold`, `FightThreshold`, `FightMultiplier`,
  `FightMode`, `GiveThreshold`, `GiveFraction`, `PickupThreshold`, `DropThreshold`,
  `Solid{Agents,Food,Bricks}`, `FoodHeight`, `FoodColor`, `BrickHeight`, `BarrierHeight`,
  `BarrierColor`, `StickyBarriers`, `RatioBarrierPositions`, `GroundColor`,
  `GroundClearance`, `WorldSize`, `Barriers[]`, `FoodTypes[]`, `AgentMetabolisms[]`,
  `AgentMetabolismSelectionMode`, `Domains[]` (each with `CenterX/CenterZ/SizeX/SizeZ`,
  `Min/Max/InitAgentsFraction`, `InitSeedsFraction`, `ProbabilityOfMutatingSeeds`,
  `Init/Min/Max/MaxFoodGrownFraction`, `FoodRate`, `InitAgentsPatch`, `FoodPatches[]`,
  `BrickPatches[]`), `ProbabilisticFoodPatches`, `MinFoodEnergyAtDeath`,
  `RandomBirthLocation`, `RandomBirthLocationRadius`, `SmiteMode` (`O`/`R`/`L`),
  `SmiteFrac`, `SmiteAgeFrac`, `NumDepletionSteps` (sets
  `fMaxPopulationPenaltyFraction = 1/NumDepletionSteps`), `ApplyLowPopulationAdvantage`,
  `EnergyBasedPopulationControl`, `PopControl{Global,Domains,MinFixedRange,MaxFixedRange,MinScaleFactor,MaxScaleFactor}`,
  `AllowBirths`, `AllowMinDeaths`, `ComplexityType`, `ComplexityFitnessWeight`,
  `HeuristicFitnessWeight`, `TournamentSize`, `CompressFiles`, `FogFunction`,
  `ExpFogDensity`, `LinearFogEnd`, `Variables[]`.
* Derived per domain: `absoluteSizeX/Z`, `startX/Z`, `endX/Z` (with the
  `0.0006` snapping at `4174-4181`), `minMaxInitNumAgents` from the fractions,
  `probabilityOfMutatingSeeds` fallback, food/brick patch counts+counts.
* `fMinNumAgentsWithMetabolism[i] = MinAgents / Metabolism::getNumberOfDefinitions()` (`4130`).
* `EnergyBasedPopulationControl True` + `PopControlGlobal True` is the oracle
  configuration: `fGlobalEnergyScaleFactor` is recomputed every step (§5.1).
* `WhichDomain(x, z, d)` (`4809-4833`): first domain whose inclusive `[startX,endX]` ×
  `[startZ,endZ]` contains the point; `error(2)` (abort) if none matches — the port should
  surface this as a hard error, not a silent `-1`.
* `SwitchDomain` (`4841-4866`) adjusts `numAgents`/`foodCount`; called by the agent lane
  when an agent crosses a domain boundary in `UpdateBody`.

---

## 11. Order-dependent and float-sensitive hot spots (for the parity oracle)

### 11.1 Order-dependent (iteration or schedule)

1. `gXSortedObjects` cursor semantics — §3.2. Everything in `Interact`, `Eat`, `Pickup`,
   `Kill` depends on it.
2. The x-order of all passes: `UpdateAgents*`, `Interact` outer loop, `DeathAndStats`,
   `CreateAgents`, `MaintainFood`'s FOODTYPE walk, `MaintainBricks`, `Fitness(c)`
   insert order, `updateFittest` FIFO order, the `DR_SIMEND` kill order in the destructor.
3. `postSerial` deferral (§3.1) — measured to change the trajectory.
4. Tie-breaking in the fittest/least-fit insertion (equal fitness ⇒ append / displace
   later equals), and `fRecentFittest->clear()` after the epoch event.
5. `do { … } while (jParent == iParent)` in `PickParentsUsingTournament` — extra draws.
6. `fDomain` assignment order (`WhichDomain` first-match) and the destructor's kill order.

### 11.2 Float-sensitive

* Model math is `float`/`double` as written; every store into a `float` member must be
  `Math.fround`-ed (PORT_SPEC rule 3).
* Accumulation order of `fFoodEnergyIn/Out`, `fEnergyEaten`, `fTotal*` and the running
  averages at `Step` 20 and `718-719`; `FoodEnergyIn/Out` add `e[0]` (`3759`, `3766`).
* `EnergyScaleFactor` uses `pow(fraction, 4.0)` (`1263`) and `lround`/`nint` rounding.
* The interaction test `sqrt(dx*dx + dz*dz) <= (d->radius() + c->radius())` (`1591`)
  mixes a double `sqrt` with float operands.
* `AverageAngles` (`114-128`) — `fabs(a-b) > 180.0` branch wrap.
* Carcass-energy arithmetic in `Kill` (`3516-3534`) uses multiply/constrain chains.
* `FoodPatch::getArea()`-derived fractions when all patch fractions are 0 (`4373-4388`),
  guarded by the `0.99999/1.00001` slop test (`4391-4395`).
* Any `exp/log/pow/sqrt/sin/cos` reached from the loop (libm drift, PORT_SPEC rule 3;
  the ~60 call sites are L1/L10/L13 territory but the loop-level ones are `sqrt` above,
  `pow` in `EnergyScaleFactor`, and `sqrt` in the ctor's radius computation).

### 11.3 Things that look like state but are not

* FPS fields (`fFramesPerSecond*`, `fSecondsPerFrame*`, `fTimeStart`) — UI/status only;
  no log file or model decision reads them (grep: zero hits outside `Simulation.cc`).
* `run/movie.pmv` — Tier C, not frozen (PORT_SPEC).
* `getStatusText` (`4872-5260`) — read-only formatting for the UI.
* `Dump()`/`pw.dump` (`4730-4803`) — checkpoint dump; not part of the frozen surface, and
  `fLoadState` is never set by the current app, so `InitAgents` always runs.
* `Logs`/monitor `postEvent` ordering — see L12; the sim's obligation is the *event
  sequence* in §4/§5, not the file format.

---

## 12. TypeScript shape (what the port needs to exist)

```ts
interface SimCtx {
  step: number;                     // fStep
  objects: XSortedObjectList;       // gXSortedObjects, cursor + marks + sort/add/remove
  domains: Domain[];                // fDomains
  counts: { alive: number; aliveWithMetabolism: number[]; born: number; bornVirtual: number; ... };
  energy: { inStep: number; outStep: number; eaten: number; totalIn: number; totalOut: number;
            avgIn: number; avgOut: number };
  fitness: { currentAgents: Agent[]; currentMax: number[]; currentCount: number;
             fittest: FittestList; recentFittest: FittestList | null;
             max: number; avg: number; numAvg: number; prevAvg: number; totalHeuristic: number };
  epoch: { value: number; frequency: number };
  sched: Scheduler;                 // §3.1
  logs: LogSink;                    // receives typed events, in the order produced
  stage: Stage;                     // graphics; no-ops for the model when vision is off
  rng: { drand48(): number; /* global */ };
}
```

Step loop (literal translation of §5, `//` = the phase number in §5):

```ts
function step(s: SimCtx): void {
  if (s.frames === 0 && s.cfg.simulationSeed !== 0) drand48Seed(s.cfg.simulationSeed);
  s.frames++;
  if (s.cfg.maxSteps !== 0 && s.step + 1 > s.cfg.maxSteps) return end(s, "MaxSteps");
  if (s.cfg.endOnPopulationCrash && s.objects.count(AGENTTYPE) <= s.cfg.minNumAgents)
    return end(s, "PopulationCrash");
  s.step++;
  // 6 FPS stats (skip in port; not observable)
  // 7 fMaxGapCreate / per-domain maxgapcreate
  s.energy.inStep = 0; s.energy.outStep = 0; s.energy.eaten = 0;
  updateCppProperties(s);                          // 9 (no-op unless dynamic props exist)
  for (const b of s.barriers) { b.update(); }      // 10
  xsortBarriers(s);
  maintainEnergyCosts(s);                          // 11
  s.povRenderer.beginStep();                       // 12
  if (s.cfg.staticTimestepGeometry) updateAgentsStaticGeometry(s);
  else                              updateAgents(s);
  s.povRenderer.endStep();
  s.sched.execMasterTask(() => interact(s), !s.cfg.parallelInteract);   // 13
  if (s.counts.alive !== s.objects.count(AGENTTYPE)) throw new Error("alive != count");
  if (s.fitness.numAvg > 0) s.fitness.avg /= s.fitness.numAvg * s.fitness.totalHeuristic;
  s.sched.execMasterTask(() => createAgents(s), !s.cfg.parallelCreateAgents);  // 16
  maintainBricks(s);                               // 17
  maintainFood(s);                                 // 18
  s.energy.totalIn += s.energy.inStep; s.energy.totalOut += s.energy.outStep;
  s.energy.eatenTotal += s.energy.eaten;
  s.energy.avgIn  = (fround((s.step - 1) * s.energy.avgIn)  + s.energy.inStep)  / s.step;
  s.energy.avgOut = (fround((s.step - 1) * s.energy.avgOut) + s.energy.outStep) / s.step;
  s.stepEnding.emit();                             // 21 monitors (observers only)
  if (s.epoch.frequency !== 0 && s.step % s.epoch.frequency === 0) {
    s.logs.post(new EpochEndEvent(s.step)); s.epoch.value += s.epoch.frequency; s.fitness.recentFittest?.clear();
  }
  s.logs.post(new StepEndEvent());
}
```

`Scheduler` (§3.1) in TS, no threads:

```ts
class Scheduler {                    // matches the *recorded* (parallel) semantics
  private serial: (() => void)[] = [];
  private parallel: (() => void)[] = [];
  private master = false;
  private forceAllSerial = false;
  execMasterTask(task: () => void, forceAllSerial: boolean) {
    this.forceAllSerial = forceAllSerial;
    if (forceAllSerial) { task(); return; }
    this.master = true; this.parallel = []; this.serial = [];
    task();
    this.master = false;
    for (const t of this.parallel) t();   // PORT-NOTE(sched-deferral): runs before the serial phase
    for (const t of this.serial) t();     // FIFO, push order
    this.parallel = []; this.serial = [];
  }
  postParallel(t: () => void) { this.forceAllSerial ? t() : this.parallel.push(t); }
  postSerial(t: () => void)   { this.forceAllSerial ? t() : this.serial.push(t); }
}
```

---

## 13. PORT-NOTEs in this spec

| Name | Decision | Where |
|---|---|---|
| `list-cursor` | model `gXSortedObjects` as a cursor+marks linked list; never re-sort into arrays mid-pass | §3.2 |
| `sched-deferral` | implement the parallel-mode semantics: `postParallel` batch then FIFO `postSerial`, after the master task | §3.1, §3.3 |
| `sched-flags` | `ParallelBrains`/`ParallelCreateAgents` are no-ops; `ParallelInitAgents=false`/`ParallelInteract=false` unsupported in v1 (deferred ordering is the reference) | §3.3 |
| `rng-shortcircuit` | C++ short-circuit evaluation for every condition containing a draw | §3.3, §8.3 |
| `rng-local-per-agent` | per-agent MT19937 nervous-system stream seeded with the 1-based ever-number when `StaticTimestepGeometry` | §8.2 |
| `sqrt-cmp` | distance test in f64 (`Math.sqrt` on promoted operands), radius sum promoted too | §5.4 |
| `position-seed-unused` | `PositionSeed` is dead in the native tree; port keeps the parameter and ignores it | §9 |
| `static-sort-stable` | sort/add by key `x - radius` must be stable (ties keep existing order) | §3.2 |
| `end-simend-kills` | the destructor's `DR_SIMEND` kills are model-visible (lifespans) and must be emitted | §5.9 |
| `steps-per-second` | pacing only; the port must not let the frame timer influence state | §5 |

No new dependencies are proposed by this lane. The runtime props compiler
(`run/.cppprops` + `clang++` + `make`, Init phase 12) is a native build-time concern that
the port replaces with a compiled-in property set — flagged here as the L3/L4 interface
(`PORT_SPEC.md` rule 7), not as a dependency.

---

## 14. How this spec was verified

1. **Reading** — every statement above carries a `file:line`; the branch/loop structure
   was transcribed from `Simulation.cc`, `Scheduler.cc`, `objectxsortedlist.cc`,
   `Simulation.h`, `Domain.h`, `FittestList.cc`, `GeneStats.cc`, `EatStatistics.cc`,
   `simconst.h`, `globals.h`, `RandomNumberGenerator.{h,cc}`, `misc.h`, `Events.h`,
   `LifeSpan.h`, `agent.cc` (the update/grow/RNG sites), `GroupsBrain.cc` (brain RNG),
   `Logs.{h,cc}` (event handlers), `app/main.cc`, `app/ui/SimulationController.cc`.
2. **RNG/clock inventory** — exhaustive `grep` for `randpw|drand48|drand|nrand|trand|rand()` and
   `hirestime|time(|clock(|gettimeofday` across `library/`, `app/`, `tools/`; result in
   §8 and §11.3 (clock reads: one, `Simulation.cc:593`, FPS only; `time(NULL)` once,
   `Simulation.cc:253`, naming the archived `run` directory).
3. **Scheduler experiment [measured]** — the native binary was copied to a scratch dir
   (with `src/library/proplib/interpreter.py`, needed by `Resources::getInterpreterScript`)
   and run five times on `minitest.wf` with `--Vision False`, once per
   `Parallel*` override; each run was scored with
   `tools/check_parity.py --golden oracle/minitest_voff --candidate <snap>`:
   baseline 1369/1369 model files identical to the golden; `ParallelBrains` and
   `ParallelCreateAgents` off ⇒ 2 differing files, both the worldfile dumps that record
   the override; `ParallelInitAgents` off ⇒ 379 differing; `ParallelInteract` off ⇒
   684 differing + 461 missing + 493 extra, first trajectory divergence at step 37/38.
4. **End-phase check [measured]** — `oracle/minitest_voff/run/lifespans.txt` contains 23
   `SIMEND` rows, confirming that the destructor's kills are part of the frozen artifacts.
5. Checks that are *not* done here and are left to the fan-in tester: TS-side confirmation
   of the list-cursor semantics, and byte-parity of the energy/log artifacts against
   `oracle/minitest_voff`.

Probe artifacts (kept, not part of the repo): the scratch dir with the five run trees,
`probe.sh`, `firstdiff.py` — under
`~/.hermes/profiles/fullstack-dev-4/cache/scratch/pwprobe2/`. Reproduce with
`bash probe.sh "$PWD"` from that directory.

## 15. Open questions (human input wanted)

1. `ParallelInitAgents=false` / `ParallelInteract=false` — do we (a) emulate the deferred
   semantics for both modes (most faithful, more work), or (b) accept only the recorded
   parallel configuration and reject the others? Recommended: (b) for v1, with the
   scheduler written as in §12 so (a) is a small change later.
2. Is the init-phase float drift (measured, `--ParallelInitAgents=False`, energy column
   only) worth chasing, or is the port expected only to match the recorded configuration?
3. `Seeds`, lockstep replay, and `genomeSeeds.txt`/`seedPositions.txt` file inputs are not
   used by any oracle scenario. Confirm they stay out of v1.

---

## 16. Rows to paste into `PARITY.md` (owner of PARITY.md: please apply)

`PARITY.md` is not this lane's file, so the rows this spec owes it are collected here.
No new dependencies are proposed by lane W1i (the "Dependency proposals" table stays
empty as far as this lane is concerned; the runtime props compiler is a build-time
concern replaced in the port, see §13).

Deviations (deliberate, reviewed) — append to that table:

| Where | Source behavior | Port behavior | Why |
|---|---|---|---|
| L11 sim scheduler | `postParallel` tasks run on a worker pool; `postSerial` tasks run after the master task (or inline when the `Parallel*` flag is false) | `Scheduler` executes the `postParallel` batch then the FIFO `postSerial` batch, after the master task (spec §3.1, §12) | measured: deferred list insertion is model-visible; forced-serial diverges from the golden (spec §3.3) |
| L11 sim, `ParallelBrains`/`ParallelCreateAgents` | thread-pool execution | treated as no-ops (inline, list order) | measured byte-identical to the golden (spec §3.3) |
| L11 sim, `ParallelInitAgents=false` / `ParallelInteract=false` | supported by the native binary | unsupported in v1 — the port reproduces the recorded (parallel) ordering | measured to change the trajectory (spec §3.3); waiting on open question 1 |

Gaps — add to that table:

| Gap | Lane that closes it | Note |
|---|---|---|
| `run/.cppprops` runtime compilation + `dlopen` (init phase 12) | L3/L4 (proplib) | port compiles the property set in; no `clang++`/`make` at runtime |
| `player`/movie recording (`run/movie.pmv`) | L16/L18 | Tier C, never frozen |
| checkpoint `Dump()`/`pw.dump` and `fLoadState` | not scheduled | `fLoadState` is never set true in the native app |

PORT-NOTE roll-up for the L11 rows: see §13 of this file (names `list-cursor`,
`sched-deferral`, `sched-flags`, `rng-shortcircuit`, `rng-local-per-agent`, `sqrt-cmp`,
`position-seed-unused`, `static-sort-stable`, `end-simend-kills`, `steps-per-second`).

