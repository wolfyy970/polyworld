// Lane W1j/L16 — dump the native retina rows from a recorded oracle run (no debugger needed).
//
// Why
// ---
// `docs/specs/vision-spec.md` §11.4 defines this lane's acceptance surface as the
// `3 x numneurons` nerve doubles the retina feeds the brain, but the goldens only keep them
// *after* `%g` (6 significant digits). To check the port's encoder against **real pixels**
// rather than against rows reconstructed from the spec, this shim reads `Retina::buf` right
// after `glReadPixels` filled it (`Retina.cc:116-122`) and writes one JSON line per agent per
// step.
//
// How
// ---
// `PrintBrain` is a compile-time `false` (`brain/Brain.h:20`), so the model cannot print the
// buffer itself. Instead of a debugger (macOS developer mode is off on this machine — lldb
// refuses a non-interactive session with "cannot get permission to debug processes") this is a
// `DYLD_INSERT_LIBRARIES` interposer over three non-virtual entry points:
//
//   * `Retina::updateBuffer(short, short, short, short)` — called from `libpwqtrenderer`'s
//     `QtAgentPovRenderer::render`, i.e. from a *different* image, so dyld's
//     `__DATA,__interpose` rebinds the call. The replacement calls the original first (through
//     `dlsym`, so the interposer cannot recurse into itself) and then dumps `Retina::getBuffer()`.
//   * `agent::UpdateVision()` — registers retina -> agent, so each row can be attributed to its
//     `brainFunction_<agent>` file (`Logs.cc:817` names it with `agent::Number()`).
//   * `TSimulation::Step()` — a step counter, so rows carry the step they belong to (the
//     exported `TSimulation::fStep` is used if that interposition does not fire).
//
// The native headers are included read-only: that is how the shim gets the real class layouts
// and the public accessors (`agent::GetRetina`, `agent::GetNervousSystem`, `agent::Number`,
// `Retina::getBuffer`) instead of mirrored offsets. The lane writes nothing into the native
// tree; the only output is the dump file (`VISION_DUMP_OUT`), and the native run's own `run/`
// tree is produced exactly as `tools/record_oracle.py` produces it.
//
// Build/run: `src/model/vision/native/retinadump.sh`.

#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "agent/Retina.h"
#include "agent/agent.h"
#include "brain/Nerve.h"
#include "brain/NervousSystem.h"

// --- the originals, resolved by dlsym so the interposer never recurses into itself ---------
typedef void (*UpdateBufferFn)(Retina *, short, short, short, short);
typedef void *(*AttachedGetFn)(agent *, unsigned int);

static UpdateBufferFn realUpdateBuffer = NULL;
static AttachedGetFn realAttachedGet = NULL;

// `TSimulation::fStep`, exported as `S __ZN11TSimulation5fStepE`. Read directly instead of
// interposing `TSimulation::Step()`: a data symbol needs no interposition, and a *broken*
// interposition of `Step` would stop the simulation from stepping at all (which is a hang, not
// an error).
extern "C" long pw_fStep asm("__ZN11TSimulation5fStepE");

// --- the replacement symbols -----------------------------------------------------------------
extern "C" void pwvision_updateBuffer(Retina *self, short x, short y, short w, short h);
extern "C" void *pwvision_attachedGet(agent *self, unsigned int handle);

// The Mach-O names of the replacees, straight out of `nm lib/libpolyworld.dylib`.
extern "C" void pw_mangled_updateBuffer(Retina *, short, short, short, short) asm("__ZN6Retina12updateBufferEssss");
extern "C" void *pw_mangled_attachedGet(agent *, unsigned int) asm("__ZN17AgentAttachedData3getEP5agentj");

// `__DATA,__interpose` maps calls to `replacee` onto `replacement` for every image bound after
// this one — which is what catches the cross-image calls from the Qt POV renderer.
//
// PORT-NOTE(vision/native-dump-internal-calls): only calls that *leave* libpolyworld can be
// interposed. `Retina::updateBuffer` and `AgentAttachedData::get` are both called from
// `libpwqtrenderer` (`QtAgentPovRenderer::{render,add}`), so they are reachable;
// `agent::UpdateVision`, `TSimulation::Step` and `QtAgentPovRenderer::render` are not (the
// first two are same-image calls ld64 binds directly, the last is a virtual call through a
// vtable). Verified by measurement: interposing `UpdateVision` produced 0 hits while the other
// two fire once per agent per step.
#define PW_INTERPOSE(replacement, replacee)                                        \
  __attribute__((used)) static struct {                                            \
    const void *replacement;                                                       \
    const void *replacee;                                                          \
  } pw_interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {      \
      (const void *)(unsigned long)&replacement,                                   \
      (const void *)(unsigned long)&replacee,                                      \
  };

