/**
 * Pi OpenViking Extension
 *
 * Integrates pi with an OpenViking context database for persistent,
 * cross-session memory. Syncs conversation turns to OV, recalls
 * relevant memories on each prompt, and commits sessions for long-term
 * memory extraction.
 *
 * Design informed by: OpenClaw (synchronous recall), Claude Code plugin
 * (most mature, production-hardened), Hermes (anti-pattern: stale prefetch).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCaptureEnabled } from "./shared/capture-utils.mjs";
import { createDynamicLogger } from "./lib/dynamic-logger.mjs";
import { getAgentPrompt, appendSystemPrompt } from "./lib/host-events.mjs";
import { loadEffectiveConfig, saveConfig, type OVConfig } from "./config.js";
import { listPending } from "./shared/pending-queue.mjs";
import { OVClient } from "./client.js";
import type { OvHttpRequestOptions } from "./client.js";
import { RecallManager } from "./recall.js";
import { RecallLedger } from "./lib/recall-ledger.mjs";
import { RecallProgress } from "./progress.js";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { isBypassed } from "./shared/session-model.mjs";
import { guardVikingUriToolCall, noticeVikingUriToolResult } from "./lib/uri-guard-adapter.mjs";
import { registerTools } from "./tools.js";
import { createTakeoverManager } from "./takeover.js";
import { openVikingSettings } from "./settings.js";

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadEffectiveConfig();

  // --- Initialize modules ---
  const client = new OVClient(config);
  const sync = new SyncManager(client, config);
  const recall = new RecallManager(
    client,
    config,
    () => sync.sessionId,
    // The ledger keeps request prefixes byte-stable for provider prompt
    // caches (#4137). It is always constructed and opened once the session id
    // is known; RecallManager gates replay on the live config so the panel can
    // switch it off without restarting.
    new RecallLedger(),
  );
  const logger = createDynamicLogger("pi", () => config.debugLogPath);
  const takeover = createTakeoverManager({
    pi, client, sync, config,
    log: (message: string) => logger.log("takeover", message),
  });

  // Session state
  let connected = false;
  const bypassedNow = () => isBypassed(config, { cwd: process.cwd() });
  let profileBlock = "";
  let archiveOverview = "";
  let toolsRegistered = false;
  let compacted = false;
  let started = false;
  let startFinished = false;
  let startPromise: Promise<void> | null = null;
  // Session-scoped switch (/viking recall, settings page): when true, no
  // <openviking-context> blocks are injected — recall search, profile and
  // archive overview are all gated. Sync and takeover keep running.
  let recallDisabled = false;

  // The footer shows pressure against whichever threshold currently applies:
  // takeover's own counter while takeover owns the boundary, the server's
  // pending_tokens otherwise (TakeoverCore never accumulates when disabled).
  const statusState = () => ({
    ...takeover.state,
    pendingTokens: config.takeoverEnabled ? takeover.state.pendingTokens : sync.pendingTokens,
  });

  // Live progress for the two waits that sit between "user pressed enter" and
  // the provider request: the first-turn startup chain and each recall search.
  // Only the working row reports it (`⠋ [2s]`); the footer segment is reserved
  // for standing state, so this never triggers a status refresh.
  const progress = new RecallProgress();

  const refreshStatus = (ctx: any) =>
    updateStatus(
      ctx, connected, sync.syncedCount, sync.sessionId, config,
      statusState(), recallDisabled,
    );

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startFinished = false;
    startPromise = (async () => {
      // Health check
      connected = await client.health();
      if (!connected) {
        if (config.logLevel === "info") {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        return;
      }

      // Ensure OV session
      const piSessionId = ctx.sessionManager.getSessionId();
      recall.openLedger(piSessionId);
      const ok = await sync.ensureSession(piSessionId);
      if (!ok) {
        if (config.logLevel !== "silent") {
          ctx.ui.notify("OpenViking: failed to create session", "error");
        }
        return;
      }
      await sync.replayPending();

      // Profile injection
      profileBlock = await buildSessionProfileBlock(client, config);

      const branch = typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
      if (config.takeoverEnabled) {
        takeover.restore(branch);
        sync.restoreWatermark(takeover.state.syncedEntryCount);
      } else if (sync.sessionId) {
        // Resume rehydration — fetch archive overview if session was previously committed.
        archiveOverview = await fetchArchiveOverview(client, sync.sessionId, config);
      }

      // Register tools (also needed for pi -c continuations).
      if (!toolsRegistered) {
        registerTools(pi, client, sync);
        toolsRegistered = true;
      }
      updateStatus(ctx, connected, sync.syncedCount, sync.sessionId, config, statusState(), recallDisabled);

      started = true;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
      startFinished = true;
    });

    return startPromise;
  };

  // --- session_start ---
  pi.on("session_start", async (event, ctx) => {
    // Capture the live TUI theme (colors for the footer status bar) before
    // any updateStatus call. setWidget runs its factory synchronously with
    // the real theme instance; the probe renders zero lines and is removed
    // immediately, so it never becomes visible.
    captureStatusTheme(ctx);

    // Fire-and-forget: the OV chain (health check, session ensure, profile
    // build) costs ~2s against the remote server; blocking session_start on it
    // delays every pi startup. start() is memoized via startPromise, so
    // before_agent_start awaits the same in-flight chain before the first
    // provider request — the first turn still gets profile + recall.
    void start(ctx).catch((error) => {
      logger.logError("session_start", error);
    });
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event, ctx) => {
    // session_start doesn't fire for pi -c continuations. The first turn also
    // awaits the startup chain; report it while the working row cannot yet.
    // A bypassed workspace gets no OpenViking feedback even though startup runs.
    const showStartupProgress = !started && !bypassedNow();
    if (showStartupProgress) progress.begin(ctx, "connect");
    try {
      await start(ctx);
    } finally {
      if (showStartupProgress) progress.end("connect");
    }

    if (!connected || bypassedNow()) return;

    // Queue recall for the context hook, after the host renders the prompt.
    // Pi has user/custom variants; oh-my-pi supplies prompt without messageType.
    const prompt = getAgentPrompt(event);
    if (!recallDisabled && prompt) {
      recall.queueSearch(prompt);
    }

    // Compose system prompt additions
    const parts: string[] = [];
    if (!recallDisabled) {
      if (profileBlock) parts.push(profileBlock);
      if (!config.takeoverEnabled && archiveOverview && (compacted || archiveOverview.trim())) {
        parts.push(archiveOverview);
      }
    }
    parts.push("OpenViking tools: viking_search, viking_read, viking_browse, viking_remember, viking_forget, viking_add_resource, viking_archive_expand.");

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: appendSystemPrompt(event.systemPrompt, additions),
    };
  });

  // --- context ---
  pi.on("context", async (event, ctx) => {
    if (!connected || bypassedNow()) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    // ctx.signal wires Esc to the retrieval chain: an abort cancels in-flight
    // fetches (AbortSignal.any in OVClient) and skips injection for the turn.
    if (!recallDisabled) {
      await recall.searchPending(ctx?.signal, {
        onStart: () => progress.begin(ctx, "recall"),
        onEnd: () => progress.end("recall"),
      });
    }

    // The entry IDs are an optional optimization for replaying the recall
    // ledger. Compatible hosts may omit buildContextEntries(), so fail closed
    // to nullable IDs rather than guessing from another SessionManager API.
    const sessionManager = ctx.sessionManager;
    const entries = typeof sessionManager?.buildContextEntries === "function"
      ? sessionManager.buildContextEntries()
      : [];
    const userEntryIds = entries
      .filter((entry: unknown): entry is { id?: unknown; type: "message"; message: { role: "user" } } => {
        if (!entry || typeof entry !== "object") return false;
        if (!("type" in entry) || !("message" in entry)) return false;
        const type = entry.type;
        const message = entry.message;
        return type === "message" &&
          !!message &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "user";
      })
      .map((entry): string | undefined =>
        typeof entry.id === "string" ? entry.id : undefined
      );
    const messageIds = new WeakMap<object, string>();
    let userIndex = 0;
    for (const message of event.messages as any[]) {
      if (message?.role !== "user") continue;
      const entryId = userEntryIds[userIndex++];
      if (entryId && typeof message === "object") {
        messageIds.set(message, entryId);
      }
    }

    const afterTakeover = config.takeoverEnabled
      ? takeover.transformContext(event.messages as any)
      : event.messages;
    const messages = recallDisabled
      ? afterTakeover
      : recall.injectRecall(
          afterTakeover,
          (message) => messageIds.get(message) ?? null,
        );
    return { messages };
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  });

  // --- tool_result ---
  pi.on("tool_result", async (event, _ctx) => {
    const notice = noticeVikingUriToolResult(event);
    if (!notice) return;
    return notice;
  });

  // --- turn_end ---
  pi.on("turn_end", async (event, ctx) => {
    if (!connected || bypassedNow() || !isCaptureEnabled(config)) return;

    const branch = ctx.sessionManager.getBranch();
    const result = await sync.syncBranch(branch);
    logger.log("turn_end", { added: result.added, tokens: result.tokens });
    await takeover.onTurnSynced(result.tokens);
    refreshStatus(ctx);
  });

  // --- session_before_compact ---
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!connected || bypassedNow()) return;

    if (config.takeoverEnabled) {
      const prep = (event as any)?.preparation ?? {};
      return await takeover.handleBeforeCompact({
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore ?? 0,
      });
    }

    const archiveId = await sync.commit();
    compacted = true;

    // Cache archive overview for rehydration after compaction
    if (archiveId && sync.sessionId) {
      archiveOverview = await fetchArchiveOverview(
        client, sync.sessionId, config,
      );
    }
    // Return nothing → pi proceeds with default compaction
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    progress.dispose();
    if (!connected || bypassedNow()) return;

    await sync.shutdown();
    if (config.takeoverEnabled) {
      await takeover.shutdown();
    } else {
      await sync.commit();
    }
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event, _ctx) => {
    recall.invalidate();
  });

  // ================================================================
  // Commands
  // ================================================================

  const commitNow = async (): Promise<{ ok: boolean; detail?: string }> => {
    if (!connected) return { ok: false, detail: "not connected" };
    await sync.shutdown();
    if (config.takeoverEnabled) {
      return { ok: await takeover.commitAndAdvance() };
    }
    const result = await sync.commit();
    return result
      ? { ok: true, detail: result.trace_id ? `trace_id=${result.trace_id}` : undefined }
      : { ok: false };
  };

  const collectDiagnostics = async () => {
    let pendingCount = 0;
    try {
      pendingCount = (await listPending()).length;
    } catch {
      // An unreadable queue reads as empty here; the full doctor covers
      // directory-level problems.
    }
    const state = takeover.state;
    return {
      connected,
      endpoint: config.endpoint,
      authMode: config.authMode,
      sessionId: sync.sessionId,
      peerId: config.peerId,
      recallScope: config.recallPeerScope,
      syncedEntries: sync.syncedCount,
      pendingCount,
      debugLogPath: config.debugLogPath,
      takeoverEnabled: config.takeoverEnabled,
      takeoverCovered: state.coveredUserTurns,
      takeoverSeen: state.lastSeenUserTurns,
      pendingTokens: state.pendingTokens,
      starting: !started && !startFinished,
    };
  };

  pi.registerCommand("viking", {
    description: "OpenViking: open the settings, diagnostics and session actions panel",
    handler: async (_args, ctx) => {
      const snapshot = await collectDiagnostics();
      await openVikingSettings(ctx, {
        config,
        snapshot,
        recallDisabled,
        onRecallToggle: (disabled) => {
          recallDisabled = disabled;
          refreshStatus(ctx);
        },
        onCommit: commitNow,
        onPersist: (cfg, key) => {
          const ok = saveConfig(cfg, [key]);
          refreshStatus(ctx);
          return ok;
        },
      });
    },
  });
}

// ================================================================
// Helper Functions
// ================================================================

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: RequestInit, options?: OvHttpRequestOptions) =>
        client.fetchJSON(path, init, options),
      config.profileTokenBudget,
      config.peerId,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/** Fetch archive overview for rehydration using the session context API. */
