# Vision / retina spec (lane W1j)

Status: extracted from native source; **rev 2**. No port code in this lane — `docs/specs/vision-spec.md`
is the only file this lane writes.
Native root: `polyworld` (referred to below as `native/`), read-only,
at commit `99debe8c40fd9f8e58eaae49bb86a68fd1af3703` ("Add data files via upload", 2025-09-21).
Evidence: the recorded goldens under `oracle/**` (read-only) plus an executable reference encoder
(§11.5, §13).

Every value that reaches the brain as a *vision* input is pinned here with a line reference and,
where it is a float/double computation, with the exact rounding discipline needed to reproduce it.

**Rev 2 changes** (rev 1 was produced by an earlier attempt of this same lane and is superseded):
* line references corrected where they were wrong: `Brain.cc` retina-width/height lines,
  `Simulation.cc` `MaxAgents`, `Normalized.wf` `GrayCoding`, ground `y` (see §2, §5.5);
* the FMA open question (PN-V7) is **resolved** into a portable rule with golden evidence (§7, §12);
* **the integer pooling branch is exercised by the recorded oracle** — measured, not assumed (§7.2);
* retina colour provenance pinned, including the uniform-grey source (§6);
* §11.4/§11.5 add the acceptance fingerprint L16 must reproduce, and an encoder that passes it;
* one PARITY.md row is proposed for **correction** (its stated rationale is stale, §13.4).

---

## 1. Pipeline: what happens, in what order

Per simulation step, vision runs inside the agent loop (`native/src/library/sim/Simulation.cc:659-674`):

```
agentPovRenderer->beginStep();                                       // :661
if (fStaticTimestepGeometry) UpdateAgents_StaticTimestepGeometry();  // :663-665
   -> fStage.Compile();                                              // :1407  (before any POV render)
   -> for each agent in objectxsortedlist::gXSortedObjects order:    // :1408-1411
        a->UpdateVision();                                           // :1416  render + glReadPixels
        postParallel( a->UpdateBrain() );                            // :1418-1423 encode + net update
   -> fStage.Decompile();                                            // :1426
else UpdateAgents();                                                 // :669
agentPovRenderer->endStep();                                         // :673
```

`minitest.wf` sets `StaticTimestepGeometry True` (`oracle/minitest_von/run/normalized.wf:368`), so the
compile path is the one that runs for the vision oracle. Consequences the port must keep:

* **PN-V1 — one geometry snapshot per step.** Every agent's retina in a step sees the geometry as it was
  when `fStage.Compile()` ran; nothing moves between compile and the vision loop (bodies update later,
  in `Interact()`). The port may render one scene snapshot per step and reuse it for every agent.
* **PN-V2 — the POV pass re-uses the world display list.** `gstage::Compile()` (`gstage.cc:118-135`)
  records `gstage::Draw()` into a display list with `GL_COMPILE` (`:128`, `:130`, `glEndList :132`);
  `QtAgentPovRenderer::render()` calls `a->GetScene().Draw()` (`QtAgentPovRenderer.cc:149`) →
  `gscene::Draw()` (`gscene.cc:113-129`) → `fStage->Draw()` → `glCallList(fDisplayList)`
  (`gstage.cc:153-156`). Vertex values and every `glTranslatef/glRotatef/glScalef` *argument* are baked
  at compile time; only the matrix present at `glCallList` time is the agent's own view/projection.
  `Decompile()` deletes the list every step (`gstage.cc:141-145`, called at `Simulation.cc:1426`).
* **PN-V3 — `StaticTimestepGeometry` also switches the nervous-system RNG to MT19937.**
  `Simulation.cc:3862-3868`: when true, `RandomNumberGenerator::set(NERVOUS_SYSTEM, LOCAL)`. This changes
  the prebirth retina noise source (§9) — not optional.

Per-agent order inside `UpdateVision` (`agent.cc:1065-1093`): focus → frustum (dead, §5.4) → aspect →
optional pitch (`:1077-1081`) → optional yaw (`:1083-1087`) → `render()` (`:1089`) → readback. The retina
buffer is encoded into nerves in `UpdateBrain()` → `fCns->update(false)` (`NervousSystem.cc:45-57`) →
`Retina::sensor_update()`.

---

## 2. Config values that matter (pinned for minitest_von)

| Value | Setting | Source of the runtime value |
|---|---|---|
| `Vision` | `True` | `normalized.wf:450`; read `agent.cc:75` |
| `RetinaWidth` (`Brain::config.minWin`) | `22` | `normalized.wf:374`; **`Brain.cc:118`** |
| `RetinaHeight` | `= minWin` → `22` | `normalized.wf:375`; **`Brain.cc:134-137`** (evened) |
| (derived) `Brain::config.retinaWidth` | `max(minWin, MaxVisionNeuronsPerGroup)` → `22` | **`Brain.cc:129`**, evened `:131-132` |
| `VerticalFieldOfView` (`agentFOV`) | `10.0` | `normalized.wf:208`; `agent.cc:110` |
| `MinHorizontalFieldOfView` (`minFocus`) | `20.0` | `normalized.wf:206`; `agent.cc:108` |
| `MaxHorizontalFieldOfView` (`maxFocus`) | `140.0` | `normalized.wf:207`; `agent.cc:109` |
| `InvertFocus` | `False` | `normalized.wf:160`; `agent.cc:193` |
| `EnableVisionPitch` | `False` (range −7.5..7.5 if on) | `normalized.wf:161-163`; `agent.cc:1077-1081` |
| `EnableVisionYaw` | `False` (range −90..90 if on) | `normalized.wf:164-166`; `agent.cc:1083-1087` |
| `EyeHeight` | `0.5` | `normalized.wf:167`; `agent.cc:82` |
| `AgentHeight` | `0.2` | `normalized.wf:376`; `agent.cc:74` |
| `FogFunction` | `O` (off) | `normalized.wf:219`; `Simulation.cc:4559` |
| `WorldSize` | `25` | `normalized.wf:466` |
| `MaxAgents` (=`fMaxNumAgents`) | `25` | `normalized.wf:458`; **`Simulation.cc:3874`** |
| `PreBirthCycles` | `25` | `normalized.wf:176`; `Brain.cc:101` |
| `Min/MaxVisionNeuronsPerGroup` | 1 / 16 | `normalized.wf:239-240`; `GroupsBrain.cc:43-44` |
| `GrayCoding` | `False` | **`normalized.wf:401`** — see §10 |
| `BodyRedChannel` / `BodyGreenChannel` / `BodyBlueChannel` | `Fight` / `I` / `Mate` | `normalized.wf:168-170`; `agent.cc:113`, `:125`, `:141` |
| `NoseColor` | `L` (light) | `normalized.wf:171`; `agent.cc:153` |
| `GroundColor` | (0.1, 0.15, 0.05) | `normalized.wf:395-399`; `Simulation.cc:4010` |
| `GroundClearance` | `0.0` | `normalized.wf:400`; `Simulation.cc:4011` |
| `FoodColor` / `FoodHeight` | (0.2,0.6,0.2) / 0.6 | `normalized.wf:377-382` |
| `BrickColor` / `BrickHeight` | (0.6,0.2,0.2) / 0.5 | `normalized.wf:383-388` |
| `BarrierColor` / `BarrierHeight` | (0.35,0.25,0.15) / 5.0 | `normalized.wf:389-394` |