PW_INTERPOSE(pwvision_updateBuffer, pw_mangled_updateBuffer)
PW_INTERPOSE(pwvision_attachedGet, pw_mangled_attachedGet)

// --- state -----------------------------------------------------------------------------------
#define PW_MAX_RETINAS 512

static FILE *gDump = NULL;
static long gRows = 0;
static long gAttachedGets = 0;
static long gUpdateBufferCalls = 0;
static long gAgentRows = 0; // rows whose agent could not be resolved
static bool gCheckedLayout = false;
static Retina *gRetinas[PW_MAX_RETINAS];
static agent *gRetinaOwners[PW_MAX_RETINAS];
static int gRetinaCount = 0;

// A NULL original is a hard error: silently skipping it would leave the simulation rendering
// nothing (or not stepping at all) and look like a hang.
static void pwvision_fatal(const char *what)
{
  fprintf(stderr, "pwvision: could not resolve the original %s -- aborting\n", what);
  fflush(stderr);
  abort();
}

static void registerRetina(Retina *retina, agent *owner)
{
  for (int i = 0; i < gRetinaCount; i++)
  {
    if (gRetinas[i] == retina)
    {
      gRetinaOwners[i] = owner;
      return;
    }
  }
  if (gRetinaCount < PW_MAX_RETINAS)
  {
    gRetinas[gRetinaCount] = retina;
    gRetinaOwners[gRetinaCount] = owner;
    gRetinaCount++;
  }
}

static agent *ownerOf(Retina *retina)
{
  for (int i = 0; i < gRetinaCount; i++)
  {
    if (gRetinas[i] == retina)
      return gRetinaOwners[i];
  }
  return NULL;
}

static void dumpRow(Retina *retina, short x, short y, short w, short h)
{
  if (!gDump)
    return;

  agent *owner = ownerOf(retina);
  if (!owner)
    gAgentRows++;

  long neurons[3] = { -1, -1, -1 };
  if (owner)
  {
    NervousSystem *cns = owner->GetNervousSystem();
    if (cns)
    {
      const char *names[3] = { "Red", "Green", "Blue" };
      for (int i = 0; i < 3; i++)
      {
        Nerve *nerve = cns->getNerve(names[i]);
        if (nerve)
          neurons[i] = (long)nerve->getNeuronCount();
      }
    }
  }

  const unsigned char *buf = retina->getBuffer();
  if (!buf)
    return;

  if (!gCheckedLayout)
  {
    gCheckedLayout = true;
    if (w <= 0 || w > 4096)
    {
      fprintf(stderr, "pwvision: unexpected retina width %d -- aborting dump\n", (int)w);
      fclose(gDump);
      gDump = NULL;
      return;
    }
  }

  const long step = pw_fStep;

  fprintf(gDump,
          "{\"step\":%ld,\"agent\":%ld,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"neurons\":[%ld,%ld,%ld],\"row\":\"",
          step, owner ? owner->Number() : -1, (int)x, (int)y, (int)w, (int)h,
          neurons[0], neurons[1], neurons[2]);
  for (int i = 0; i < w * 4; i++)
    fprintf(gDump, "%02x", (unsigned)buf[i]);
  fprintf(gDump, "\"}\n");
  gRows++;
}

extern "C" void pwvision_updateBuffer(Retina *self, short x, short y, short w, short h)
{
  if (!realUpdateBuffer)
    pwvision_fatal("Retina::updateBuffer");
  if (realUpdateBuffer == (UpdateBufferFn)(void *)&pwvision_updateBuffer)
    pwvision_fatal("Retina::updateBuffer resolved to the shim itself");
  gUpdateBufferCalls++;
  realUpdateBuffer(self, x, y, w, h);
  dumpRow(self, x, y, w, h);
}

// `AgentAttachedData::get(a, slotHandle)` is called by `QtAgentPovRenderer::render` for the
// agent whose POV is about to be drawn — the cross-image call that tells this shim which agent
// owns the retina that `updateBuffer` is about to fill.
extern "C" void *pwvision_attachedGet(agent *self, unsigned int handle)
{
  if (!realAttachedGet)
    pwvision_fatal("AgentAttachedData::get");
  if (realAttachedGet == (AttachedGetFn)(void *)&pwvision_attachedGet)
    pwvision_fatal("AgentAttachedData::get resolved to the shim itself");
  gAttachedGets++;
  Retina *retina = self ? self->GetRetina() : NULL;
  if (retina)
    registerRetina(retina, self);
  if (gAttachedGets < 4)
  {
    fprintf(stderr, "pwvision: attachedGet #%ld agent=%p number=%ld retina=%p\n", gAttachedGets,
            (void *)self, self ? self->Number() : -1, (void *)retina);
    fflush(stderr);
  }
  return realAttachedGet(self, handle);
}

