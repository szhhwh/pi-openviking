/**
 * Interactive settings page for the OpenViking pi extension.
 *
 * Opened via `/viking settings`. Renders a full-TUI SettingsList with a
 * status header. Changes mutate the live OVConfig object in place (most
 * settings apply immediately — managers hold the config by reference) and
 * are persisted back to config.json through the onPersist callback.
 *
 * Numeric settings use submenu pickers (SelectList) so the current value is
 * always offered alongside sensible presets; boolean/enum settings cycle
 * with Enter/Space, and `/` fuzzy-filters by label.
 */

import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  SettingsList,
  Text,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { EXTENSION_VERSION, type OVConfig } from "./config.js";

export interface VikingSettingsOptions {
  config: OVConfig;
  connected: boolean;
  sessionId: string | null;
  /** Current session-scoped context-injection switch (true = disabled). */
  recallDisabled: boolean;
  /** Live toggle for the session-scoped switch. Not persisted. */
  onRecallToggle: (disabled: boolean) => void;
  /** Persist config; called after every persisted change. */
  onPersist: (config: OVConfig) => boolean;
}

/** Item id for the session-scoped injection switch (not a config.json key). */
const RECALL_INJECT_ID = "__session.context_injection";

const RECALL_INJECT_DESC =
  "Session-only (not written to config.json): when off, <openviking-context> blocks " +
  "(memory recall, profile, archive overview) are no longer injected into prompts. " +
  "Sync to OpenViking and context takeover keep running. Same as /viking recall [on|off].";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function asInt(value: string): number {
  return Math.round(Number(value));
}

/** Merge the current value into the sorted preset list so it is always pickable. */
function presetsWithCurrent(currentValue: string, defaults: number[]): number[] {
  const cur = Number(currentValue);
  const set = new Set<number>(defaults);
  if (Number.isFinite(cur)) set.add(cur);
  return [...set].sort((a, b) => a - b);
}

function numericSubmenu(defaults: number[], unit = ""): SettingItem["submenu"] {
  return (currentValue, done) => {
    const values = presetsWithCurrent(currentValue, defaults);
    const items = values.map((v) => ({
      value: String(v),
      label: `${v.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`,
    }));
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    const current = Number(currentValue);
    const idx = values.findIndex((v) => v === current);
    if (idx >= 0) list.setSelectedIndex(idx);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();
    return list;
  };
}

/** Compact summary shown as the parent item's value: "off" or "on · n/4". */
function statusBarSummary(config: OVConfig): string {
  const sb = config.statusBar;
  if (!sb?.enabled) return "off";
  const shown = [sb.showSync, sb.showTakeover, sb.showInjection, sb.showSession].filter(Boolean).length;
  return `on · ${shown}/4`;
}

/**
 * Second-level settings list for the footer status bar: master switch plus
 * per-segment visibility. Esc closes it and reports the summary back to the
 * parent item (which is display-only — mutations happen right here).
 */
function buildStatusBarSubmenu(opts: VikingSettingsOptions, theme: any): SettingItem["submenu"] {
  return (_currentValue, done) => {
    const { config } = opts;
    const apply = (id: string, on: boolean) => {
      if (id === "enabled") config.statusBar.enabled = on;
      else if (id === "showSync") config.statusBar.showSync = on;
      else if (id === "showTakeover") config.statusBar.showTakeover = on;
      else if (id === "showInjection") config.statusBar.showInjection = on;
      else if (id === "showSession") config.statusBar.showSession = on;
      else return;
      opts.onPersist(config); // persists + refreshes the footer immediately
    };

    const seg = (on: boolean) => (on ? "on" : "off");
    const items: SettingItem[] = [
      {
        id: "enabled",
        label: "show status bar",
        currentValue: seg(config.statusBar.enabled),
        values: ["on", "off"],
        description: "Master switch for the OpenViking segment in pi's footer.",
      },
      {
        id: "showSync",
        label: "⇅ synced entries",
        currentValue: seg(config.statusBar.showSync),
        values: ["on", "off"],
        description: "Show how many entries were synced to the OpenViking session so far.",
      },
      {
        id: "showTakeover",
        label: "ctx · takeover progress",
        currentValue: seg(config.statusBar.showTakeover),
        values: ["on", "off"],
        description: "Show takeover coverage (archived/seen turns) and token pressure vs the takeover threshold.",
      },
      {
        id: "showInjection",
        label: "⏸ injection pause",
        currentValue: seg(config.statusBar.showInjection),
        values: ["on", "off"],
        description: "Show the ⏸inj marker when context injection is paused via /viking recall off.",
      },
      {
        id: "showSession",
        label: "session id",
        currentValue: seg(config.statusBar.showSession),
        values: ["on", "off"],
        description: "Show the OpenViking session id (first 8 chars) at the end of the segment.",
      },
    ];

    const list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => apply(id, newValue === "on"),
      () => done(statusBarSummary(config)),
    );

    const header = new Container();
    header.addChild(new Text(theme.fg("accent", theme.bold("‹ footer status bar")), 1, 0));
    const root = new Container();
    root.addChild(header);
    root.addChild(list);
    return {
      render: (width: number) => root.render(width),
      invalidate: () => root.invalidate(),
      handleInput: (data: string) => {
        list.handleInput?.(data);
      },
    };
  };
}

