/**
 * Lane L11 (sim) — `class Events` (native `utils/Events.h`): the per-step eat/mate event filter.
 *
 * Native builds one of these only when complexity is on **and** at least one
 * `ComplexityType` is lowercase (`Simulation.cc:431-444`); the recorders then ask
 * `GetAgentEvent( step, agentNumber )` to decide whether a given agent ate or mated on a given
 * step. It exists so a run can record only the interesting agents' brains.
 *
 * PORT-NOTE(sim/events-bitfield): native stores the two flags in a `#pragma pack(1)` bitfield
 * struct (`bool eat : 1; bool mate : 1`). The port stores plain booleans — the field is not
 * serialized anywhere, and `GetAgentEvent` returns a copy, which the port reproduces by
 * returning a fresh object (a caller that mutated the returned struct in native would not see
 * the change either).
 *
 * PORT-NOTE(sim/events-map-order): native's per-step container is a `std::map<long,...>` keyed
 * by agent number, i.e. **sorted by number**, and `GetAgentEventsMap( step )` hands that map to
 * the logger. The port keeps a `Map<number, AgentEvent>` which iterates in insertion order, not
 * number order — a difference the loggers can see. See PARITY.md → Open questions; the recorded
 * scenarios never build an `Events` object (complexity is off), so no golden depends on it.
 */

/** Native `AgentEvent` — the packed bitfield holding the two flags. */
export interface AgentEvent {
  eat: boolean;
  mate: boolean;
}

/** Native `AgentEventsMapType` (`std::map<long, AgentEvent>`). */
export type AgentEventsMap = Map<number, AgentEvent>;

/** Native `class Events`. */
export class Events {
  private readonly events: AgentEventsMap[];

  /** Native `Events::Events( long simMaxSteps )` — `maxSteps+1` maps, steps count from one. */
  constructor(private readonly maxSteps: number) {
    this.events = [];
    for (let step = 0; step <= maxSteps; step++) this.events.push(new Map());
  }

  /** Native `Events::AddEvent( step, agentNumber, event )` — `'e'` eat, `'m'` mate, else no-op. */
  addEvent(step: number, agentNumber: number, event: string): void {
    if (event === 'e') {
      this.mapFor(step, agentNumber).eat = true;
    } else if (event === 'm') {
      this.mapFor(step, agentNumber).mate = true;
    }
  }

  /** Native `Events::GetAgentEvent( step, agentNumber )` — a default-false event if absent. */
  getAgentEvent(step: number, agentNumber: number): AgentEvent {
    const existing = this.events[step]!.get(agentNumber);
    if (existing === undefined) return { eat: false, mate: false };
    return existing;
  }

  /** Native `Events::GetAgentEventsMap( step )` — the whole per-step map. */
  getAgentEventsMap(step: number): AgentEventsMap {
    return this.events[step]!;
  }

  private mapFor(step: number, agentNumber: number): AgentEvent {
    const map = this.events[step]!;
    let event = map.get(agentNumber);
    if (event === undefined) {
      // Native `std::map::operator[]` value-initializes the `AgentEvent` bitfield to false.
      event = { eat: false, mate: false };
      map.set(agentNumber, event);
    }
    return event;
  }

  /** Native's `maxSteps` member (kept for parity of the constructor's effect). */
  getMaxSteps(): number {
    return this.maxSteps;
  }
}