`maxvisneurpergroup` enters the retina width itself: `retinaWidth = max(minWin, maxvisneurpergroup)`
(`Brain.cc:129`), then bumped to even (`:131-132`). Here `max(22,16)=22`.
`Brain::config.retinaWidth` is also the constructor argument of every retina (§3), so it is the *only*
width the encoder ever sees.

---

## 3. The retina buffer and the readback

* Buffer: `buf = calloc(width*4)` — `retinaWidth` pixels × RGBA bytes, **1-D, no height**
  (`Retina.cc:22-31`). `width` = `Brain::config.retinaWidth` (`agent.cc:570`).
* Readback (`Retina.cc:108-146`) — the whole pixel source for vision:

```c++
glReadPixels(x, y + height/2, width, 1, GL_RGBA, GL_UNSIGNED_BYTE, buf);   // :116-122
```

  with `(x, y, width, height)` = the agent's viewport (`QtAgentPovRenderer.cc:145`, `:153`).

  So **the retina is one horizontal row of `retinaWidth` pixels, taken from the row
  `y + retinaHeight/2` of the agent's square viewport** — the row immediately *above* the viewport's
  vertical centre line (`height=22` → `y+11`). Only RGB (bytes 0,1,2 of each pixel) are ever consumed;
  alpha is read but never used (`Channel::update` indexes `pixel*4 + index`, `index ∈ {0,1,2}`,
  `Retina.cc:196`, `:216`, `:225`, `:234`).
* GL semantics: `glReadPixels` origin is the framebuffer's lower-left; the row returns left→right, RGBA,
  8-bit unsigned normalized — the *quantized* framebuffer bytes, i.e. `round(255*clamp(c,0,1))`
  (golden-side evidence: §11.4).
* Background = the atlas clear: `glClearColor(0,0,0,1)` + `glClear(COLOR|DEPTH)` once per step
  (`QtAgentPovRenderer.cc:129-130`). Cleared alpha is 1; every object is drawn with `glColor3fv`
  (`gpolygon.cc:106`, `:205`) so alpha is 1 anyway.

---

## 4. Viewport packing (the atlas)

`QtAgentPovRenderer` ctor (`QtAgentPovRenderer.cc:28-68`), `CELL_PAD 2` (`:13`):

```
n = 10, a = 3                                                   // :39-40
i      = (int)(sqrt((float)(maxAgents*a)) + n - 1) / n           // :41 int division after cast
ncols  = i * n                                                   // :42
nrows  = (maxAgents + ncols - 1) / ncols                         // :43
fBufferWidth  = ncols * (retinaWidth  + CELL_PAD)                // :44
fBufferHeight = nrows * (retinaHeight + CELL_PAD)                // :45
```

For `maxAgents=25, retinaWidth=retinaHeight=22`: `i = (int)(8.660254+9)/10 = 17/10 = 1`, `ncols = 10`,
`nrows = 3` → **atlas 240 × 72 px** (10 cols × 24, 3 rows × 24; 2 px padding per side of each cell).

Per viewport index `i` (`:50-67`):

```
irow = i / ncols ; icol = i - ncols*irow                    // :56-57
width = 22 ; height = 22                                    // :59-60
x     = icol*(22+2) + 2                                     // :62   -> 2, 26, 50, ... 218
ytop  = 72 - irow*24 - 2 - 1                                // :63   -> 69, 45, 21
y     = ytop - 22 + 1                                       // :64   -> 48, 24,  0
readback row = y + 11                                       // Retina.cc:117 -> 59, 35, 11
```

Slots are handed out lowest-free-index-first from `fFreeViewports` (insert `:66`, take `:86-87`, return
`:95-104`), so which slot an agent occupies depends on allocation history. **This cannot affect any brain
input**: cells are disjoint, each `render()` sets its own `glViewport` (`:145`) and its own projection
(`gcamera.cc:121-126` via `gscene.cc:113-129`), and the depth buffer is cleared once for the whole atlas
before the per-agent draws (`:129-130`). Agent order and slot assignment are therefore value-neutral —
batching in any order is safe.

Setup done once, on the first `beginStep()` (`:111-123`): create the FBO
(`PwOffscreenGLSurface`), `makeCurrent`, `glEnable(GL_DEPTH_TEST)` (`:116`), `glEnable(GL_NORMALIZE)`
(`:117`), reset MODELVIEW + PROJECTION to identity (`:119-122`). `PwOffscreenGLSurface.cc:13-51` requests
a **GL 2.1 compatibility context, depth 24, stencil 8, default (single-sample) FBO** — no MSAA, so pixel
coverage is plain point-sampled rasterization. Nothing in the model path enables fog, lighting, blending
or dither controls.

---

## 5. Camera maths

### 5.1 Per-agent camera setup (once, at grow/load)

`agent::SetGraphics()` — `agent.cc:1019-1034`, called from `agent.cc:488` and `:754`:

```
fovx = FieldOfView()                                                          // :1022, see 5.2
fCamera.SetAspect(fovx * Brain::config.retinaHeight / (agentFOV * retinaWidth)) // :1024
fCamera.settranslation(0.0, (eyeHeight - 0.5)*agentHeight, -0.5*fLengthZ)      // :1025
fCamera.SetNear(.01)                                                           // :1026
fCamera.SetFar(1.5 * globals::worldsize)                                       // :1027  = 37.5
fCamera.SetFOV(agentFOV)                                                       // :1028  = 10.0 (vertical)
if (glFogFunction() != 'O') fCamera.SetFog(...)                                // :1030-1031
fCamera.AttachTo(this)                                                         // :1033
```

* `fLengthZ = Size() * sqrt(geneCache.maxSpeed)` (`agent.cc:1000`); geometry scaling at `:1002-1011`
  (`x *= fLengthX`, `y *= agentHeight`, `z *= fLengthZ`), `setlen()` at `:1011`.
  With `EyeHeight 0.5` the camera's y term is exactly `0.0`: the eye sits at the agent's own y
  (`0.5*agentHeight = 0.1` at spawn, `Simulation.cc:883`) and **exactly at the nose plane**
  `z = -0.5*fLengthZ`. Nose polygons are polygons 0-4, drawn by `agent::draw()`
  (`agent.cc:1819-1831`: `position(); glScalef(fScale,fScale,fScale); drawcolpolyrange(0,4,fNoseColor)
  ... drawcolpolyrange(5,9,fColor)`), i.e. the z=-0.5 face of `etc/objects/agent.obj`. The agent's own
  body is therefore at/behind the eye plane and is **never in its own retina** (near plane 0.01).