function buildItems(opts: VikingSettingsOptions, theme: any): SettingItem[] {
  const { config } = opts;
  return [
    // ── Session (temporary) ──────────────────────────────────────────
    {
      id: RECALL_INJECT_ID,
      label: "session · context injection",
      currentValue: onOff(!opts.recallDisabled),
      values: ["on", "off"],
      description: RECALL_INJECT_DESC,
    },

    // ── General ──────────────────────────────────────────────────────
    {
      id: "enabled",
      label: "general · extension enabled",
      currentValue: onOff(config.enabled),
      values: ["on", "off"],
      description:
        "Master switch, persisted. When off the extension fully disables itself; " +
        "takes effect after restarting pi.",
    },

    // ── Sync & capture ───────────────────────────────────────────────
    {
      id: "syncTurns",
      label: "sync   · sync conversation turns",
      currentValue: onOff(config.syncTurns),
      values: ["on", "off"],
      description:
        "Stream every conversation turn into the OpenViking session so later commits " +
        "can extract long-term memory.",
    },
    {
      id: "captureMode",
      label: "sync   · capture mode",
      currentValue: config.captureMode,
      values: ["semantic", "keyword"],
      description:
        "semantic: server-side semantic processing of captured turns. keyword: plain keyword capture.",
    },
    {
      id: "captureToolResults",
      label: "sync   · capture tool results",
      currentValue: onOff(config.captureToolResults),
      values: ["on", "off"],
      description:
        "Also capture tool call results (bash output, file reads…). Heavier, but preserves more context for extraction.",
    },
    {
      id: "captureAssistantTurns",
      label: "sync   · capture assistant turns",
      currentValue: onOff(config.captureAssistantTurns),
      values: ["on", "off"],
      description: "Capture assistant replies in addition to user messages.",
    },

    // ── Recall (injection) ───────────────────────────────────────────
    {
      id: "recallTokenBudget",
      label: "recall · recall token budget",
      currentValue: String(config.recallTokenBudget),
      submenu: numericSubmenu([500, 1000, 2000, 3000, 4000, 8000], "tokens"),
      description:
        "Token budget for the <openviking-context> recall block injected with each prompt.",
    },
    {
      id: "scoreThreshold",
      label: "recall · min score threshold",
      currentValue: String(config.scoreThreshold),
      submenu: numericSubmenu([0.2, 0.35, 0.5, 0.65, 0.8]),
      description:
        "Minimum similarity score for a memory to be recalled. Higher = fewer, sharper matches.",
    },
    {
      id: "recallMaxContentChars",
      label: "recall · max abstract chars",
      currentValue: String(config.recallMaxContentChars),
      submenu: numericSubmenu([200, 500, 1000, 2000, 4000], "chars"),
      description: "Per-result character cap for recalled abstracts shown to the model.",
    },
    {
      id: "recallPreferAbstract",
      label: "recall · prefer abstracts",
      currentValue: onOff(config.recallPreferAbstract),
      values: ["on", "off"],
      description: "Prefer compact L0 abstracts over full content in recall results.",
    },
    {
      id: "recallQueryExpansion",
      label: "recall · query expansion",
      currentValue: config.recallQueryExpansion,
      values: ["auto", "off"],
      description:
        "Server-side query expansion before retrieval. Costs one model call of latency; auto lets the server decide.",
    },
    {
      id: "recallLedger",
      label: "recall · injection ledger",
      currentValue: onOff(config.recallLedger),
      values: ["on", "off"],
      description:
        "Replay the exact recall blocks previously sent with historical user messages so provider prompt-prefix caches keep hitting.",
    },
    {
      id: "minQueryLength",
      label: "recall · min query length",
      currentValue: String(config.minQueryLength),
      submenu: numericSubmenu([1, 3, 5, 10, 20], "chars"),
      description: "Prompts shorter than this skip the recall search entirely.",
    },

    // ── Context & profile ────────────────────────────────────────────
    {
      id: "profileTokenBudget",
      label: "ctx    · profile token budget",
      currentValue: String(config.profileTokenBudget),
      submenu: numericSubmenu([2000, 5000, 10000, 20000], "tokens"),
      description:
        "Token budget for the user-profile block injected into the system prompt at session start.",
    },
    {
      id: "resumeContextBudget",
      label: "ctx    · resume context budget",
      currentValue: String(config.resumeContextBudget),
      submenu: numericSubmenu([8000, 16000, 32000, 64000], "tokens"),
      description: "Token budget for the archive overview fetched when resuming a committed session.",
    },

    // ── Commit ───────────────────────────────────────────────────────
    {
      id: "commitTokenThreshold",
      label: "commit · auto-commit threshold",
      currentValue: String(config.commitTokenThreshold),
      submenu: numericSubmenu([10000, 20000, 30000, 50000, 100000], "tokens"),
      description:
        "Pending synced tokens that trigger an automatic session commit (memory extraction).",
    },
    {
      id: "commitKeepRecentCount",
      label: "commit · keep recent on commit",
      currentValue: String(config.commitKeepRecentCount),
      submenu: numericSubmenu([3, 5, 10, 20], "messages"),
      description: "How many recent messages stay in the live session after a commit.",
    },

    // ── Takeover ─────────────────────────────────────────────────────
    {
      id: "takeoverEnabled",
      label: "tkover · context takeover",
      currentValue: onOff(config.takeoverEnabled),
      values: ["on", "off"],
      description:
        "Represent committed history via the OpenViking archive overview instead of pi compaction. " +
        "Best applied from session start.",
    },
    {
      id: "takeoverTokenThreshold",
      label: "tkover · takeover threshold",
      currentValue: String(config.takeoverTokenThreshold),
      submenu: numericSubmenu([10000, 20000, 30000, 50000, 100000], "tokens"),
      description: "Synced-token pressure required before takeover advances the context boundary.",
    },
    {
      id: "takeoverKeepRecentTurns",
      label: "tkover · keep recent turns",
      currentValue: String(config.takeoverKeepRecentTurns),
      submenu: numericSubmenu([1, 2, 3, 5, 8], "turns"),
      description: "Recent user turns kept at full fidelity once takeover is active.",
    },
    {
      id: "takeoverOverviewBudget",
      label: "tkover · overview budget",
      currentValue: String(config.takeoverOverviewBudget),
      submenu: numericSubmenu([1000, 2000, 3000, 5000, 8000], "tokens"),
      description: "Token budget for the injected archive overview message.",
    },

    // ── Misc ─────────────────────────────────────────────────────────
    {
      id: "statusBar",
      label: "misc   · footer status bar",
      currentValue: statusBarSummary(config),
      submenu: buildStatusBarSubmenu(opts, theme),
      description:
        "Show the OpenViking segment in pi's footer (OV ● ⇅n · ctx c/l · tokens · session id). " +
        "Enter opens per-segment visibility settings.",
    },
    {
      id: "logLevel",
      label: "misc   · log level",
      currentValue: config.logLevel,
      values: ["silent", "error", "info"],
      description: "Verbosity of OpenViking UI notifications.",
    },
  ];
}