// Resolve an original symbol *by parsing the image's symbol table*.
//
// PORT-NOTE(vision/native-dump-self-interposition): `dlsym` cannot be used here — dyld applies
// the interposition to dlsym lookups too, so `dlsym(RTLD_NEXT/RTLD_DEFAULT/handle, …)` returns
// this shim's own replacement (verified: it compared equal to `&pwvision_updateBuffer`, which
// recursed into a stack overflow). The original address is instead read out of libpolyworld's
// `LC_SYMTAB` (`n_value` is the unslid VM address; add the image slide), which no interposition
// touches. `machO` is the Mach-O spelling of the symbol (`nm` shows it, with the extra leading
// underscore).
static void *symbolInImage(const struct mach_header_64 *header, intptr_t slide, const char *machO)
{
  const struct load_command *command = (const struct load_command *)(header + 1);
  const struct symtab_command *symtab = NULL;
  for (uint32_t i = 0; i < header->ncmds; i++)
  {
    if (command->cmd == LC_SYMTAB)
    {
      symtab = (const struct symtab_command *)command;
      break;
    }
    command = (const struct load_command *)((const char *)command + command->cmdsize);
  }
  if (!symtab)
    return NULL;

  const struct nlist_64 *symbols = (const struct nlist_64 *)((const char *)header + symtab->symoff);
  const char *strings = (const char *)header + symtab->stroff;
  for (uint32_t i = 0; i < symtab->nsyms; i++)
  {
    if (symbols[i].n_un.n_strx == 0)
      continue;
    const char *name = strings + symbols[i].n_un.n_strx;
    if (name && strcmp(name, machO) == 0 && symbols[i].n_value != 0)
      return (void *)(uintptr_t)(symbols[i].n_value + (uintptr_t)slide);
  }
  return NULL;
}

static void *resolve(const char *machO)
{
  for (uint32_t i = 0; i < _dyld_image_count(); i++)
  {
    const char *name = _dyld_get_image_name(i);
    if (!name || !strstr(name, "libpolyworld.dylib"))
      continue;
    const struct mach_header *header = _dyld_get_image_header(i);
    if (!header || header->magic != MH_MAGIC_64)
      continue;
    void *symbol = symbolInImage((const struct mach_header_64 *)header, _dyld_get_image_vmaddr_slide(i), machO);
    if (symbol)
      return symbol;
    fprintf(stderr, "pwvision: %s has no symbol %s\n", name, machO);
  }
  return NULL;
}

static void pwvision_diag(const char *machO)
{
  fprintf(stderr, "pwvision: images (%u):\n", _dyld_image_count());
  for (uint32_t i = 0; i < _dyld_image_count(); i++)
  {
    const char *name = _dyld_get_image_name(i);
    if (!name || !strstr(name, "libpolyworld.dylib"))
      continue;
    const struct mach_header *header = _dyld_get_image_header(i);
    fprintf(stderr, "  [%u] %s header=%p\n", i, name, (void *)header);
    if (header && header->magic == MH_MAGIC_64)
      fprintf(stderr, "       symbol %s -> %p\n", machO,
              symbolInImage((const struct mach_header_64 *)header, _dyld_get_image_vmaddr_slide(i), machO));
  }
}

__attribute__((constructor)) static void pwvision_init(void)
{
  const char *path = getenv("VISION_DUMP_OUT");
  if (path && *path)
    gDump = fopen(path, "w");
  if (!gDump)
    return;

  realUpdateBuffer = (UpdateBufferFn)resolve("__ZN6Retina12updateBufferEssss");
  realAttachedGet = (AttachedGetFn)resolve("__ZN17AgentAttachedData3getEP5agentj");

  fprintf(stderr, "pwvision: dump=%s updateBuffer=%p attachedGet=%p\n", path,
          (void *)realUpdateBuffer, (void *)realAttachedGet);
  if (!realUpdateBuffer || !realAttachedGet)
  {
    pwvision_diag("__ZN6Retina12updateBufferEssss");
    fprintf(stderr, "pwvision: could not resolve the originals -- the shim will abort on first use\n");
    fflush(stderr);
  }
}

__attribute__((destructor)) static void pwvision_fini(void)
{
  if (gDump)
  {
    fprintf(stderr,
            "pwvision: %ld rows (%ld without an agent), %ld attachedGet, %ld updateBuffer, %d retinas\n",
            gRows, gAgentRows, gAttachedGets, gUpdateBufferCalls, gRetinaCount);
    fclose(gDump);
    gDump = NULL;
  }
}
