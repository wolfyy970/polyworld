/**
 * Lane L10 — native `utils/objectxsortedlist.{h,cc}` (plus the `gdlist` cursor semantics it
 * is built on). The environment is the only lane that *creates* world objects
 * (`FoodPatch::addFood`, `BrickPatch::addBricks`/`removeBricks`), and every one of them is
 * inserted into this list, so its ordering is the environment's to get right.
 *
 * WHY IT IS IN THIS LANE
 *
 * Native puts the file in `utils/`, but it is inseparable from the objects it sorts: it
 * includes `agent/agent.h`, `environment/food.h` and `environment/brick.h`, its insertion key
 * is `x - radius()`, and its cursor is what `sim/Simulation.cc` and the loggers walk.
 * L12's seam note (`src/model/logs/seams.ts`) records the same conclusion — "the list stays
 * the sim/environment lane's". PORT-NOTE(L10/xsortedlist-home): this is that implementation;
 * `src/model/logs/seams.ts`'s `LogSortedObjectList` and `src/model/agent/contracts.ts`'s
 * `SortedObjectListLike` both bind to it (the method names differ only in the out-parameter
 * style — see below).
 *
 * WHAT IS FROZEN (the ordering, not the container)
 *
 *  - `add` inserts **before the first object whose `(x - radius())` is strictly greater**, and
 *    appends when there is none. Equal keys therefore keep insertion order (FIFO), and the
 *    list is ordered by the object's left edge, not its centre.
 *    PORT-NOTE(L10/xsortedlist-insert-key).
 *
 *    The key is `x()` **minus `radius()`** — the native *accessor*, not a radius field. Native
 *    spells it that way because `gobject::radius()` is a method, and lane L8's `agent` is not a
 *    `GoObject` at all: it has no radius field to read, only `radius()`. A field read here
 *    yields `NaN` for every agent, `NaN < NaN` is false, `add` then always appends and
 *    `sort()` never relocates a node — the list silently degenerates to insertion order and
 *    `TSimulation::Interact`'s x-early-out walk stops reaching agent pairs. Pinned by the
 *    `objectlist.accessor.*` fixtures (the probe's accessor-radius objects are added *before*
 *    this note was written; the port's mirror has no radius field at all, so restoring a field
 *    read fails those keys). PORT-NOTE(L10/radius-is-an-accessor).
 *  - `removeCurrentObject` leaves the cursor where `gdlist::remove()` leaves it (on the
 *    previous link, or off the head when the first link was removed) — the callers depend on
 *    it: `BrickPatch::removeBricks` walks the list removing as it goes, and
 *    `sim/Simulation.cc` saves/restores the cursor around a "dead agent becomes food"
 *    insertion with `getcurr`/`setcurr`.
 *  - The per-type counters are incremented on `add` and decremented on
 *    `removeCurrentObject`/`removeObjectWithLink`, and `getCount(mask)` sums the ones the mask
 *    selects (`AGENTTYPE`/`FOODTYPE`/`BRICKTYPE` bits).
 *
 * PORT-NOTE(L10/xsortedlist-structure): the port keeps the *observable* cursor semantics and
 * order but implements the container as nodes with `next`/`prev` in this module instead of a
 * ported `gdlist<T>` template (PORT_SPEC: behaviour frozen, structure free; `gdlist` is a
 * private implementation detail of native's list, and no recorded artifact can see it). The
 * `getcurr`/`setcurr` handles are the node objects, so the save/restore idiom still works.
 *
 * PORT-NOTE(L10/xsortedlist-out-params): native's walkers write through a `gobject**` out
 * parameter and return 0/1; every caller tests the return value *first*, so returning the
 * object or null is behaviourally identical. The one place it is not — `lastObj` on an empty
 * list dereferences the null it just wrote — throws here instead.
 */

import { GObjectType } from '../types/simconst';
import { f32 } from '../agent/numeric';
import type { GoObject } from './object';

/**
 * The x-sorted list's ordering key, native `gobject::x() - gobject::radius()`.
 *
 * The comparison in `add`/`sort` is between **two objects**, so both operands are `float` and the
 * subtraction is a *single-precision* one; the port's `a.x() - a.radius()` left it in double and
 * compared exactly, which breaks a tie the native build keeps. Measured (native step probe vs the
 * port at `minitest_voff` step 232, agents 4x/64): the exact double keys are
 * `0x4030ad2b4f000000` (48) and `0x4030ad2b45000000` (64) — the port's exact compare ranks 64
 * first, while both `float` keys are the same `0x4185695a`, so native's `add`/`sort` see a tie and
 * keep the insertion order: agents 48, 64. That 1-ulp tie-break is what swapped
 * `events/collisions.log`'s step-233 rows.
 */
