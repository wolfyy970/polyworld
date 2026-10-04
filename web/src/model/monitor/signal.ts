/**
 * Lane L14 — `util::Signal` (`library/utils/Signal.h`), the observer mechanism the whole
 * monitor lane is built on: chart curves, brain/status-text updates, agent-tracker target
 * changes and the scene renderer's `renderComplete` are all signals.
 *
 * Native source: `utils/Signal.h` (a 39-line header template: `std::list<std::function>`,
 * `operator+=` returns the inserted iterator, `operator-=` erases it, `operator()` calls every
 * slot in list order, `receivers()` is the list size).
 *
 * PORT-NOTE(monitor/signal-home): `utils/Signal.h` is a *header* template that no lane owns
 * explicitly (`PORT_SPEC.md` maps `library/utils/**` to L1/L2, whose cuts name RNG/error/misc
 * and datalib/AbstractFile). The monitor lane is its only consumer in the model, so the port
 * lives here, with the exact native semantics; if another lane needs it, it should be lifted
 * into `src/model/types/` rather than copied. `renderStringKeys`-style behaviour is not
 * involved — this is *only* the observer list.
 *
 * PORT-NOTE(monitor/signal-handles): native handles are `std::list::iterator`s, i.e. positions
 * in a mutable list; the port hands out opaque ids instead so that a disconnect during an emit
 * cannot corrupt an unrelated slot's handle. Emitting walks a *snapshot* of the slot list:
 * native's `operator()` iterates the live list, so a slot that connects/disconnects during an
 * emit is undefined behaviour there. No native call path does it (verified: the only
 * disconnect sites are `SceneMovieController::step` and `AgentTracker::setTarget`, neither
 * reachable from inside an emit), so the snapshot is a strictly safer superset. Recorded in
 * PARITY.md → Deviations.
 */

/** Native `util::Signal<...>::SlotHandle` — an opaque handle to one connected slot. */
export interface SlotHandle {
  readonly id: number;
}

export type Slot<Args extends unknown[]> = (...args: Args) => void;

export class Signal<Args extends unknown[] = []> {
  private entries: Array<{ id: number; slot: Slot<Args> }> = [];
  private nextId = 1;

  /** Native `operator+=`: connect a slot, in list order; returns its handle. */
  connect(slot: Slot<Args>): SlotHandle {
    const id = this.nextId++;
    this.entries.push({ id, slot });
    return { id };
  }

  /** Native `operator-=`: erase a handle. Unknown handles are ignored. */
  disconnect(handle: SlotHandle): void {
    const at = this.entries.findIndex((e) => e.id === handle.id);
    if (at >= 0) this.entries.splice(at, 1);
  }

  /** Native `operator()`: call every slot in connection order. */
  emit(...args: Args): void {
    for (const entry of this.entries.slice()) entry.slot(...args);
  }

  /** Native `receivers()`: the number of connected slots. */
  receivers(): number {
    return this.entries.length;
  }
}
