/**
 * Progress feedback for the OpenViking request path.
 *
 * Two phases can delay the model request after the user submits a prompt:
 * the startup chain (`session_start` connectivity/session/profile) that
 * `before_agent_start` awaits on the first turn, and the recall retrieval that
 * runs in the `context` hook. Both used to be invisible: the working row kept
 * saying "Working", so a slow server looked like a hang.
 *
 * The reporter owns one surface: the working row (`setWorkingMessage`), where
 * pi's own spinner carries the activity and the message is just the bracketed
 * elapsed time (`⠋ [2s]`). The brackets are the whole distinction — a bare
 * number would read like a stray token next to the spinner, and a label would
 * reintroduce the sentence this replaced. The footer stays out of it: the
 * OpenViking status segment shows standing state only, never a moving clock.
 *
 * The reporter refreshes once a second while a phase is in flight.
 */

export type RecallPhase = "connect" | "recall";

export interface ProgressSnapshot {
  phase: RecallPhase;
  /** Milliseconds since the phase began; feeds the elapsed-time label. */
  elapsedMs: number;
}

const TICK_MS = 1000;

/**
 * Working-row label: `[2s]`, escalating to `[1m15s]` past a minute so a long
 * startup chain or slow server stays readable. The brackets are the visual
 * marker for "OpenViking is waiting", so they wrap both forms.
 */
export function formatElapsed(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (total < 60) return `[${total}s]`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `[${minutes}m${seconds}s]`;
}

export class RecallProgress {
  private phase: RecallPhase | null = null;
  /** Re-entrancy for overlapping handlers of the same phase. */
  private depth = 0;
  private startedAt = 0;
  private workingLabel = "";
  private ticker: ReturnType<typeof setInterval> | undefined;
  private ctx: any = null;

  /** Enter a phase. Same-phase entries nest; `connect` never interrupts `recall`. */
  begin(ctx: any, phase: RecallPhase): void {
    if (this.phase === phase) {
      this.depth++;
      return;
    }
    if (this.phase === "recall" && phase === "connect") return;

    this.phase = phase;
    this.depth = 1;
    this.startedAt = Date.now();
    this.ctx = ctx;
    this.setWorkingLabel();
    this.startTicker();
  }

  /**
   * Leave a phase. `phase` is the phase the caller entered; a mismatched phase
   * (for example a late `connect` end after recall began) is ignored. Nested
   * entries must all leave before the progress clears.
   */
  end(phase: RecallPhase): void {
    if (this.phase !== phase) return;
    if (this.depth > 1) {
      this.depth--;
      return;
    }
    this.clear();
  }

  /** Live snapshot for callers that report the phase. */
  snapshot(): ProgressSnapshot | null {
    return this.phase
      ? { phase: this.phase, elapsedMs: Date.now() - this.startedAt }
      : null;
  }

  /** Drop any in-flight phase (session shutdown, reload). Idempotent. */
  dispose(): void {
    this.clear();
  }

  private clear(): void {
    const hadPhase = this.phase !== null;
    this.phase = null;
    this.depth = 0;
    this.stopTicker();
    if (!hadPhase) {
      this.ctx = null;
      return;
    }
    this.setWorkingMessage(undefined);
    this.workingLabel = "";
    this.ctx = null;
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (!this.phase) return;
      this.setWorkingLabel();
    }, TICK_MS);
    // Never hold the process open for a UI refresh (print/SDK modes).
    (this.ticker as any)?.unref?.();
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private setWorkingLabel(): void {
    const label = formatElapsed(Date.now() - this.startedAt);
    if (label === this.workingLabel) return;
    this.workingLabel = label;
    this.setWorkingMessage(label);
  }

  private setWorkingMessage(message: string | undefined): void {
    try {
      if (this.ctx?.hasUI === false) return;
      this.ctx?.ui?.setWorkingMessage?.(message);
    } catch {
      // Non-TUI hosts have no working row; feedback is best effort.
    }
  }
}