function xSortKey(o: GoObject): number {
  return f32(o.x() - o.radius());
}

/** Native `utils/objectxsortedlist.h` direction constants (`#define NEXT 1` / `PREV 2`). */
export const NEXT = 1;
export const PREV = 2;

/** One node of the x-sorted list (native `gdlink<gobject*>`), also the cursor handle. */
export class XSortedLink {
  obj: GoObject;
  nextItem: XSortedLink | null = null;
  prevItem: XSortedLink | null = null;

  constructor(obj: GoObject) {
    this.obj = obj;
  }

  /** Native `gdlink::insert` — put `link` immediately *before* this one. */
  insert(link: XSortedLink): void {
    if (this.prevItem) this.prevItem.nextItem = link;
    link.nextItem = this;
    link.prevItem = this.prevItem;
    this.prevItem = link;
  }

  /** Native `gdlink::append` — put `link` immediately *after* this one. */
  append(link: XSortedLink): void {
    if (this.nextItem) this.nextItem.prevItem = link;
    link.nextItem = this.nextItem;
    link.prevItem = this;
    this.nextItem = link;
  }

  /** Native `gdlink::remove` — unlink this node (the list's cursor is *not* touched here). */
  remove(): void {
    if (this.prevItem) this.prevItem.nextItem = this.nextItem;
    if (this.nextItem) this.nextItem.prevItem = this.prevItem;
    this.nextItem = this.prevItem = null;
  }
}

/**
 * Native `objectxsortedlist` — the x-sorted list of every world object, plus native's
 * `gdlist` cursor.
 */
export class XSortedObjects {
  private lastItem: XSortedLink | null = null;
  private currItem: XSortedLink | null = null;
  private markItem: XSortedLink | null = null;
  private kount = 0;

  private agentCount = 0;
  private foodCount = 0;
  private brickCount = 0;
  private markedAgent: XSortedLink | null = null;
  private markedFood: XSortedLink | null = null;
  private markedBrick: XSortedLink | null = null;

  // --- gdlist cursor ---------------------------------------------------------

  /** Native `gdlist::reset()`. */
  reset(): void {
    this.currItem = null;
  }

  getcurr(): XSortedLink | null {
    return this.currItem;
  }

  setcurr(link: XSortedLink | null): void {
    this.currItem = link;
  }

  isempty(): boolean {
    return this.lastItem === null;
  }

  count(): number {
    return this.kount;
  }

  /** Native `gdlist::next( TTYPE &a )` — returns the next object or null at the end. */
  next(): GoObject | null {
    if (this.lastItem === null) return null;
    if (this.currItem) {
      if (this.currItem === this.lastItem) {
        this.currItem = null;
        return null;
      }
      this.currItem = this.currItem.nextItem;
    } else {
      this.currItem = this.lastItem.nextItem;
    }
    return this.currItem!.obj;
  }

  /** Native `gdlist::prev( TTYPE &a )`. */
  prev(): GoObject | null {
    if (this.lastItem === null) return null;
    if (this.currItem) {
      if (this.currItem === this.lastItem.nextItem) {
        this.currItem = null;
        return null;
      }
      this.currItem = this.currItem.prevItem;
    } else {
      this.currItem = this.lastItem;
    }
    return this.currItem!.obj;
  }

  /** Native `gdlist::current( TTYPE &a )` — the current object, or null off the end. */
  current(): GoObject | null {
    if (this.lastItem === null || this.currItem === null) return null;
    return this.currItem.obj;
  }

  /** Native `gdlist::last( TTYPE &a )`. */
  last(): GoObject | null {
    if (this.lastItem === null) return null;
    return this.lastItem.obj;
  }

  // --- gdlist insertion -----------------------------------------------------

  /** Native `gdlist::insert( gdlink* )` — at the head. */
  private insertLink(link: XSortedLink): void {
    if (this.lastItem) {
      this.lastItem.nextItem!.insert(link);
    } else {
      this.lastItem = link;
      link.nextItem = link.prevItem = link;
    }
    this.kount++;
  }

