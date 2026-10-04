/**
 * Lane L12 (logs) — native `Logs`' *statics* (`logs/Logs.h:36`): the installed-logger list,
 * the registered-event mask and the per-event registry.
 *
 * Native stores these as `Logs` statics and reaches them from `Logger`'s constructor
 * (`Logs::installLogger( this )`) and from `Logger::initRecording` (`Logs::registerEvents`).
 * They are process-global state, and the port keeps them in a module of their own so the
 * `Logger` base class can install itself without importing the `Logs` class body (which owns
 * the recorders) — the module graph stays acyclic and the semantics are unchanged:
 *
 *   installLogger( logger )   -> _installedLoggers.push_back( logger )
 *   registerEvents( l, bits ) -> for each set bit: _eventRegistry[ bit ].push_back( l )
 *                                _registeredEvents |= bits
 *   postEvent( e )            -> if( _registeredEvents & e.type ) dispatch to the list
 *
 * PORT-NOTE(l12/event-registry-bits): native `sim::EventType` is an `int`, so
 * `registerEvents` walks **32** bits (`sizeof(sim::EventType) * 8`) and builds each type as
 * `EventType(1) << bit`. The port walks the same 32 bits with JS `<<` (int32, so bit 31 is
 * negative — same arithmetic as the C) even though only bits 0..16 carry events today.
 *
 * PORT-NOTE(l12/dispatch-order): within one event type, loggers run in *install* order,
 * which is the order the recorders are constructed in `Logs`. A recorder that registers for
 * an event type it does not handle hits the base `processEvent` — native `assert( false )`
 * — so the port throws there rather than silently ignoring the event.
 */

import { Event_None, type EventType, type SimEvent } from '../types';

/**
 * What the registry needs from a logger. `Logger` (in `logger.ts`) implements this; declaring
 * it here keeps the registry free of a dependency on the base class.
 */
export interface RegisteredLogger {
  /** Native `Logger::getMaxOpenFiles()`. */
  getMaxOpenFiles(): number;
  /** The port's stand-in for the C++ overload set `processEvent( const T & )`. */
  processEvent(event: SimEvent): void;
}

/** Native `Logs::_installedLoggers`. */
const installedLoggers: RegisteredLogger[] = [];

/** Native `Logs::_registeredEvents`. */
let registeredEvents: EventType = Event_None;

/** Native `Logs::_eventRegistry` (`std::map< EventType, LoggerList >`). */
const eventRegistry = new Map<EventType, RegisteredLogger[]>();

/** Native `Logs::installLogger( Logger * )`. */
export function installLogger(logger: RegisteredLogger): void {
  installedLoggers.push(logger);
}

/** Native `Logs::registerEvents( Logger *, sim::EventType )`. */
export function registerEvents(logger: RegisteredLogger, eventTypes: EventType): void {
  const nbits = 32; // sizeof( sim::EventType ) * 8

  for (let bit = 0; bit < nbits; bit++) {
    const type: EventType = (1 << bit) | 0;
    if (eventTypes & type) {
      let list = eventRegistry.get(type);
      if (!list) {
        list = [];
        eventRegistry.set(type, list);
      }
      list.push(logger);
    }
  }

  registeredEvents |= eventTypes;
}

/** Every logger that has registered for `eventType`, in registration order. */
export function loggersFor(eventType: EventType): readonly RegisteredLogger[] {
  return eventRegistry.get(eventType) ?? [];
}

/**
 * Native `Logs::postEvent( const T &e )`:
 *
 *   if( _registeredEvents & e.getType() )
 *     itfor( LoggerList, _eventRegistry[ e.getType() ], it )
 *       (*it)->processEvent( e );
 */
export function postEvent(event: SimEvent): void {
  if ((registeredEvents & event.type) === 0) return;
  for (const logger of loggersFor(event.type)) logger.processEvent(event);
}

/** Native `Logs::getMaxOpenFiles()` — the sum over every installed logger. */
export function maxOpenFiles(): number {
  let total = 0;
  for (const logger of installedLoggers) total += logger.getMaxOpenFiles();
  return total;
}

/** The installed loggers, in install order (native `_installedLoggers`). */
export function installed(): readonly RegisteredLogger[] {
  return installedLoggers;
}

/** The registered-event mask (native `_registeredEvents`). */
export function registeredEventMask(): EventType {
  return registeredEvents;
}

/**
 * Native `Logs::Logs`' prologue: `_registeredEvents = 0`. The installed list survives (native
 * only clears it in `~Logs`), so a second `Logs` in one process starts with the recorders of
 * the first still installed — exactly native's behaviour, and why the port's `Logs.dispose()`
 * exists (native `~Logs` clears `_installedLoggers`).
 */
export function resetEventMask(): void {
  registeredEvents = Event_None;
}

/** Native `Logs::~Logs`: `_installedLoggers.clear()`. */
export function clearInstalledLoggers(): void {
  installedLoggers.length = 0;
}

/**
 * Test hook: back to the process's t0 state (nothing installed, nothing registered). A test
 * that builds more than one `Logs` needs this between runs; in a real run `Logs` is
 * constructed once and `dispose()` does the clearing.
 */
export function resetRegistry(): void {
  clearInstalledLoggers();
  resetEventMask();
  eventRegistry.clear();
}