* `SetFog` uses the clear colour as fog colour and `GL_FOG_START = fNear` for linear fog
  (`gcamera.cc:331-363`). Fog is global and never disabled by `camera->Use()`; with `FogFunction O` it is
  never enabled.

### 5.2 Focus → horizontal FOV, and the aspect

`agent::FieldOfView()` — `agent.cc:1899-1904`, duplicated inline at `:1070-1072`:

```
invertFocus ? focus*(minFocus - maxFocus) + maxFocus
            : focus*(maxFocus - minFocus) + minFocus        // InvertFocus False
```

`focus = outputNerves.focus->get()` (`agent.cc:553`), the `Focus` output nerve, range
`[minFocus,maxFocus] = [20,140]` degrees.

`SetAspect(fovx * retinaHeight / (agentFOV * retinaWidth))` = `fovx * 22 / (10 * 22)` = `fovx/10`.
Note the expression is a **float** expression (`gcamera::SetAspect(float,float)` stores `fAspect` as
float, `gcamera.cc:94-98`), so the port must round it to f32 at the same point.

`UpdateVision()` recomputes the same aspect every step (`agent.cc:1075`) — identical to
`SetGraphics`, so it is redundant, but it must be applied in the same order relative to pitch/yaw.

`gluPerspective(fFOV=10.0, fAspect=fovx/10, fNear=0.01, fFar=37.5)` (`gcamera.cc:121-126`). The
*vertical* FOV is exactly 10°; the horizontal FOV is `2*atan((fovx/10)*tan(5°))`, which is **less than**
the focus `fovx` (101.6° at fovx=140).

### 5.3 Pitch / yaw (off in minitest, spec'd for other worlds)

`agent.cc:1077-1087`:

```
pitch = visionPitch->get()*(maxVisionPitch - minVisionPitch) + minVisionPitch   // [-7.5,7.5]°
yaw   = visionYaw  ->get()*(maxVisionYaw   - minVisionYaw  ) + minVisionYaw     // [-90,90]°
fCamera.setpitch(pitch);   // fAngle[1]                                  (gobject.cc:165-169, :150-154)
fCamera.setyaw(yaw);       // fAngle[0]
```

Both write the *camera's* angles (cameras inherit `gobject::fAngle`), i.e. relative to the agent's body:
the camera transform is composed with the agent's inverse transform (§5.4).

### 5.4 The exact modelview matrix

`gcamera::Use()` — `gcamera.cc:271-294` (camera not fixed, not LookAt):

```
glLoadIdentity();
glRotatef(-fAngle[2], 0,0,1);   // roll  (always 0 for agents)
glRotatef(-fAngle[1], 1,0,0);   // pitch (vision pitch)
glRotatef(-fAngle[0], 0,1,0);   // yaw   (vision yaw)
glTranslatef(-fPosition[0], -fPosition[1], -fPosition[2]);   // = -(0, 0, -0.5*fLengthZ)
if (fFollowObject) fFollowObject->inverseposition();         // gobject.cc:301-305
```

with `gobject::inverseposition() = inverserotate(); inversetranslate();` and `inverserotate()` applying
`-angle[2]`/z, `-angle[1]`/x, `-angle[0]`/y (`gobject.cc:284-305`). GL post-multiplies, so in
column-vector convention:

```
M_view = Rz(-roll)·Rx(-pitch)·Ry(-yaw)·T(-campos)·Rz(-a2)·Rx(-a1)·Ry(-a0)·T(-agentpos)
```

