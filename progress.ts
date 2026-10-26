/**
 * Progress feedback for the OpenViking request path.
 *
 * Two phases can delay the model request after the user submits a prompt:
 * the startup chain (`session_start` connectivity/session/profile) that
 * `before_agent_start` awaits on the first turn, and the recall retrieval that
 * runs in the `context` hook. Both used to be invisible: the footer kept
 * showing the last known numbers and the working row kept saying "Working", so
 * a slow server looked like a hang.
 *
 * The reporter drives two surfaces at once:
 *   - the working row (`setWorkingMessage`), where the spinner carries the
 *     activity and the message is just the elapsed seconds;
 *   - the OpenViking footer segment, which leads with a clock glyph and the
 *     same seconds and stays visible even when the working row is hidden.
 *
 * The footer is always rendered by `updateStatus`; this module only owns the
 * live phase/elapsed state and refreshes once a second while a phase is in
 * flight.
 */

export type RecallPhase = "connect" | "recall";

export interface ProgressSnapshot {
  phase: RecallPhase;
  /** Milliseconds since the phase began; feeds the elapsed-seconds label. */
  elapsedMs: number;
}

const TICK_MS = 1000;

/**
 * Shared label for both surfaces: seconds only, so the working row stays
 * `⠋ 2s` instead of a sentence. Kept beside the reporter so the footer and the
 * working message never drift.
 */
export function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(Math.max(0, elapsedMs) / 1000)}s`;
}

export class RecallProgress {
  private phase: RecallPhase | null = null;
  /** Re-entrancy for overlapping handlers of the same phase. */
  private depth = 0;
  private startedAt = 0;
  private workingLabel = "";
  private ticker: ReturnType<typeof setInterval> | undefined;
  private ctx: any = null;
  private readonly onChange: (
    snapshot: ProgressSnapshot | null,
    ctx: any,
  ) => void;

  constructor(
    onChange: (snapshot: ProgressSnapshot | null, ctx: any) => void,
  ) {
    this.onChange = onChange;
  }

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
    this.notify();
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

  /** Live snapshot for callers that render the footer on demand. */
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
    this.notify();
    this.ctx = null;
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (!this.phase) return;
      this.setWorkingLabel();
      this.notify();
    }, TICK_MS);
    // Never hold the process open for a UI refresh (print/SDK modes).
    (this.ticker as any)?.unref?.();
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private notify(): void {
    try {
      this.onChange(this.snapshot(), this.ctx);
    } catch {
      // UI feedback is best effort; a host API change must not break recall.
    }
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
      // Non-TUI hosts: the footer path is already a no-op there.
    }
  }
}
