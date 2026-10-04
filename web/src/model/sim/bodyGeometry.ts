/**
 * Lane L11 (sim) — the agent's body geometry as the `AgentDeps` bundle wants it.
 *
 * Native `agent::agentinit()` loads the body mesh (`Resources::loadPolygons( agent::agentobj,
 * "agent" )` over `etc/objects/agent.obj`) and `agent::SetGeometry()` turns it into
 * `fLength[0..2]`, which `agent::setradius()` converts into `fRadius`/`fCarryRadius` — the
 * agent's collision/carry radius, a model input to `Interact`'s contact test, `Prey`/`Predator`/
 * `Avoid`, carrying and every collision event. It is not graphics.
 *
 * PORT-NOTE(sim/body-geometry-delegates-to-L15): lane L15 landed the real thing
 * (`src/model/geometry/body.ts`): the `pw1` loader `Resources::loadPolygons` uses, the
 * `AgentBodyGeometry` `gpolyobj` (clonegeom + `SetGeometry`'s in-place vertex scaling +
 * `gpolyobj::setlen`'s bounding box + the radius state) and the mesh — `etc/objects/agent.obj`
 * bundled verbatim, with its sha256, in `src/model/geometry/golden/nativeBodyMesh.ts`, plus the
 * per-recorded-agent radius vectors the native `agent::SetGeometry()` produced. This module is
 * now the thin binding its first version predicted it would become; it keeps its exported names
 * (`bodyGeometry`, `agentBodyTemplate`, `AgentBodyGeometry`) so the `AgentDeps` bundle in
 * `bindings.ts` did not change.
 *
 * PORT-NOTE(sim/body-recording-is-dead): the recording this module used to carry
 * (`sim/golden/agentBody.ts` + `sim/native/agentbodyprobe.*`, 200 cases) was read by no code and
 * has been **deleted** (lane L11, card `t_a31f454e`); `sim/golden/` went with it. Its numbers
 * agreed with lane L15's independent recording — a second witness of the same fact, not a second
 * implementation — but two recorded copies of one mesh would drift, so the weaker one is gone
 * rather than kept as a second source of the same numbers.
 */

export {
  AgentBodyGeometry,
  agentBodyTemplate,
  createAgentBodyGeometry,
  type PolyObjFile,
} from '../geometry/body';

import { agentBodyTemplate as template, createAgentBodyGeometry } from '../geometry/body';
import type { AgentBodyGeometry as AgentBodyGeometryType } from '../geometry/body';
import type { PolyObj } from '../geometry';

/** Native `agent::agentinit()`'s two objects, as the `AgentDeps` bundle wants them. */
export function bodyGeometry(): { geometry: AgentBodyGeometryType; bodyTemplate: PolyObj } {
  const bodyTemplate = template();
  return { geometry: createAgentBodyGeometry(bodyTemplate), bodyTemplate };
}