/** Apply one settings change to the live config object. Returns true when persisted. */
function applyChange(opts: VikingSettingsOptions, ctx: any, id: string, newValue: string): void {
  const { config } = opts;

  if (id === RECALL_INJECT_ID) {
    opts.onRecallToggle(newValue === "off");
    return; // session-scoped, never persisted
  }

  switch (id) {
    case "enabled": config.enabled = newValue === "on"; break;
    case "syncTurns": config.syncTurns = newValue === "on"; break;
    case "captureMode": config.captureMode = newValue === "keyword" ? "keyword" : "semantic"; break;
    case "captureToolResults": config.captureToolResults = newValue === "on"; break;
    case "captureAssistantTurns": config.captureAssistantTurns = newValue === "on"; break;
    case "recallTokenBudget": config.recallTokenBudget = asInt(newValue); break;
    case "scoreThreshold": config.scoreThreshold = Number(newValue); break;
    case "recallMaxContentChars": config.recallMaxContentChars = asInt(newValue); break;
    case "recallPreferAbstract": config.recallPreferAbstract = newValue === "on"; break;
    case "recallQueryExpansion": config.recallQueryExpansion = newValue === "off" ? "off" : "auto"; break;
    case "recallLedger": config.recallLedger = newValue === "on"; break;
    case "minQueryLength": config.minQueryLength = asInt(newValue); break;
    case "profileTokenBudget": config.profileTokenBudget = asInt(newValue); break;
    case "resumeContextBudget": config.resumeContextBudget = asInt(newValue); break;
    case "commitTokenThreshold": config.commitTokenThreshold = asInt(newValue); break;
    case "commitKeepRecentCount": config.commitKeepRecentCount = asInt(newValue); break;
    case "takeoverEnabled": config.takeoverEnabled = newValue === "on"; break;
    case "takeoverTokenThreshold": config.takeoverTokenThreshold = asInt(newValue); break;
    case "takeoverKeepRecentTurns": config.takeoverKeepRecentTurns = asInt(newValue); break;
    case "takeoverOverviewBudget": config.takeoverOverviewBudget = asInt(newValue); break;
    case "statusBar":
      // Display-only summary written back when the submenu closes; the real
      // mutations happen inside buildStatusBarSubmenu.
      break;
    case "logLevel": config.logLevel = newValue === "silent" ? "silent" : newValue === "info" ? "info" : "error"; break;
    default: return;
  }

  if (!opts.onPersist(config)) {
    ctx?.ui?.notify("OpenViking: failed to write config.json (change applied for this session only)", "warning");
  }
}