  /** Native `gdlist::append( gdlink* )` — at the tail (`lastItem` is adjusted). */
  private appendLink(link: XSortedLink): void {
    this.insertLink(link);
    this.lastItem = this.lastItem!.nextItem;
  }

  /** Native `gdlist::inserthere( gdlink* )` — before the cursor, or at the head. */
  private insertHereLink(link: XSortedLink): void {
    if (this.currItem) {
      this.currItem.insert(link);
      this.kount++;
    } else {
      this.insertLink(link);
    }
  }

  // --- gdlist removal -------------------------------------------------------

  /** Native `gdlist::remove()` — remove the current node, leaving the cursor as native does. */
  private removeCurrentLink(): void {
    if (this.isempty()) return;
    if (this.currItem) {
      if (this.currItem === this.lastItem!.nextItem) {
        // first link
        this.currItem.remove();
        if (this.markItem === this.currItem) this.markItem = null;
        this.currItem = null;
        this.kount--;
      } else if (this.currItem === this.lastItem) {
        // last link
        const prevcurr = this.currItem.prevItem;
        this.currItem.remove();
        if (this.markItem === this.currItem) this.markItem = prevcurr;
        this.currItem = prevcurr;
        this.lastItem = this.currItem;
        this.kount--;
      } else {
        const prevcurr = this.currItem.prevItem;
        this.currItem.remove();
        if (this.markItem === this.currItem) this.markItem = prevcurr;
        this.currItem = prevcurr;
        this.kount--;
      }
    } else {
      // Native treats a null cursor like the first link and leaves `markItem` alone.
      this.currItem = this.lastItem!.nextItem;
      this.currItem!.remove();
      this.currItem = null;
      this.kount--;
    }
    if (this.kount === 0) this.lastItem = null;
  }

  // --- objectxsortedlist ----------------------------------------------------

