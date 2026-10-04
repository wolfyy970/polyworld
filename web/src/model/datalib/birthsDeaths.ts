/**
 * Lane W1c — the `run/BirthsDeaths.log` line format (`Logs::BirthsDeathsLog`,
 * `src/library/logs/Logs.cc:391`).
 *
 * The card's acceptance names this file next to `lifespans.txt`, so its format lives here
 * with the rest of the log-format surface. It is *not* a datalib file — native writes it
 * with a bare `fprintf` per event:
 *
 *   % Timestep Event Agent# Parent1 Parent2\n      (header, written once at init)
 *   <step> BIRTH <agent> <parent1> <parent2>\n     BR_NATURAL | BR_LOCKSTEP
 *   <step> VIRTUAL 0 <parent1> <parent2>\n         BR_VIRTUAL (agent id 0 marks virtual)
 *   <step> CREATION <agent>\n                      BR_CREATE
 *   <step> DEATH <agent>\n                         any death reason except DR_SIMEND
 *
 * BR_SIMINIT births and DR_SIMEND deaths write nothing, which is why `microtest_voff`
 * (MaxSteps 1, everyone born at init and died at the end) records a header-only file while
 * `minitest_voff` has 62 BIRTH + 64 DEATH lines.
 *
 * PORT-NOTE(w1c/birthsdeaths-seam): the event plumbing (which agent, which reason, when)
 * belongs to the logs lane (L12) and the simulation lane (L11) that raises the events;
 * this module only owns the bytes of a line, so L12 can call it from the recorder without
 * re-deriving the format. `BirthsDeathsLog` is the thin sink-backed writer for that.
 */

import { BirthReason, DeathReason, birthReasonName, deathReasonName } from '../types/lifespan';
import { encodeLatin1, type ByteSink } from './sink';

/** Native `fprintf( getFile(), "%% Timestep Event Agent# Parent1 Parent2\n" )`. */
export const BIRTHS_DEATHS_HEADER = '% Timestep Event Agent# Parent1 Parent2\n';

/** Native `Logs::BirthsDeathsLog::processEvent( const AgentBirthEvent & )`. */
export function formatBirthLine(
  step: number,
  reason: BirthReason,
  agentNumber: number,
  parent1: number,
  parent2: number,
): string {
  switch (reason) {
    case BirthReason.SIMINIT:
      return '';
    case BirthReason.NATURAL:
    case BirthReason.LOCKSTEP:
      return `${step} BIRTH ${agentNumber} ${parent1} ${parent2}\n`;
    case BirthReason.VIRTUAL:
      // native prints a literal 0 for the agent number: agent ids start at 1, so 0 marks
      // a virtual birth
      return `${step} VIRTUAL 0 ${parent1} ${parent2}\n`;
    case BirthReason.CREATE:
      return `${step} CREATION ${agentNumber}\n`;
    default:
      // native `assert( false )` for BR_INVALID / an out-of-range reason
      throw new Error(`datalib: no BirthsDeaths.log line for birth reason ${birthReasonName(reason)}`);
  }
}

/**
 * Native `Logs::BirthsDeathsLog::processEvent( const AgentDeathEvent & )` — every reason
 * except `DR_SIMEND` writes a line (native does not switch on the reason here, so an
 * unexpected reason still logs).
 */
export function formatDeathLine(step: number, reason: DeathReason, agentNumber: number): string {
  if (reason === DeathReason.SIMEND) return '';
  return `${step} DEATH ${agentNumber}\n`;
}

/** Native `Logs::BirthsDeathsLog`: the header at init, one line per recorded event. */
export class BirthsDeathsLog {
  private readonly sink: ByteSink;
  private written = 0;
  private closed = false;

  constructor(sink: ByteSink) {
    this.sink = sink;
    this.writeLine(BIRTHS_DEATHS_HEADER);
    this.written = 0; // the header is not an event line
  }

  /** Lines written so far (events that produced no line are not counted). */
  lineCount(): number {
    return this.written;
  }

  /** Native `processEvent( const AgentBirthEvent &e )`. */
  birth(step: number, reason: BirthReason, agentNumber: number, parent1: number, parent2: number): void {
    this.writeLine(formatBirthLine(step, reason, agentNumber, parent1, parent2));
  }

  /** Native `processEvent( const AgentDeathEvent &e )`. */
  death(step: number, reason: DeathReason, agentNumber: number): void {
    this.writeLine(formatDeathLine(step, reason, agentNumber));
  }

  flush(full = false): void {
    this.sink.flush(full);
  }

  /** Native `FileLogger::~FileLogger`'s `fclose`. */
  close(): void {
    if (this.closed) return;
    this.sink.close();
    this.closed = true;
  }

  private writeLine(line: string): void {
    if (line === '') return;
    this.sink.write(encodeLatin1(line));
    this.written++;
  }
}

/** Reason names as they appear in a log line (re-exported for loggers and tests). */
export { birthReasonName, deathReasonName };
