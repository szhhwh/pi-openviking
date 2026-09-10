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
import { createLogger } from "./shared/debug-log.mjs";
import { loadConfigFromModuleUrl, saveConfigFromModuleUrl, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { RecallLedger } from "./shared/recall-ledger.mjs";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools } from "./tools.js";
import { createTakeoverManager } from "./takeover.js";
import { openVikingSettings } from "./settings.js";

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled) return;

  // Env overrides

  // --- Initialize modules ---
  const client = new OVClient(config);
  const sync = new SyncManager(client, config);
  const recall = new RecallManager(
    client,
    config,
    () => sync.sessionId,
    // The ledger keeps request prefixes byte-stable for provider prompt
    // caches (#4137); it is per pi session and opened once the id is known.
    config.recallLedger ? new RecallLedger() : null,
  );
  const logger = createLogger("pi", {
    debug: Boolean(config.debugLogPath),
    debugLogPath: config.debugLogPath,
  });
  const takeover = createTakeoverManager({
    pi, client, sync, config,
    log: (message: string) => logger.log("takeover", message),
  });

  // Session state
  let connected = false;
  let bypassed = false;
  let profileBlock = "";
  let archiveOverview = "";
  let toolsRegistered = false;
  let compacted = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  // Session-scoped switch (/viking recall, settings page): when true, no
  // <openviking-context> blocks are injected — recall search, profile and
  // archive overview are all gated. Sync and takeover keep running.
  let recallDisabled = false;

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      // Bypass check
      const cwd = process.cwd();
      for (const pattern of config.bypassPatterns) {
        if (matchBypass(cwd, pattern)) {
          bypassed = true;
          started = true;
          return;
        }
      }

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
      updateStatus(ctx, connected, 0, sync.sessionId, config, takeover.state, recallDisabled);

      started = true;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
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
    // session_start doesn't fire for pi -c continuations.
    await start(ctx);

    if (!connected || bypassed) return;

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    if (!recallDisabled) {
      recall.queueSearch(event.prompt);
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
      systemPrompt: event.systemPrompt + "\n\n" + additions,
    };
  });

  // --- context ---
  pi.on("context", async (event, ctx) => {
    if (!connected || bypassed) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    // ctx.signal wires Esc to the retrieval chain: an abort cancels in-flight
    // fetches (AbortSignal.any in OVClient) and skips injection for the turn.
    if (!recallDisabled) {
      await recall.searchPending(ctx?.signal);
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

  // --- turn_end ---
  pi.on("turn_end", async (event, ctx) => {
    if (!connected || bypassed || !config.syncTurns) return;

    const branch = ctx.sessionManager.getBranch();
    const result = await sync.syncBranch(branch);
    logger.log("turn_end", { added: result.added, tokens: result.tokens });
    await takeover.onTurnSynced(result.tokens);
    updateStatus(ctx, connected, result.added, sync.sessionId, config, takeover.state, recallDisabled);
  });

  // --- session_before_compact ---
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!connected || bypassed) return;

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
    if (!connected || bypassed) return;

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

  const refreshStatus = (ctx: any) =>
    updateStatus(ctx, connected, sync.syncedCount, sync.sessionId, config, takeover.state, recallDisabled);

  pi.registerCommand("viking", {
    description: "OpenViking: status, commit, settings, recall [on|off]",
    getArgumentCompletions: (prefix: string) => {
      const items: Array<{ value: string; label: string; description?: string }> = [];
      const push = (value: string, label: string, description: string) =>
        items.push({ value, label, description });

      const trimmed = prefix.trim();
      const endsSpace = /\s$/.test(prefix);
      const words = trimmed ? trimmed.split(/\s+/) : [];

      // "/viking <tab>" → all subcommands
      if (words.length === 0) {
        push("commit", "commit", "force a memory commit now");
        push("settings", "settings", "open the settings page");
        push("recall", "recall", "toggle context injection [on|off]");
        return items;
      }

      const first = words[0];
      const isRecall = ["recall", "inject", "injection"].includes(first);

      // Second-level: "/viking recall [on|off]"
      if (isRecall) {
        const partial = words.length === 1 && !endsSpace ? "" : (words[1] ?? "");
        if (words.length <= 2) {
          if ("on".startsWith(partial)) push(`${first} on`, "on", "re-enable context injection");
          if ("off".startsWith(partial)) push(`${first} off`, "off", "pause context injection (session only)");
        }
        return items.length ? items : null;
      }

      // First-level: completing the subcommand word itself
      if (words.length === 1 && !endsSpace) {
        const subs: Array<[string, string]> = [
          ["commit", "force a memory commit now"],
          ["settings", "open the settings page"],
          ["recall", "toggle context injection [on|off]"],
        ];
        for (const [word, desc] of subs) {
          if (word.startsWith(first)) push(word, word, desc);
        }
      }
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (!connected) {
        ctx.ui.notify("OpenViking: not connected", "warning");
        return;
      }

      const trimmed = (args ?? "").trim();
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim().toLowerCase();

      // --- /viking commit ---
      if (cmd === "commit") {
        await sync.shutdown();
        const commitResult = config.takeoverEnabled ? null : await sync.commit();
        const ok = config.takeoverEnabled
          ? await takeover.commitAndAdvance()
          : commitResult !== null;
        if (ok) {
          ctx.ui.notify(
            "OpenViking: committed successfully" +
              (commitResult?.trace_id ? ` (trace_id=${commitResult.trace_id})` : ""),
            "info",
          );
        } else {
          ctx.ui.notify("OpenViking: commit failed", "error");
        }
        refreshStatus(ctx);
        return;
      }

      // --- /viking settings ---
      if (cmd === "settings" || cmd === "config") {
        await openVikingSettings(ctx, {
          config,
          connected,
          sessionId: sync.sessionId,
          recallDisabled,
          onRecallToggle: (disabled) => {
            recallDisabled = disabled;
            refreshStatus(ctx);
          },
          onPersist: (cfg) => {
            const ok = saveConfigFromModuleUrl(import.meta.url, cfg);
            refreshStatus(ctx); // reflect threshold/injection changes in the footer immediately
            return ok;
          },
        });
        return;
      }

      // --- /viking recall [on|off] (temporary context-injection switch) ---
      if (cmd === "recall" || cmd === "inject" || cmd === "injection") {
        const target = rest === "on" ? false : rest === "off" ? true : !recallDisabled;
        if (target === recallDisabled && (rest === "on" || rest === "off")) {
          ctx.ui.notify(`OpenViking: context injection is already ${rest}.`, "info");
          return;
        }
        recallDisabled = target;
        refreshStatus(ctx);
        ctx.ui.notify(
          recallDisabled
            ? "OpenViking: context injection OFF for this session — no <openviking-context> blocks (recall, profile, archive overview) will be injected. Sync and takeover keep running. '/viking recall on' re-enables."
            : "OpenViking: context injection ON — memory recall is active again.",
          "info",
        );
        return;
      }

      // --- status (default) ---
      // Note: info notify maps to a transient status toast that the next
      // notify replaces, so status + subcommand hint must be a single message.
      const sid = sync.sessionId ?? "none";
      const t = takeover.state;
      const takeoverInfo = config.takeoverEnabled
        ? ` | takeover: ${t.coveredUserTurns}/${t.lastSeenUserTurns} turns archived, ~${t.pendingTokens} tokens pending`
        : "";
      ctx.ui.notify(
        `OpenViking: ${connected ? "connected" : "disconnected"} | session: ${sid.slice(0, 12)}... | injection: ${recallDisabled ? "off" : "on"}${takeoverInfo}` +
          ` | /viking commit · settings · recall [on|off]`,
        "info",
      );
    },
  });
}

// ================================================================
// Helper Functions
// ================================================================

/** Simple bypass pattern matching (prefix and glob). */
function matchBypass(cwd: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    return cwd.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return cwd.startsWith(pattern.slice(0, -1));
  }
  return cwd === pattern || cwd.startsWith(pattern + "/");
}

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: any, options?: any) => client.fetchJSON(path, init, 10000),
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
  added: number,
  sessionId: string | null,
  config: OVConfig,
  takeoverState?: { pendingTokens?: number; coveredUserTurns?: number; lastSeenUserTurns?: number },
  recallDisabled = false,
): void {
  const setter = ctx?.ui?.setStatus;
  if (typeof setter !== "function") return;
  try {
    const sb = config.statusBar;
    if (!sb?.enabled) {
      setter("openviking", undefined); // remove the footer segment entirely
      return;
    }

    const sep = statusColor("dim", " · ");
    const parts: string[] = [];

    // Brand + connection dot (always present when the bar is enabled)
    parts.push(
      statusColor("accent", "OV") +
        (connected ? statusColor("success", " ●") : statusColor("error", " ○")),
    );

    // Synced entries this session
    if (sb.showSync && added > 0) {
      parts.push(`${statusColor("dim", "⇅")}${added}`);
    }

    // Takeover progress: covered/seen user turns + token pressure vs threshold
    if (sb.showTakeover && config.takeoverEnabled && takeoverState) {
      const covered = takeoverState.coveredUserTurns ?? 0;
      const seen = takeoverState.lastSeenUserTurns ?? 0;
      const pendingTokens = takeoverState.pendingTokens ?? 0;
      if (seen > 0) {
        parts.push(`${statusColor("dim", "ctx")} ${covered}/${seen}`);
      }
      if (pendingTokens > 0) {
        parts.push(
          `${humanizeTokens(pendingTokens)}${statusColor("dim", `/${humanizeTokens(config.takeoverTokenThreshold)}`)}`,
        );
      }
    }

    // Session-scoped injection pause
    if (sb.showInjection && recallDisabled) {
      parts.push(statusColor("warning", "⏸inj"));
    }

    // Session id tail
    if (sb.showSession && sessionId) {
      parts.push(statusColor("dim", `${sessionId.slice(0, 8)}…`));
    }

    setter("openviking", parts.join(sep));
  } catch {
    // Best effort; pi API shape may vary across fast-moving versions.
  }
}