/**
 * Open the interactive settings page. Resolves when the user closes it.
 * Requires TUI mode; other modes get a notify and a no-op.
 */
export async function openVikingSettings(ctx: any, opts: VikingSettingsOptions): Promise<void> {
  if (ctx?.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    ctx?.ui?.notify("/viking settings requires interactive TUI mode", "error");
    return;
  }

  await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: void) => void) => {
    // Header status line; its tail (injection state) is rebuilt live when the
    // session-scoped switch is toggled inside the list below.
    const dot = opts.connected
      ? theme.fg("success", "● connected")
      : theme.fg("error", "○ disconnected");
    const sid = opts.sessionId ? `${opts.sessionId.slice(0, 12)}…` : "no session";
    const statusLine = new Text("");
    // Local mirror of the session toggle: onRecallToggle updates the caller's
    // closure, so the page keeps its own copy for live header rendering.
    let recallDisabled = opts.recallDisabled;
    const renderStatusLine = () => {
      statusLine.setText(
        `${dot} ${theme.fg("dim", `session ${sid} · v${EXTENSION_VERSION} ·`)} ${
          recallDisabled
            ? theme.fg("warning", "injection off")
            : theme.fg("success", "injection on")
        }`,
      );
    };
    renderStatusLine();

    const settingsList = new SettingsList(
      buildItems(opts, theme),
      16,
      getSettingsListTheme(),
      (id, newValue) => {
        const wasDisabled = recallDisabled;
        applyChange(opts, ctx, id, newValue);
        if (id === RECALL_INJECT_ID) recallDisabled = newValue === "off";
        if (recallDisabled !== wasDisabled) renderStatusLine();
      },
      () => done(undefined),
      { enableSearch: true },
    );

    // ── Header ───────────────────────────────────────────────────────
    const header = new Container();
    header.addChild(new Text(theme.fg("accent", theme.bold("⚡ OpenViking Settings")), 1, 0));
    header.addChild(statusLine);

    const rule = {
      render: (w: number) => [theme.fg("border", "─".repeat(Math.max(0, w)))],
      invalidate() {},
    };

    const root = new Container();
    root.addChild(header);
    root.addChild(rule);
    root.addChild(settingsList);

    return {
      render: (width: number) => root.render(width),
      invalidate: () => root.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
