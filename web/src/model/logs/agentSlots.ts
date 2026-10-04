/**
 * Lane L12 (logs) — native `AgentAttachedData` (`agent/AgentAttachedData.{h,cc}`) as the
 * loggers use it: a process-global slot allocator plus one opaque pointer per slot per agent.
 *
 * Native gives every `agent` an `attachedData` array sized by the number of slots created
 * *before* the first agent was allocated (`AgentAttachedData::alloc` asserts nothing is
 * allocated yet — `assert( !allocatedAgent )` in `createSlot`), and `Logger`'s
 * `AgentStateScope` is the only user of the mechanism in the log lane:
 *
 *   AgentStateScope:  slotHandle = AgentAttachedData::createSlot()
 *                     set/get( a, slotHandle, FILE * / DataLibWriter * / AbstractFile * )
 *
 * PORT-NOTE(l12/agent-slot-store): the port keeps the same shape — `createSlot()` hands out
 * monotonically increasing handles, the per-agent array is created on demand and zero-filled
 * (`undefined`), and `get`/`set` index it. The store is a seam
 * (`AgentAttachedDataStore`) with a `Map`-backed default here, because the *agent* lane owns
 * agent lifetime: L8 calls `alloc` when it constructs an agent and `dispose` when the agent
 * dies. A domain that never calls `alloc` still works (the slot array is created lazily on
 * first `set`), which is exactly what happens in a replay harness that never builds agents.
 */

/** Native `AgentAttachedData::SlotHandle`. */
export type SlotHandle = number;

/** Native `AgentAttachedData::SlotData`. */
export type SlotData = unknown;

/** The open/close/store surface the loggers need (native's four statics + `alloc`). */
export interface AgentAttachedDataStore {
  /** Native `AgentAttachedData::createSlot()`. */
  createSlot(): SlotHandle;
  /** Native `AgentAttachedData::alloc( a )` — L8 calls this from the agent constructor. */
  alloc(agent: object): void;
  /** Native `AgentAttachedData::dispose( a )` — L8 calls this when an agent dies. */
  dispose(agent: object): void;
  /** Native `AgentAttachedData::set( a, handle, data )`. */
  set(agent: object, handle: SlotHandle, data: SlotData): void;
  /** Native `AgentAttachedData::get( a, handle )`. */
  get(agent: object, handle: SlotHandle): SlotData;
}

/** The `Map`-backed default (native's `agent::attachedData` array). */
export class MapAgentAttachedData implements AgentAttachedDataStore {
  private readonly slots = new Map<object, SlotData[]>();
  private nslots = 0;

  createSlot(): SlotHandle {
    return this.nslots++;
  }

  alloc(agent: object): void {
    this.slots.set(agent, new Array<SlotData>(this.nslots));
  }

  dispose(agent: object): void {
    this.slots.delete(agent);
  }

  set(agent: object, handle: SlotHandle, data: SlotData): void {
    let store = this.slots.get(agent);
    if (!store) {
      store = new Array<SlotData>(this.nslots);
      this.slots.set(agent, store);
    }
    store[handle] = data;
  }

  get(agent: object, handle: SlotHandle): SlotData {
    return this.slots.get(agent)?.[handle];
  }

  /** Test hook: forget every agent (native has no such call — agents are never recycled). */
  clear(): void {
    this.slots.clear();
    this.nslots = 0;
  }
}

/** Native's statics: one process-global store. */
export const agentAttachedData: AgentAttachedDataStore = new MapAgentAttachedData();
