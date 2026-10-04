# src/model/geometry

Lane W1e — vectors, colours, matrices, frustum, ray/sphere primitives

Only the owning lane writes files here.

## What is in here

| File | Contents |
|---|---|
| `float.ts` | the f32/f64 discipline, the native constants (`PI`, `TWOPI`, `DEGTORAD`, `RADTODEG` — verbatim, they are truncated), bit-level helpers, `nativeAtan2f` (a one-line delegation to lane L1's transcribed arm64 `atan2f`, `rng/libm.ts` — one copy, per PORT-NOTE `W1e/atan2f-is-transcribed`) |
| `vector.ts` | `Vec2`/`Vec3`/`Vec4`/`Color` operations over the shapes frozen in `src/model/types/geometry.ts`, plus the derived colour→byte rule |
| `matrix.ts` | GL-convention 4x4 matrices (column-major), `glTranslatef`/`glRotatef`/`glScalef`, composition, inverse, `gluPerspective`/`glFrustum`/`gluOrtho2D`/`gluLookAt`, the object and camera modelview sequences, frustum-plane extraction |
| `camera.ts` | `gcamera` as data: the four parameters, the pose, the follow object, the fog parameters, the `fPerspectiveFixed`/`fPerspectiveInUse` latches, `use()`/`view()` returning matrices, and `configureAgentPov` (`agent::SetGraphics`/`UpdateVision`) |
| `frustum.ts` | `frustumXZ`, including the latent `angmax` normalisation bug it must reproduce |
| `primitives.ts` | `gpoint`/`gline`/`gpoly`/`gpolyobj` data: bounding box (`setlen`), radius (`setradius` + the fix/unfix overrides), polygon cloning. Also the port's **one** radius rule — `scaledRadius` + the square sums + `boxRadius` — which the environment lane's `gbox` slice (`environment/object.ts`) and `food`'s override import instead of carrying their own |
| `body.ts` | the **agent body mesh**: `parsePolyObjFile` (native's `pw1` loader) + `AgentBodyGeometry`, the real `gpolyobj` behind lane L8's `BodyGeometryLike` seam (`clonegeom`, `agent::SetGeometry`'s in-place vertex scaling, `setlen`, the radius state) |
| `raycast.ts` | ray/sphere, ray/plane, ray/box, sphere/bounds and segment helpers (additions — native has no ray code) |
| `index.ts` | the lane's public surface (import the behaviour from here) |
| `golden/nativeCameraVectors.ts` | **generated** golden vectors + the fixture lists that produced them. Do not hand-edit |
| `golden/nativeBodyMesh.ts` | **generated** `etc/objects/agent.obj` (verbatim, sha256-pinned) + the template's bounds/radius + 112 recorded agents' `fLength`/`fRadius`. Do not hand-edit |
| `native/glprobe.{cpp,sh}` + `native/make_golden_module.py` | the generator: links the native `libpolyworld.dylib` and drives Apple's OpenGL/GLU to record the matrices, then emits the TypeScript module |
| `native/bodyprobe.{cpp,sh}` + `native/make_body_mesh_module.py` | the body-mesh generator: the real loader, the real `agent::SetGeometry()` on a real `agent` fed the recorded genomes' genes -> `golden/nativeBodyMesh.ts` |
| `native/sqrt_discipline.py` | the measurement behind PORT-NOTE `L8/sqrt-of-a-float-is-single-precision` (no build needed) |

Tests: `tests/geometry.test.ts` (38 golden-vector + self-consistency tests, 9 body-mesh tests).

Regenerate the goldens with `bash src/model/geometry/native/glprobe.sh --ts` and
`bash src/model/geometry/native/bodyprobe.sh all --ts` (both need the native build at
`../polyworld`, overridable with `POLYWORLD_NATIVE`). Regeneration is byte-identical;
`POLYWORLD_GLPROBE_TRACE=1` prints progress if the native side aborts.