async function fetchArchiveOverview(
  client: OVClient, sessionId: string, config: OVConfig,
): Promise<string> {
  try {
    const ctx = await client.getSessionContext(sessionId, config.resumeContextBudget);
    if (!ctx || !ctx.latest_archive_overview) return "";

    return [
      '<openviking-context source="session-archive">',
      "<session-archive>",
      ctx.latest_archive_overview,
      "</session-archive>",
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Live TUI theme captured once at session start (see captureStatusTheme).
 * When unavailable (non-TUI hosts), statusColor falls back to raw ANSI.
 */
let statusTheme: any = null;

type StatusColor = "success" | "error" | "warning" | "dim" | "accent";

const RAW_ANSI: Partial<Record<StatusColor, string>> = {
  success: "\x1b[32m",
  error: "\x1b[31m",
  warning: "\x1b[33m",
  dim: "\x1b[2m",
  accent: "\x1b[1;36m",
};

function statusColor(color: StatusColor, text: string): string {
  try {
    if (statusTheme?.fg) return statusTheme.fg(color, text);
  } catch {
    // theme not initialized — fall through to raw ANSI
  }
  const code = RAW_ANSI[color];
  return code ? `${code}${text}\x1b[0m` : text;
}

/** Compact token counts for the footer: 950, 9.5k, 30k, 1.2M. */
function humanizeTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * Capture the TUI theme via a zero-height widget probe: setWidget runs its
 * factory synchronously with the real theme instance. The probe renders no
 * lines and is removed immediately, so it never becomes visible.
 */
function captureStatusTheme(ctx: any): void {
  if (statusTheme) return;
  const setWidget = ctx?.ui?.setWidget;
  if (typeof setWidget !== "function") return;
  try {
    setWidget("openviking-theme-probe", (_tui: any, theme: any) => {
      statusTheme = theme;
      return { render: () => [], invalidate() {} };
    });
    setWidget("openviking-theme-probe", undefined);
  } catch {
    // Non-TUI host — raw ANSI fallback applies.
  }
}

export function updateStatus(
  ctx: any,
  connected: boolean,
  synced: number,
  sessionId: string | null,
  config: OVConfig,
  takeoverState?: { pendingTokens?: number; coveredUserTurns?: number; lastSeenUserTurns?: number },
  recallDisabled = false,
): void {
  const setter = ctx?.ui?.setStatus;
  if (typeof setter !== "function") return;
  try {
    const level = config.statusBarLevel;
    if (level === "hidden") {
      setter("openviking", undefined); // remove the footer segment entirely
      return;
    }

    const sep = statusColor("dim", " · ");
    const parts: string[] = [
      statusColor("accent", "OV") +
        (connected ? statusColor("success", " ●") : statusColor("error", " ○")),
    ];

    // One denominator: takeover pressure while takeover owns the boundary,
    // commit pressure otherwise. Two unexplained token pairs was the old bug.
    const threshold = config.takeoverEnabled
      ? config.takeoverTokenThreshold
      : config.commitTokenThreshold;
    const pressure = takeoverState?.pendingTokens ?? 0;
    const near = threshold > 0 && pressure >= threshold * 0.8;

    if (level === "minimal") {
      if (recallDisabled) parts.push(statusColor("warning", "⏸"));
      if (near) parts.push(statusColor("warning", "⚠"));
      setter("openviking", parts.join(sep));
      return;
    }

    // Session watermark, not last turn's delta: one meaning across refreshes.
    if (synced > 0) {
      parts.push(`${statusColor("dim", "⇅")}${synced}`);
    }

    if (config.takeoverEnabled && takeoverState) {
      const covered = takeoverState.coveredUserTurns ?? 0;
      const seen = takeoverState.lastSeenUserTurns ?? 0;
      if (seen > 0) {
        parts.push(
          level === "verbose"
            ? `${statusColor("dim", "ctx")} ${covered}/${seen}`
            : `${covered}/${seen}`,
        );
      }
    }

    if (pressure > 0) {
      parts.push(
        `${near ? statusColor("warning", humanizeTokens(pressure)) : humanizeTokens(pressure)}` +
          statusColor("dim", `/${humanizeTokens(threshold)}`),
      );
    }

    if (recallDisabled) parts.push(statusColor("warning", "⏸inj"));

    if (level === "verbose" && sessionId) {
      parts.push(statusColor("dim", `${sessionId.slice(0, 8)}…`));
    }

    setter("openviking", parts.join(sep));
  } catch {
    // Best effort; pi API shape may vary across fast-moving versions.
  }
}