  /**
   * Native `objectxsortedlist::add( gobject* a )` (`:143-183`): x-sorted insertion, the
   * object's own `listLink` recorded, then the per-type counter.
   */
  add(a: GoObject): void {
    let inserted = false;
    this.reset();
    for (;;) {
      const o = this.next();
      if (o === null) break;
      if (xSortKey(a) < xSortKey(o)) {
        const link = new XSortedLink(a);
        this.insertHereLink(link);
        a.listLink = link;
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      const link = new XSortedLink(a);
      this.appendLink(link);
      a.listLink = link;
    }

    switch (a.getType()) {
      case GObjectType.AGENT:
        this.agentCount++;
        break;
      case GObjectType.FOOD:
        this.foodCount++;
        break;
      case GObjectType.BRICK:
        this.brickCount++;
        break;
      default:
        throw new Error(`add() called for x-sorted object list with invalid object type (${a.getType()})`);
    }
  }

  /** Native `objectxsortedlist::removeCurrentObject()`. */
  removeCurrentObject(): void {
    const o = this.current();
    if (o === null) return;

    switch (o.getType()) {
      case GObjectType.AGENT:
        this.agentCount--;
        this.markedAgent = this.repairMark(this.markedAgent, o);
        break;
      case GObjectType.FOOD:
        this.foodCount--;
        this.markedFood = this.repairMark(this.markedFood, o);
        break;
      case GObjectType.BRICK:
        this.brickCount--;
        this.markedBrick = this.repairMark(this.markedBrick, o);
        break;
      default:
        throw new Error(`object in list has invalid type (${o.getType()})`);
    }

    this.removeCurrentLink();

    if (this.kount !== this.agentCount + this.foodCount + this.brickCount) {
      throw new Error(
        `kount (${this.kount}) != agentCount (${this.agentCount}) + foodCount (${this.foodCount}) + brickCount (${this.brickCount})`,
      );
    }
  }

  /**
   * Native's mark rewind when the marked item is the one being removed: walk back from the
   * `currItem` that is about to go until an object of the same type is found, or clear the
   * mark at the head of the list.
   */
  private repairMark(mark: XSortedLink | null, o: GoObject): XSortedLink | null {
    if (mark === null || mark !== this.currItem) return mark;
    let tempItem: XSortedLink | null = this.currItem;
    for (;;) {
      if (tempItem === null || tempItem === this.lastItem!.nextItem) return null;
      const prevItem: XSortedLink | null = tempItem.prevItem;
      tempItem = prevItem;
      // Native tests `tempItem->e->getType() == <type>` (equality, not a mask).
      if (prevItem !== null && prevItem.obj.getType() === o.getType()) return prevItem;
    }
  }

  /** Native `objectxsortedlist::removeObjectWithLink( gobject* o )`. */
  removeObjectWithLink(o: GoObject): void {
    const item = o.listLink as XSortedLink | null;
    if (item === null) throw new Error('removeObjectWithLink: object has no list link');
    let saveCurr: XSortedLink | null = null;
    if (this.currItem !== item) saveCurr = this.currItem;
    this.currItem = item;
    this.removeCurrentObject();
    const countType =
      o.getType() === GObjectType.AGENT
        ? this.agentCount
        : o.getType() === GObjectType.FOOD
          ? this.foodCount
          : o.getType() === GObjectType.BRICK
            ? this.brickCount
            : 0;
    if (countType && saveCurr) this.currItem = saveCurr;
  }

  /**
   * Native `objectxsortedlist::sort()` (`objectxsortedlist.cc:250-278`) — one insertion-sort
   * pass, "assuming the list is almost entirely sorted at the start".
   *
   * PORT-NOTE(L10/xsortedlist-sort-is-live): this pass is **not** dead code. Native's
   * `TSimulation::Interact()` calls it unconditionally on every step (`sim/Simulation.cc:1465`,
   * `objectxsortedlist::gXSortedObjects.sort();`), and agents move every step, so the keys are
   * stale on arrival and the pass genuinely relocates nodes. `Interact` then walks the list to
   * decide RNG draw order, and `run/energy/food.txt` is a float sum in x-sorted order — so the
   * order this leaves behind is on the recorded path. (An earlier revision of this note claimed
   * "nothing in the recorded path calls it"; that was wrong and L11 would have read it as
   * licence to drop the call.)
   *
   * PORT-NOTE(L10/xsortedlist-sort-o-p-rebind): the load-bearing line in native is `o = p;`
   * at the *end* of the relocation branch, immediately before the shared `p = o;`. Native's `p`
   * is the object at the saved cursor position, so after a relocation the shared `p = o;` must
   * leave `p` **where it was** — the next iteration compares against the *pre-move* `p`, not
   * against the object that just moved. Without the rebind the pass produces a different order
   * and never converges to native's, however many times it is run.
   */
  sort(): void {
    this.reset();
    this.next();
    let savecurr = this.currItem;
    let p = savecurr;
    for (;;) {
      const oLink = this.nextLink();
      if (oLink === null) break;
      let o = oLink;
      if (xSortKey(o.obj) < xSortKey(p!.obj)) {
        const link = this.unlinkCurrent();
        this.currItem = savecurr;
        let b: GoObject | null = null;
        while (this.prev() !== null) {
          b = this.currItem!.obj;
          if (xSortKey(b) < xSortKey(o.obj)) break;
        }
        if (this.currItem) {
          this.currItem.append(link!);
          this.kount++;
        } else {
          this.insertLink(link!);
        }
        this.currItem = savecurr;
        o = p!; // native `o = p;` — see PORT-NOTE(L10/xsortedlist-sort-o-p-rebind)
      }
      p = o;
      savecurr = this.currItem;
    }
  }

  /** Cursor move returning the *link* (native's `while (this->next(o))` with a pointer). */
  private nextLink(): XSortedLink | null {
    if (this.lastItem === null) return null;
    if (this.currItem) {
      if (this.currItem === this.lastItem) {
        this.currItem = null;
        return null;
      }
      this.currItem = this.currItem.nextItem;
    } else {
      this.currItem = this.lastItem.nextItem;
    }
    return this.currItem;
  }

  /**
   * Native `gdlist::unlink()` — unlink the current node and leave the cursor (and
   * `lastItem`) exactly where native's three cases leave them.
   */
  private unlinkCurrent(): XSortedLink | null {
    if (this.isempty() || this.currItem === null) return null;
    let savecurr: XSortedLink;
    if (this.currItem === this.lastItem!.nextItem) {
      // first link
      this.currItem.remove();
      savecurr = this.currItem;
      this.currItem = null;
      this.kount--;
    } else if (this.currItem === this.lastItem) {
      // lastItem link
      const prevcurr = this.currItem.prevItem;
      this.currItem.remove();
      savecurr = this.currItem;
      this.currItem = prevcurr;
      this.lastItem = this.currItem;
      this.kount--;
    } else {
      const prevcurr = this.currItem.prevItem;
      this.currItem.remove();
      savecurr = this.currItem;
      this.currItem = prevcurr;
      this.kount--;
    }
    if (this.kount === 0) this.lastItem = null;
    return savecurr;
  }

  /**
   * Native `objectxsortedlist::getCount( int objType )` — a bit-mask sum over the three
   * counters (`AGENTTYPE`/`FOODTYPE`/`BRICKTYPE`).
   */
  getCount(objType: number): number {
    let count = 0;
    if (objType & GObjectType.AGENT) count += this.agentCount;
    if (objType & GObjectType.FOOD) count += this.foodCount;
    if (objType & GObjectType.BRICK) count += this.brickCount;
    return count;
  }

  /** Native `objectxsortedlist::nextObj( objType, gobject** )`. */
  nextObj(objType: number): GoObject | null {
    let g = this.next();
    if (g === null) return null;
    while ((g.getType() & objType) === 0) {
      g = this.next();
      if (g === null) return null;
    }
    return g;
  }

  /** Native `objectxsortedlist::prevObj( objType, gobject** )`. */
  prevObj(objType: number): GoObject | null {
    let g = this.prev();
    if (g === null) return null;
    while ((g.getType() & objType) === 0) {
      g = this.prev();
      if (g === null) return null;
    }
    return g;
  }

  /** Native `objectxsortedlist::lastObj( objType, gobject** )`. */
  lastObj(objType: number): GoObject | null {
    let g = this.last();
    if (g === null) {
      // Native writes null into the out parameter and then dereferences it.
      throw new Error('lastObj: the x-sorted object list is empty (native dereferences null here)');
    }
    while ((g.getType() & objType) === 0) {
      g = this.prev();
      if (g === null) throw new Error('lastObj: no object of the requested type (native dereferences null here)');
    }
    return g;
  }

  /** Native `objectxsortedlist::anotherObj( direction, objType, gobject** )`. */
  anotherObj(direction: number, objType: number): GoObject | null {
    if (direction === NEXT) return this.nextObj(objType);
    if (direction === PREV) return this.prevObj(objType);
    throw new Error(`anotherObj: unknown direction (${direction})`);
  }

  // --- marks ----------------------------------------------------------------

  /** Native `objectxsortedlist::setMark( objType )` — requires the cursor's type to match. */
  setMark(objType: number): void {
    const lookAt = this.currItem;
    if (lookAt === null || lookAt.obj.getType() !== objType) {
      throw new Error(
        `setMark: objtype (${objType}) != current objtype (${lookAt === null ? 'null' : lookAt.obj.getType()})`,
      );
    }
    if (objType === GObjectType.AGENT) this.markedAgent = lookAt;
    else if (objType === GObjectType.FOOD) this.markedFood = lookAt;
    else if (objType === GObjectType.BRICK) this.markedBrick = lookAt;
    else throw new Error(`setMark: illegal type (${objType})`);
  }

  /** Native `objectxsortedlist::toMark( objType )`. */
  toMark(objType: number): void {
    if (objType === GObjectType.AGENT) this.currItem = this.markedAgent;
    else if (objType === GObjectType.FOOD) this.currItem = this.markedFood;
    else if (objType === GObjectType.BRICK) this.currItem = this.markedBrick;
    else throw new Error(`toMark: illegal type (${objType})`);
  }

  /** Native `objectxsortedlist::getMark( objType, gobject* )`. */
  getMark(objType: number): GoObject | null {
    if (objType === GObjectType.AGENT) return this.markedAgent?.obj ?? null;
    if (objType === GObjectType.FOOD) return this.markedFood?.obj ?? null;
    if (objType === GObjectType.BRICK) return this.markedBrick?.obj ?? null;
    throw new Error(`getMark: illegal type (${objType})`);
  }
}

/**
 * Native `objectxsortedlist objectxsortedlist::gXSortedObjects;` — the process-wide list.
 * Every `add`/`removeCurrentObject` in the environment goes through it, which is why the
 * environment's classes take it as an injected argument (so a lane test can use its own
 * instance) while the simulation uses this one.
 */
export const gXSortedObjects = new XSortedObjects();