where `a0,a1,a2` are the agent's own yaw/pitch/roll in **degrees** (`fAngle[0]` written by
`setyaw(outputNerves.yaw->get() * 360.0)`, `agent.cc:1159`). Reading it as a sequence of point
transforms: world → translate to the agent's origin → `R_agent⁻¹` (agent-local, unrotated frame) →
subtract the camera's local offset `(0,0,-0.5*fLengthZ)` → rotate by the camera's own
(-yaw,-pitch,-roll). The camera's local **−Z is the agent's visual forward**, confirmed by the nose
geometry (§5.1) and by the frustum convention (`gmisc.cc:335`: `atan2(x0-px, z0-pz) = 0` means "+Z from
object to agent", i.e. the agent sees −Z at yaw 0).

**PN-V4 — `frustumXZ fFrustum` is dead.** `agent.cc:1074` sets it; `GetFrustum()` is declared
`agent.h:251`, inlined `agent.h:443`, and never called anywhere in the tree. The retina path does not cull:
`gstage::Draw()` (`gstage.cc:151-177`) draws set+prop+cast with no `frustumXZ` argument, and the culling
variant `Draw(const frustumXZ&)` (`:183-204`, where the set list is still drawn unculled, `:194-195`) is
only reachable via `gscene::Draw(fxz)` (`gscene.cc:136-152`), which the POV renderer never calls. Do not
port frustum culling into the vision lane; the native POV draws every object in the world list every step
(performance, not semantics).

### 5.5 The readback row is the horizon band

The viewport is 22 px tall, so the vertical centre line is at v = 11.0 in viewport coordinates and the
readback row is `[11,12)`, i.e. strictly *above* the optical axis. With the camera pitch at 0 (minitest:
pitch/yaw disabled) the optical axis is horizontal, so every pixel in the sampled row has elevation
`0° … atan((1/11)·tan 5°) = 0.4557°` above the eye (row centre 0.2278°). Three consequences:

1. **The ground plane can never appear in a retina.** `fGround` is `sety(-fGroundClearance)` = `y = 0`
   (`Simulation.cc:824`, `:820-828`), strictly below the eye (`y = 0.1`), so it projects strictly below
   v = 11 and cannot cover a pixel of the sampled row. Corroborating golden evidence: the ground's unique
   bytes are 26/38/13 (`round(255·GroundColor)`), and `0.101961` (26/255) and `0.0509804` (13/255) never
   appear in `brainFunction_10`; 3717 of its 4995 vision samples are exactly `0`.
   *Relies on the agent's y never dropping below 0.1 — that is L8's to confirm (open question §14.3).*
2. Only objects crossing eye level within range appear: barriers (5.0 tall) out to ~616 world units,
   food boxes (0.6) and agents (0.2) within a few units — exactly what the golden shows (§11.4).
3. The retina is a **1-D horizontal scan across the horizon**, up to 140° wide, sampled at 22 pixels —
   not a general image. `movie.pmv` aside, this is the only "picture" the model has.

---

## 6. What is drawn (scene composition)

Render entry, `QtAgentPovRenderer::render()` (`:136-154`):

```
glMatrixMode(GL_PROJECTION); glLoadIdentity();                 // :141-142
glViewport(viewport->x, viewport->y, width, height);           // :145
glPushMatrix(); a->GetScene().Draw(); glPopMatrix();            // :148-150
a->GetRetina()->updateBuffer(viewport->x, viewport->y, w, h);  // :153
```

`gscene::Draw()` (`gscene.cc:113-129`) → `fCamera->Use()` (projection + modelview, §5.1/5.4) →
`fStage->SetCurrentCamera/SetDrawLights` → `gstage::Draw()` → the compiled display list.

GL state that shapes the pixels: depth test on, `GL_NORMALIZE` on, **no lighting**
(`gStage.SetLightModel()` is never called anywhere in the tree — `gstage.h:35` — and no
`glEnable(GL_LIGHTING)` exists in the model path), no blending, no AA, `glShadeModel` at its default
(irrelevant: each polygon is drawn with a single `glColor3fv`, `gpolygon.cc:205-210`, so fills are flat),
fog only if `FogFunction != 'O'`.

Objects, by list (all in `TSimulation::fStage`):

| List | Contents | Draw path |
|---|---|---|
| set (`fWorldSet`, `Simulation.cc:426`) | ground (`InitGround`, `:820-828`), barriers (`InitBarriers`, `:1038-1045`) | `TGraphicObjectList::Draw()` `gmisc.cc:88-98` — **not** frustum-culled (`gstage.cc:194-203`) |
| cast (`fWorldCast`, `Simulation.cc:365`) | agents (`:879`, `:958`, `:2019`, `:2274`, `:3043`, `:3136`), food items (`FoodPatch.cc:126`), bricks (`BrickPatch.cc:78`) | `TGraphicObjectList::Draw()` `gmisc.cc:88-98`, same, no culling |
| props | **never populated** — `SetProps` is not called anywhere | — |
| lights | never (no light model, `fDrawLights` false) | — |

Primitives: objects are polygon soups drawn with `glBegin(GL_POLYGON)` per polygon
(`gpolygon.cc:203-218`) after `position(); glScalef(...)` (`gpolyobj::draw` `:221-228`, `agent::draw`
`agent.cc:1819-1831`); barriers add a `GL_LINES` top edge (`environment/barrier.cc:69-77`, `glBegin`
at `:73`) whose zero-width coverage of the sampled row is negligible (verify, don't assume).
Geometry sources: `Resources::loadPolygons(&fGround,"ground")` (`Simulation.cc:822`),
`Resources::loadPolygons(agent::agentobj,"agent")` (`agent.cc:322`), food/brick polygon sets
(`environment/food.cc`, `brick.cc:121`). Geometry ownership is L15/L10; this spec pins the camera, list
membership, GL state and quantized colours.

**Colours that reach the framebuffer** (floats from the worldfile; the readback quantizes to 8 bits):

| Object | float colour | bytes `round(255·c)` |
|---|---|---|
| sky (clear) | 0, 0, 0 | 0, 0, 0 |
| ground | 0.10, 0.15, 0.05 | 26, 38, 13 |
| barrier | 0.35, 0.25, 0.15 | 89, 64, 38 |
| food | 0.20, 0.60, 0.20 | 51, 153, 51 |
| brick | 0.60, 0.20, 0.20 | 153, 51, 51 |
| agent **body** | `fColor` = (Fight nerve, genome `ID`, Mate nerve) — `BodyRedChannel Fight` / `BodyGreenChannel I` / `BodyBlueChannel Mate` (`normalized.wf:168-170`); init `agent.cc:604-654`, per-step `UpdateColor()` `:1484-1521` | continuous, per agent per step |
| agent **nose** (polygons 0-4) | `fNoseColor`, set to `(light, light, light)` — **uniform grey** — `NoseColor L` (`normalized.wf:171`), `agent.cc:1517-1519` | continuous, grey |

**PN-V12 — uniform grey retina rows are the neighbour's *nose*, not its body.** The nose colour is the
single nerve `light` written to all three channels (`agent.cc:1517-1519`), so a nose at close range
produces a row whose R, G and B encodings are *bit-identical*. That is exactly what the golden shows:
`brainFunction_10` has `0.505882` (=129/255) 330 times, `0.501961` (=128/255) 23 times and `1` (=255/255)
23 times (uniform grey triples), plus body colours like `0.176471`/`0.172549` (=45/255, 44/255 — adjacent
bytes, i.e. a continuous agent colour) in `brainFunction_31`. A *body* could only be grey by the
coincidence `Fight = ID = Mate` to 6 digits. Note the coupling this implies: an agent's `Light` output
nerve is visible to its neighbours through the retina, so agent colours are `Vision True` behavior too.

---

## 7. Vision encoding into the brain (the exact arithmetic)

`Retina::sensor_grow()` binds three channels to the nerves named `"Red"`, `"Green"`, `"Blue"`
(`Retina.cc:38-43`); `Channel::init` (`:153-178`) caches:

```
numneurons = nerve->getNeuronCount()                 // :164   (per agent, see §7.2)
xwidth     = float(width) / numneurons               // :170   float division
xintwidth  = width / numneurons                      // :171   integer division
if (xintwidth * numneurons != width) xintwidth = 0;  // :173-176  exact-division flag
```

`sensor_update` (`:55-90`) calls the three channels in order 0,1,2; `numneurons == 0` returns early
(`:182-183`), leaving that channel's (empty) nerve untouched. `SlowVision`/`TauVision` (`:18-19`) are
compile-time off (`#if SlowVision`, `:241`).

### 7.1 Integer branch (`xintwidth != 0`) — `Retina.cc:189-200`

```
pixel = 0;
for i in 0..numneurons-1:
    avgcolor = 0.0;                                  // :194 reset EVERY neuron
    for ipix in 0..xintwidth-1: avgcolor += buf[(pixel++)*4 + index];   // :195-196 float adds
    nerve->set( i, avgcolor / (xwidth * 255.0) );    // :198 double division
```

### 7.2 Fractional branch (`xintwidth == 0`) — `Retina.cc:201-239`, the byte-exact path

```c++
pixel = 0; avgcolor = 0.0;                          // :203-204  OUTSIDE the neuron loop
for (int i = 0; i < numneurons; i++) {
    endpixloc = xwidth * float(i+1);                                  // :210  float
    while (float(pixel) < (endpixloc - 1.0))                          // :214  DOUBLE compare
        avgcolor += buf[((pixel++) * 4) + index];                     // :216  float add
    avgcolor += (endpixloc - float(pixel)) * buf[(pixel*4)+index];    // :225
    nerve->set(i, avgcolor / (xwidth * 255.0));                       // :226  DOUBLE divide
    avgcolor = (1.0 - (endpixloc - float(pixel))) * buf[(pixel*4)+index];  // :234 carry
    pixel++;                                                          // :237
}
```

Measured branch usage in the recorded scenarios (from the `redinput=/greeninput=/blueinput=` ranges in
`oracle/*/run/brain/anatomy/*_incept.*` and the function-log headers): 108 agents, 324 channels; neuron
counts per channel are **9 (269×), 1 (16×), 10 (15×), 12 (9×), 11 (9×), 3 (4×), 2 (1×), 14 (1×)**.
`xintwidth = 22/n; xintwidth*n == 22` only for `n ∈ {1,2,11,22}` → **21 of the 108 agents have at least
one channel on the integer branch** (e.g. `brainFunction_31`: red 1 neuron → `xintwidth=22`, blue 11 →
`xintwidth=2`; `brainFunction_27/32/33/35/38/48`: blue 1 neuron). Both branches are therefore part of the
acceptance surface — a port that only implements §7.2 fails the oracle.

Traps, each of which changes the fed value if mis-ported:

* **PN-V5 — `avgcolor` is not reset per neuron in the fractional branch.** `:234` overwrites it with
  `(1-(endpixloc-pixel))·buf[pixel]`, and that value is the starting accumulator of the next neuron at
  `:225`. It is a carry, not dead code. (`:204` resets it once.)
* **PN-V6 — mixed float/double.** `endpixloc` is `float`; the `- 1.0` comparison is **double**; the
  accumulation at `:216`/`:225` is float; the final `avgcolor / (xwidth * 255.0)` is a **double** division
  whose result is stored in the nerve's `double` activation (`Nerve.h:37-39`, `Nerve::set(int,double)`).
  Required JS discipline: `endpixloc = f32(xwidth*(i+1))`; compare in f64 (`< endpixloc - 1.0`);
  `avg = f32(avg + buf[k])`; the final value is exactly `f64(avg) / (f64(xwidth)*255.0)` with no f32
  rounding.
* **PN-V7 (resolved) — `:225` must be a *single* rounding.** `avgcolor += (endpixloc - float(pixel)) *
  buf[...]` is one multiply-add, and the native arm64 build (`-O2`, clang defaults, no `-ffp-contract`
  override) contracts it: the exact product is added to `avgcolor` and rounded **once** into the float.
  Golden evidence: in the 27 steps where an agent's whole retina is the barrier's uniform bytes
  (89/64/38), all 27 printed vision values are `0.34902/0.25098/0.14902`; the *two-rounding* port
  (`f32(f32(t*b) + avg)`) prints **`0.349019`** for red neuron index 5 — a value that never occurs in any
  golden (`brainFunction_10` has 112 distinct values, and `0.349019` is not one). **Porting rule:
  `avg = f32(t*b + avg)`, i.e. `Math.fround(t * byte + avg)` in JS, where the f64 product is exact (both
  operands are f32) and `avg` is f32 — this equals the exactly-rounded fused result (verified, §11.5).
  Do not write `Math.fround(Math.fround(t * byte) + avg)`.**
* **PN-V8 — out-of-range `buf` reads.** When `xwidth < 1` (more neurons than pixels, i.e. `numneurons >
  22`) the while-loop and `buf[pixel*4+index]` read past `width*4`. Native reads adjacent heap; the port
  must not crash. **Not exercised by the oracle** (largest observed channel is 14 neurons), so guard it
  (throw or clamp deterministically) rather than emulating heap garbage.

---

## 8. What reaches the brain (the contract)

For each agent, per step, the vision contribution to the brain is exactly **3 × numneurons doubles**,
written as nerve activations by `nerve->set(i, value)`:

| Nerve | minitest_von indices | count | value |
|---|---|---|---|
| `Red` | 2-10 | 9 | `avgcolor_red / (xwidth*255.0)` |
| `Green` | 11-19 | 9 | `avgcolor_green / (xwidth*255.0)` |
| `Blue` | 20-28 | 9 | `avgcolor_blue / (xwidth*255.0)` |

Index ranges are the nerve creation order in `agent::grow()` (`agent.cc:523-538`: `Random`, `Energy`,
then the optional input nerves, then `Red`/`Green`/`Blue`), confirmed by the recorded anatomy header
`brain 10 fitness=0 numneurons+1=38 maxWeight=8 maxBias=8 redinput=2-10 greeninput=11-19 blueinput=20-28`
(`oracle/minitest_von/run/brain/anatomy/brainAnatomy_10_incept.txt.gz:1`) and by
`Retina::Channel::start_functional/dump_anatomical` (`Retina.cc:253-268`). The per-agent counts are
**not** fixed at 9 (§7.2) — read them from the nerve, as `Channel::init` does.

Scalars feeding the camera, read *before* the brain update of the same step (`agent.cc:1070-1087`, and at
grow/load `:1022-1028`): `Focus` (→ horizontal FOV 20..140°), `VisionPitch` (−7.5..7.5°), `VisionYaw`
(−90..90°). `Yaw` (`* 360.0`, `agent.cc:1159`) feeds the agent transform the camera inverts — the vision
lane does not own it but is bit-sensitive to it (L8).

Recording format: `BaseNeuronModel::writeFunctional` → `file->printf("%d %g\n", i, activation[i])`
(`BaseNeuronModel.h:242-248`) — `%g` = 6 significant digits, so the goldens are ~6-digit checkpoints,
not bit-exact ones. Header: `Brain::startFunctional` (`Brain.cc:183-200`) writes `version 1` /
`brainFunction <agent> <numNeurons> <numInputNeurons> <numOutputNeurons> <numSynapses> <stepBorn>
<sensor ranges…>` (`BaseNeuronModel.h:236-240`, `NervousSystem.cc:147-157`), e.g.
`brainFunction 10 37 29 8 74 0 2-10 11-19 20-28`.

---

## 9. Prebirth: where the retina gets its first activations

`agent::grow()` → `fCns->prebirth()` (`agent.cc:597`) → `Brain::prebirth()` (`Brain.cc:266-278`):
`for i in 0..PreBirthCycles-1 { _cns->prebirthSignal(); update(false); }`.

`Retina::sensor_prebirth_signal` (`Retina.cc:45-53`):

```
for i in 0..width*4-1: buf[i] = (unsigned char)(rng->range(0.0, 255.0));   // 88 draws
sensor_update(false);       // encodes the noise -> Red/Green/Blue nerves
```

* No rendering happens at prebirth (this is `grow()`, outside the step loop): the first retina
  activations are noise, then they are re-encoded once more by the `update(false)` inside
  `Brain::prebirth` (idempotent — same buffer, same values).
* `rng` is the **NervousSystem** stream (`NervousSystem.cc:18`; `NervousSystem::prebirthSignal`
  `:135-145`). For minitest_von it is **MT19937 (LOCAL)**, not `drand48`, because
  `StaticTimestepGeometry True` (`Simulation.cc:3862-3868`), seeded per agent with
  `c->fCns->getRNG()->seedIfLocal(agent::agentsEver)` (`agent.cc:353`) → `gsl_rng_set(mt19937, agentsEver)`.
* Sensor order fixes the shared-stream order: the Retina is added **first** (`agent.cc:570`), before
  EnergySensor, RandomSensor and the optional ones (`:571-583`); `NervousSystem::prebirthSignal`
  walks that vector in order, so the retina consumes the first 88 draws of every prebirth cycle
  (25 cycles → 2 200 draws per agent) before any other sensor on that stream.
* `range(lo,hi) = interp(drand(), lo, hi)` (`RandomNumberGenerator.cc:128-134`); `drand()` →
  `gsl_rng_uniform` for LOCAL (`:102-113`); `(unsigned char)` truncates.
* `Retina::sensor_prebirth_signal` needs `rng->range` only if the Retina is registered — it is, always
  (`agent.cc:570`), independent of `Vision`. With `Vision False` the step loop simply never calls
  `UpdateVision()` (`agent.cc:1067`), so the retina keeps re-encoding the same prebirth noise forever —
  which is why vision-off runs are pure arithmetic.

---

## 10. GrayCoding is not a vision concern (de-scoping, with refs)

`GrayCoding` (`normalized.wf:401`, read at `GenomeSchema.cc:85`, field `GenomeSchema.h:59`) is the
**genome byte** encoding: `Genome::gray` (`Genome.cc:38`) selects `binofgray[]` decoding in
`Genome::get_raw()` (`Genome.h:112-121`), `updateSum()` (`Genome.cc:70-99`) and the
symmetric-difference/genetic-distance paths (`Genome.cc:388-422`). It changes which *gene* values a
genome byte decodes to — hence brain anatomy (per-channel `numneurons`, weights) and thus `xwidth` (§7)
and the anatomy/function logs. It touches no pixel, no camera parameter and no part of the encoding
formula. Vision-lane dependency: **L5/L6 must decode genes with the same gray semantics** or the channel
neuron counts (and every pooling boundary) shift. `GrayCoding False` in the oracle scenario.

---

## 11. Browser implementation proposal (batched single-readback WebGL2)

Frozen requirement (§8 + PARITY.md's vision finding): the *model logs* must stay byte-exact; retina
pixels are a debugging aid. Native is reproducible on this machine, so "close enough" is not the goal —
the fed doubles are.

### 11.1 Shape of the port

1. **One atlas FBO per simulation**, exactly the native packing (§4): 240×72 RGBA8 +
   `DEPTH_COMPONENT24`, single-sample (`PwOffscreenGLSurface` has no MSAA; the WebGL2 default FBO is
   single-sample, matching), `clearColor(0,0,0,1)` + `clear` once per step. The four GL state calls
   native made **once** (`glEnable(GL_DEPTH_TEST)`, `GL_LESS`, no blend, no cull — `:111-123`) are
   re-armed on **every** step here: native's arming was safe because it lived in a private
   `QOpenGLContext`, while the browser context is the shell's, so no caller can be relied on to leave
   those four alone (PORT-NOTE `vision/raster-gl-state-armed-once`; PARITY.md L16 finding 5,
   `t_3dcd248c`).
2. **One scene snapshot per step** (PN-V1): build the per-step vertex buffers (ground, barriers, food,
   bricks, agents — using the same `position()/rotate()/scale()` transform order as `gpolyobj::draw`
   (`gpolygon.cc:221-228`), `agent::draw` (`agent.cc:1819-1831`) and the barrier/food/brick draw
   methods) *before* the agent loop, then draw them once per agent viewport with only the camera and
   viewport changing.
3. **Per-agent pass**: `gl.viewport(x,y,22,22)` + the agent's projection/modelview from §5, then one
   `drawElements` of the whole snapshot (no culling — PN-V4), exactly as the native display list does.
   Snapshot order must be the native list order (set list then cast list, `gmisc.cc:88-98`,
   `gstage.cc:168-176`) so depth-test ties (`GL_LESS`, depth test on) resolve identically.
4. **Readback — batched single read (recommended)**: after all agents are drawn, one
   `gl.readPixels(0,0,240,72, RGBA, UNSIGNED_BYTE, u8)` (69 KB) and slice each agent's row in JS. Native
   instead does one `glReadPixels` per agent (`Retina.cc:116`); the values are identical, the stalls are
   not (native: 64 % of wall at 192 agents, PORT_PLAN.md measured fact 6). `readPixels` keeps GL's
   lower-left origin, so the addressing below applies unchanged.

   Addressing of the batched buffer (`W = 240` px, `H = 72`):
   ```
   row (from bottom, 0-based) r = viewport.y + retinaHeight/2 = y + 11      // §4
   byte offset of the agent's row = ((r * W) + viewport.x) * 4
   agent's 88-byte row            = u8.subarray(offset, offset + 22*4)
   ```
   i.e. for slot rows `irow = 0,1,2`: `r = 59, 35, 11` and `x = 2 + icol*24` (§4 worked example).
5. **Encode on the CPU, in JS, with §7's discipline.** Do *not* shader the pooling unless the arithmetic
   is proven identical: the fractional accumulator's carry (PN-V5), the float/double split (PN-V6) and
   the single-rounding multiply-add (PN-V7) are 1-ulp behaviours a naive `mix()`-based fragment shader
   will not reproduce. A shader is only viable as a *bounded* optimisation behind a golden-diff regression
   test. Note a WebGL2-based shader path also changes the readback shape (float vs 8-bit), which is a
   second divergence source.
6. **Per-step atlas reuse is safe**: cells are disjoint (§4) and the atlas is cleared every step.
7. Nothing in this lane may "improve" the pipeline: keep the readback row (not the whole viewport), keep
   the three separate channels, keep `xwidth` normalization, keep the raw byte path (no sRGB/luminance
   conversion — a plain RGBA8 attachment matches GL's bytes).

### 11.2 Cost model

Per step: 1 clear + N viewport draws of the full snapshot + 1 readback of 240×72×4 = 69 KB. Versus
native's N synchronous `glReadPixels` (each a pipeline flush), the browser path should remove essentially
all of the 61-64 % stall (PORT_PLAN.md measured facts 6 / Risks 4).

### 11.3 Performance options that are *not* free

* Rendering only the horizon strip: tempting (§5.5), but a strip render with a *modified* projection is a
  different projection — forbidden. A scissor (`gl.scissor`) with the full projection is fine.
* Skipping the ground quad: **do not** — for this scenario it can never cover the row, but the ground is
  what makes `GroundClearance`/`WorldSize` changes behave natively, and it is 8 vertices.
* Aggregating the three channels into one pass is fine (they read the same buffer with `index ∈ {0,1,2}`).

### 11.4 The acceptance fingerprint (golden-derived, must be reproduced)

The vision lane's observable is not a picture; it is the vector of `3 × numneurons` values per agent per
step, printed as `%g`. Fingerprint of `oracle/minitest_von/run/brain/function/brainFunction_10.txt.gz`
(agent 10, 9 neurons per channel, 185 steps × 37 nerves = 6845 values):

| Quantity | Value |
|---|---|
| steps | 185 |
| vision samples (indices 2-28) | 4995 |
| distinct printed values | 112 |
| exactly `0` (sky / black clear) | 3717 |
| uniform-barrier steps (all 27 = `0.34902`/`0.25098`/`0.14902`) | 27 |
| pure-byte values present | `0`(3717), `0.34902`(330), `0.25098`(330), `0.14902`(330), `0.505882`(42), `0.501961`(23), `1`(23), `0.152941`(14), `0.2`(14), `0.6`(7), `0.686275`(7), `0.27451`(1) |
| `0.349019` (the two-rounding artifact) | absent |
| ground-only bytes `0.101961` (26/255) / `0.0509804` (13/255) | absent (§5.5) |

Regression vectors for L16 (assert on the *printed 6-digit* form, exactly as the golden does):

1. uniform byte row `89/64/38` → `0.34902 ×9 / 0.25098 ×9 / 0.14902 ×9`;
2. uniform byte row `0/0/0` → all zeros;
3. uniform byte row `k` for every `k` in `0..255` → no NaN, value ∈ [0,1], monotone in `k`;
4. one mixed row that exercises the PN-V5 carry (e.g. left half 89, right half 0) — the neuron straddling
   the seam must equal the closed-form weighted mean, and neuron *i+1* must include the carry;
5. an integer-branch agent (1- or 11-neuron channel, §7.2) encoded with the §7.1 path — e.g. 11 neurons
   on uniform 38 → `0.14902 ×11`;
6. `numneurons > retinaWidth` (PN-V8) must throw deterministically, not read out of bounds.

Final acceptance remains `tools/check_parity.py --golden oracle/minitest_von --candidate <run>` (and
`oracle/microtest_von` for a 1-step vision-on smoke test, which also contains agents whose channels take
the integer branch).

### 11.5 Reference encoder (executed; passes the fingerprint)

This is the §7 arithmetic in JS, with the f32/f64 discipline of PN-V6 and the PN-V7 rule. It was run
against the golden: for the 27 uniform-barrier steps it reproduces all 27 values exactly
(`0.34902 ×9 0.25098 ×9 0.14902 ×9`), as a 108-character string equality — i.e. L16 can carry this as a
unit test. (Proposed location: `tests/vision-encoder.test.ts`, lane L16.)

```js
const f32 = Math.fround;                     // every float store in the native code
function encodeChannel(buf, index, numneurons, width) {   // buf: Uint8Array(width*4), RGBA row
  const xwidth = f32(width / numneurons);                 // Retina.cc:170
  let xintwidth = (width / numneurons) | 0;               // :171
  if (xintwidth * numneurons !== width) xintwidth = 0;    // :173-176
  const out = new Float64Array(numneurons);
  if (xintwidth) {                                        // :189-200 integer branch
    let pixel = 0;
    for (let i = 0; i < numneurons; i++) {
      let avg = f32(0.0);                                 // :194 reset per neuron
      for (let k = 0; k < xintwidth; k++) avg = f32(avg + buf[pixel++ * 4 + index]);
      out[i] = avg / (xwidth * 255.0);                    // :198 double division
    }
    return out;
  }
  let pixel = 0, avg = f32(0.0);                          // :203-204 carry, reset once
  for (let i = 0; i < numneurons; i++) {
    const endpixloc = f32(xwidth * f32(i + 1));           // :210
    while (f32(pixel) < endpixloc - 1.0) avg = f32(avg + buf[pixel++ * 4 + index]);  // :214-216
    const t = f32(endpixloc - f32(pixel));
    avg = f32(t * buf[pixel * 4 + index] + avg);          // :225 single rounding (PN-V7)
    out[i] = avg / (xwidth * 255.0);                      // :226 double division
    avg = f32(f32(1.0 - t) * buf[pixel * 4 + index]);      // :234 carry into neuron i+1
    pixel++;                                              // :237
  }
  return out;
}
```

Port notes on that listing, each verified in §13.3:

* `f32(t * byte + avg)` is a **single** rounding: the product of two f32 values is exact in f64, and the
  f64 sum is rounded once into f32 — equal to the exactly-rounded fused value. Checked against a
  BigInt-dyadic exact-FMA on 200 000 random `(t,byte,avg)` triples (0 mismatches) and differentially on
  the encoder for all 256 uniform rows × 3 channels and 30 000 random two-colour rows (0 differences).
* The division at `:198`/`:226` must stay in f64 (`avg / (xwidth*255.0)` gives exactly that in JS, since
  `xwidth` is f32 and `255.0` is a double literal).
* Do not "simplify" to a running mean or to `pow`-based weights; the carry plus the `while` boundary are
  the specification.

---

## 12. PORT-NOTEs (registry)

| Id | Decision / hazard |
|---|---|
| PN-V1 | One geometry snapshot per step; all agents share it (compile-then-render order). |
| PN-V2 | POV pass uses the per-step GL display list; matrix arguments baked at compile time. |
| PN-V3 | `StaticTimestepGeometry` ⇒ nervous-system RNG becomes MT19937 seeded with `agentsEver`. |
| PN-V4 | `frustumXZ` is written (`agent.cc:1074`) and never read — do not cull in the vision lane. |
| PN-V5 | `avgcolor` carries across neurons in the fractional branch (not reset per neuron). |
| PN-V6 | Mixed float/double: float accumulation, double comparison, double final division, `double` nerve. |
| PN-V7 | `:225` is a **single-rounding** multiply-add in the native build. Port as `f32(t*b + avg)`. |
| PN-V8 | Out-of-range `buf` reads when `numneurons > retinaWidth`; latent (not oracle-exercised), guard it. |
| PN-V9 | Retina samples row `y + retinaHeight/2` = the horizon band; the ground is provably invisible. |
| PN-V10 | `GrayCoding` is genome-byte decoding, not vision (de-scoped, §10). |
| PN-V11 | The agent's own body is never in its own retina (eye exactly at the nose plane). |
| PN-V12 | Uniform-grey retina rows are a neighbour's **nose** = its `Light` nerve (all three channels identical). |

Proposed PARITY.md rows (PARITY.md is not in this lane's write set) — **historical, not a pending diff**:
the L16 row below was rewritten in PARITY.md long since, so this list records what this lane argued for,
not a change waiting to land. The live wording, the mechanism and the measurement all sit in PARITY.md →
*Deviations* → `L16 vision raster` and `W1f --selfcheck — run/energy/agents/max.txt`.

* **Correction (Deviation, L16 row)** — the row this lane proposed against read *"fixed-function GL,
  per-agent `glReadPixels`, unbounded precision drift | batched/shader vision, deterministic by
  construction | native vision is not reproducible run-to-run; matching it bit-for-bit is impossible"*
  (PARITY.md rewrote it long since). Its middle and right columns were stale: PARITY.md's own vision
  finding is that native vision **is** reproducible, and PORT_SPEC.md's frozen surface includes the
  vision-on model logs. The `--selfcheck minitest_von` → `1307/1308` verdict is **not** a differing vision
  file: the one file it leaves out of `match` is `run/movie.pmv`, which every tier `ignore`s and the
  checker therefore reports as `IGNORED`, never as `differing` (`differing=0 missing=0 extra=0`) — it can
  never be the name printed after `DIFFERS`. The artifact that *does* move run-to-run is
  `run/energy/agents/max.txt` (`Logs::AgentMaxEnergyLog`): its `AgentGrownEvent` rows are appended in
  *thread-completion* order — the worldfiles set `ParallelInitAgents True` → `Simulation.cc:410` runs
  `InitAgents()` non-serially → `Simulation.cc:875-880` `postParallel(c->grow())` → `agent.cc:758` →
  `Logs::postEvent` appends on the calling thread (`Logs.h:55-68`) — so the row *set* is deterministic and
  two adjacent rows swap; measured 2026-09-28: `--selfcheck minitest_von` 3 FAIL / 4 (always `DIFFERS
  run/energy/agents/max.txt`), `--selfcheck minitest_voff` 1 FAIL / 6 (same file), `--selfcheck
  microtest_von` 3 PASS / 3. Proposed wording:
  *"per-agent synchronous `glReadPixels` (64 % of wall at 192 agents) | batched single readback + CPU
  encoder with f32/f64 discipline (PN-V6/V7) | identical fed values, ~N× fewer pipeline stalls; retina
  *pixels* are a debugging aid, the *neurons* are the contract."*
* **Open question** — is the uniform-grey row in `brainFunction_31` step 0 the neighbour's nose (PN-V12)
  or a coincidence on the body channels? The port decision is unaffected (both paths are L15's colour
  assignment), but a one-off native pixel dump would settle it.
* **Dependency proposals** — none. This lane adds no dependency.

---

## 13. Verification of this spec

### 13.1 Line references
All 111 `file.cc:NNN` references in this file were machine-checked: each was resolved against
`native/src/**` (single matching file, line in range) and the referenced line printed and inspected;
where rev 1 disagreed with the source, this file now carries the corrected number (`Brain.cc:129`
instead of `:124`, `Simulation.cc:3874` instead of `:3871`, `normalized.wf:401` instead of `:398`,
`Simulation.cc:824` for the ground's `y`). The native tree was only read; `oracle/**` was only read.

### 13.2 Golden statistics (recomputed here, not quoted)
Parsed `brainFunction_10.txt.gz` as 185 blocks of 37 nerves (the header's `numNeurons`): 4995 vision
samples, 112 distinct printed values, 3717 exact zeros, 27 uniform-barrier steps, `0.349019` absent,
ground-only bytes absent; anatomy header `brain 10 fitness=0 numneurons+1=38 ... redinput=2-10 ...`
byte-identical to §8's quote. Branch census over all 108 function logs in `minitest_von` +
`microtest_von`: 87 agents fractional-only, 21 agents with ≥1 integer-branch channel.

### 13.3 Encoder + rounding
The §11.5 listing was executed with Node against the golden uniform-barrier steps → PASS (string-equal on
all 27 values). The PN-V7 rule was tested three ways: (i) two-rounding vs single-rounding on the golden's
uniform rows — only single-rounding reproduces `0.34902` at red neuron 5; (ii) an independently written
BigInt-dyadic exact-FMA agreed with the brute-force exact rounding of 200 000 random f32 triples;
(iii) `f32(t*b+avg)` vs exact-FMA over all 256 uniform rows × 3 channels and 30 000 random two-colour
rows → 0 differences. Acceptance remains the byte-exact whole-run comparison, which is the arbiter.

### 13.4 Not verified / carried forward
* the native **mechanism** behind PN-V7 (FMA contraction vs excess precision) — indistinguishable from
  the goldens, and irrelevant: the required observable (single rounding) is pinned;
* the agent-body-vs-nose attribution (PN-V12, §12 open question);
* the assumption that an agent's `y` never drops below the eye height (§5.5 → §14.3);
* ~~a native pixel dump (the `pixels.txt` path in `Retina.cc:126-145` is `#if 0`) — would let L16 compare
  pixels as well as neurons; not needed for the frozen surface.~~ **Recorded since** (`t_83dc2e2c`):
  `src/model/vision/golden/{microtest,minitest}_von.retina.jsonl.gz` — one `{step, agent, x, y, w, h,
  neurons, row}` record per agent per step, `row` the 88 raw bytes `glReadPixels` returned (7315 rows over
  301 steps for `minitest_von`, 83 agents born during the run). It is produced by a run-time interposition
  shim over the *real* native build (`native/retinadump.sh` + `native/dump_retina.py`, headers +
  `libpolyworld.dylib`, never a write inside `oracle/**`), not by the `#if 0` path. The dump is what turns
  "the rasterized row" into a checked surface: the POV scanner (`src/model/vision/povScan.ts` +
  `povRaster.ts`) is held to **every one of those rows** byte-for-byte, and it was the dump — not the run
  tree — that localised `t_717e215e`'s two defects: the first differing pixel was step 12 / agent 23 /
  px 13 (a 0.00145-pixel sub-pixel-snap margin, fixed by rasterizing on the driver's 8-bit grid with the
  top-left fill rule), and once that was fixed the first differing row was step 71, where a body mesh
  shared by every agent (native keeps `agent::fPolygon` per agent) put each agent's own nose 0.0679 in
  front of its eye. Verdict now: `./oracle/run_parity.sh minitest_von` → **PASS 1308/1308**,
  `differing=0 missing=0 extra=0`. The frozen surface is still the *fed neuron value*, not the pixel —
  but for the vision-on scenarios the pixel is now a second, fully checked witness.

---

## 14. Open questions / blockers for this lane

1. **PN-V7 mechanism** (FMA vs excess precision) — unresolvable from the goldens and no longer blocking:
   §7 pins the observable and §11.5 pins the portable rule.
2. **`numneurons` provenance** — *answered in shape*: per-agent values come from the groups-genome
   neuron-count genes; measured histogram and the 21 integer-branch agents are in §7.2. The vision lane
   must consume `nerve->getNeuronCount()` and never assume 9 or a branch.
3. **Elevation band (§5.5)** assumes an agent's `y` stays at `0.5*agentHeight` for life; `UpdateBody`'s y
   handling is L8's to confirm (spawn sites `Simulation.cc:883`, `:895`).
4. **PARITY.md L16 row** states a rationale the measured vision finding contradicts (§12): the
   orchestrator should correct that row, since it currently licenses a precision-loose implementation
   that the frozen surface forbids.
