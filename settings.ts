/**
 * The OpenViking panel: `/viking` opens it, and it is the only user surface
 * besides the footer.
 *
 * Structure is task-oriented and two levels deep. The top level lists six
 * editable sections plus diagnostics; each section opens its own settings list
 * with the current values, so the panel never shows more than one area's worth
 * of rows at a time. Actions (commit, doctor) live in the section where a user
 * would look for them instead of in slash-command subcommands.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";
import { PI_SETTING_KEYS } from "./lib/pi-settings.mjs";
import {
  Container,
  SelectList,
  SettingsList,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";

import {
  DEFAULT_DEBUG_LOG_PATH,
  EXTENSION_ROOT,
  EXTENSION_VERSION,
  STATUS_BAR_LEVELS,
  type OVConfig,
} from "./config.js";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

/** Read-only facts shown in the Diagnostics section. */
export interface DiagnosticsSnapshot {
  connected: boolean;
  endpoint: string;
  authMode: string;
  sessionId: string | null;
  peerId: string;
  recallScope: string;
  syncedEntries: number;
  pendingCount: number;
  debugLogPath: string;
  takeoverEnabled: boolean;
  takeoverCovered: number;
  takeoverSeen: number;
  pendingTokens: number;
  /** True while the fire-and-forget startup chain is still running. */
  starting: boolean;
}

export interface VikingSettingsOptions {
  config: OVConfig;
  snapshot: DiagnosticsSnapshot;
  /** Current session-scoped injection switch (true = disabled). */
  recallDisabled: boolean;
  /** Live toggle for the session-scoped switch. Not persisted. */
  onRecallToggle: (disabled: boolean) => void;
  /** Flush pending writes and commit; resolves with the outcome. */
  onCommit: () => Promise<{ ok: boolean; detail?: string }>;
  /** Persist one changed setting, keyed by its item id. */
  onPersist: (config: OVConfig, key: string) => boolean;
}

interface PageContext {
  ctx: any;
  opts: VikingSettingsOptions;
  theme: any;
  tui: any;
  refreshHeader: () => void;
}

interface SectionSpec {
  id: string;
  title: string;
  summary: () => string;
  items: () => SettingItem[];
}

/** Session-only item id: never written to the settings file. */
const RECALL_INJECT_ID = "__session.context_injection";

type SettingKey = (typeof PI_SETTING_KEYS)[number];
type ItemId = SettingKey | "commitNow" | "doctor" | `diag${string}` | typeof RECALL_INJECT_ID;

/**
 * Type the ids of a section's rows against the canonical key list. Actions and
 * diagnostic rows are explicitly allowed; everything else must be a setting
 * key, so a renamed row fails typechecking instead of silently doing nothing.
 */
function sectionItems(items: Array<Omit<SettingItem, "id"> & { id: ItemId }>): SettingItem[] {
  return items;
}

/**
 * Replace SettingsList's "Enter/Space to change" hint, which is wrong for the
 * read-only Diagnostics rows and for sections where Enter opens a submenu.
 * The wrapped component sees the section submenu's lines too, so one wrapper
 * covers both levels.
 */
function withHint(component: Component, theme: any, hint: string): Component {
  return {
    render(width: number) {
      const replacement = truncateToWidth(theme.fg("dim", hint), width);
      return component.render(width).map((line) =>
        line.includes("Type to search") || line.includes("Enter/Space to change")
          ? replacement
          : line,
      );
    },
    invalidate: () => component.invalidate(),
    handleInput: (data: string) => component.handleInput?.(data),
    handleMouse: (event: any) => component.handleMouse?.(event),
    wantsKeyRelease: component.wantsKeyRelease,
  };
}

const RECALL_INJECT_DESC =
  "Session only. When off, no <openviking-context> block (recall, profile, archive overview) " +
  "is injected into prompts. Capture and context takeover keep running.";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function asInt(value: string): number {
  return Math.round(Number(value));
}

function presetsWithCurrent(currentValue: string, defaults: number[]): number[] {
  const current = Number(currentValue);
  const set = new Set<number>(defaults);
  if (Number.isFinite(current)) set.add(current);
  return [...set].sort((a, b) => a - b);
}

function numericSubmenu(defaults: number[], unit = ""): SettingItem["submenu"] {
  return (currentValue, done) => {
    const values = presetsWithCurrent(currentValue, defaults);
    const items = values.map((value) => ({
      value: String(value),
      label: `${value.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`,
    }));
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    const current = Number(currentValue);
    const index = values.findIndex((value) => value === current);
    if (index >= 0) list.setSelectedIndex(index);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();
    return list;
  };
}

function infoItem<Id extends ItemId>(
  id: Id,
  label: string,
  value: string,
  description = "Read-only.",
): Omit<SettingItem, "id"> & { id: Id } {
  return { id, label, currentValue: value, description };
}

/** One top-level row; opening it shows the section's own settings list. */
function sectionItem(spec: SectionSpec, page: PageContext): SettingItem {
  return {
    id: spec.id,
    label: spec.title,
    currentValue: spec.summary(),
    submenu: (_current, done) => buildSectionPage(spec, page, done),
  };
}

function buildSectionPage(spec: SectionSpec, page: PageContext, done: (value?: string) => void): Component {
  const items = spec.items();
  const list = new SettingsList(
    items,
    Math.min(items.length + 2, 18),
    getSettingsListTheme(),
    (id, newValue) => applyChange(page, id, newValue),
    () => done(spec.summary()),
    { enableSearch: true },
  );

  const header = new Container();
  header.addChild(new Text(page.theme.fg("accent", page.theme.bold(`‹ ${spec.title}`)), 1, 0));

  const root = new Container();
  root.addChild(header);
  root.addChild(list);

  return {
    render: (width: number) => root.render(width),
    invalidate: () => root.invalidate(),
    handleInput: (data: string) => list.handleInput?.(data),
  };
}

/** Run the full doctor report in a child process and page its output. */
const DOCTOR_CACHE_MS = 60_000;
let doctorReportPromise: Promise<string> | null = null;
let doctorReportAt = 0;

/**
 * One doctor run per minute, shared across pagers and panel opens. Esc +
 * reopen reuses the result (and an explicit `r` in the pager forces a rerun),
 * so a report never turns into a burst of child processes.
 */
function doctorReport(force = false): Promise<string> {
  const stale = Date.now() - doctorReportAt > DOCTOR_CACHE_MS;
  if (force || !doctorReportPromise || stale) {
    doctorReportAt = Date.now();
    doctorReportPromise = runDoctorReport().finally(() => {
      doctorReportAt = Date.now();
    });
  }
  return doctorReportPromise;
}

async function runDoctorReport(): Promise<string> {
  const script = join(EXTENSION_ROOT, "scripts", "doctor.mjs");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [script, "--no-color"],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
    );
    return (stdout || stderr).trim() || "(doctor produced no output)";
  } catch (error: any) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    return output || `doctor failed: ${error?.message ?? error}`;
  }
}

class DoctorPanel implements Component {
  private lines: string[] = ["Running full doctor…"];
  private top = 0;
  private finished = false;

  constructor(private page: PageContext, private close: () => void) {
    void this.run();
  }

  private async run(force = false): Promise<void> {
    if (force) {
      this.top = 0;
      this.lines = ["Running full doctor…"];
      this.finished = false;
    }
    try {
      this.lines = (await doctorReport(force)).split("\n");
    } catch (error: any) {
      this.lines = [`doctor failed: ${error?.message ?? error}`];
    }
    this.finished = true;
    this.page.tui?.requestRender?.();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.min(20, Math.max(1, this.lines.length));
    const maxTop = Math.max(0, this.lines.length - height);
    if (this.top > maxTop) this.top = maxTop;

    const header = `${this.page.theme.fg("accent", "⚕ OpenViking doctor")}${this.page.theme.fg("dim", "  ↑↓ scroll · r refresh · esc back")}`;
    const body = this.lines.slice(this.top, this.top + height);
    while (body.length < height) body.push("");
    const end = Math.min(this.top + height, this.lines.length);
    const position = this.finished
      ? (this.lines.length > height ? `${this.top + 1}-${end}/${this.lines.length}` : `${this.lines.length} line(s)`)
      : "running";
    const footer = this.page.theme.fg("dim", `── ${position} ──`);

    return [header, ...body, footer].map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const pageSize = 10;
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (data === "r") {
      void this.run(true);
      this.page.tui?.requestRender?.();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.top = Math.max(0, this.top - 1);
    else if (matchesKey(data, "down") || data === "j") this.top += 1;
    else if (matchesKey(data, "pageUp")) this.top = Math.max(0, this.top - pageSize);
    else if (matchesKey(data, "pageDown")) this.top += pageSize;
    else if (matchesKey(data, "home")) this.top = 0;
    else if (matchesKey(data, "end")) this.top = Number.MAX_SAFE_INTEGER;
    else return;
    this.page.tui?.requestRender?.();
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sessionSection(page: PageContext): SectionSpec {
  return {
    id: "session",
    title: "Session",
    summary: () => (page.opts.recallDisabled ? "injection off" : "injection on"),
    items: () => sectionItems([
      {
        id: RECALL_INJECT_ID,
        label: "context injection",
        currentValue: onOff(!page.opts.recallDisabled),
        values: ["on", "off"],
        description: RECALL_INJECT_DESC,
      },
      {
        id: "commitNow",
        label: "commit now",
        currentValue: "enter",
        description:
          "Flush pending writes and commit this session, so OpenViking extracts long-term memory now " +
          "instead of waiting for the automatic threshold.",
        submenu: (_current, done) => {
          // Close before the network call. A bare Text has no handleInput and
          // SettingsList forwards every key to it, so keeping the submenu open
          // would trap the user until the commit (and takeover polling) ends.
          queueMicrotask(() => done());
          page.ctx?.ui?.notify("OpenViking: committing…", "info");
          void page.opts.onCommit()
            .then((result) => {
              page.ctx?.ui?.notify(
                result.ok
                  ? `OpenViking: committed${result.detail ? ` (${result.detail})` : ""}`
                  : `OpenViking: commit failed${result.detail ? ` — ${result.detail}` : ""}`,
                result.ok ? "info" : "error",
              );
            })
            .catch((error) => {
              page.ctx?.ui?.notify(`OpenViking: commit failed — ${error?.message ?? error}`, "error");
            });
          return new Text("");
        },
      },
    ]),
  };
}

function captureSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  return {
    id: "capture",
    title: "Capture",
    summary: () => onOff(config.autoCapture),
    items: () => sectionItems([
      {
        id: "autoCapture",
        label: "capture conversation turns",
        currentValue: onOff(config.autoCapture),
        values: ["on", "off"],
        description: "Stream every conversation turn into the OpenViking session so commits can extract memory.",
      },
      {
        id: "captureAssistantTurns",
        label: "include assistant replies",
        currentValue: onOff(config.captureAssistantTurns),
        values: ["on", "off"],
        description: "Capture assistant replies in addition to user messages.",
      },
      {
        id: "captureToolResults",
        label: "include tool results",
        currentValue: onOff(config.captureToolResults),
        values: ["on", "off"],
        description: "Also capture tool output. Heavier, but preserves what the agent actually did.",
      },
      {
        id: "commitTokenThreshold",
        label: "auto-commit at",
        currentValue: String(config.commitTokenThreshold),
        submenu: numericSubmenu([10000, 20000, 30000, 50000, 100000], "tokens"),
        description: "Synced token pressure that triggers an automatic commit (memory extraction).",
      },
      {
        id: "commitKeepRecentCount",
        label: "keep recent after commit",
        currentValue: String(config.commitKeepRecentCount),
        submenu: numericSubmenu([3, 5, 10, 20], "messages"),
        description: "How many recent messages stay in the live session after a commit.",
      },
    ]),
  };
}

function recallSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  return {
    id: "recall",
    title: "Recall",
    summary: () => `${config.recallTokenBudget} tok · ${config.scoreThreshold}`,
    items: () => sectionItems([
      {
        id: "recallTokenBudget",
        label: "injection token budget",
        currentValue: String(config.recallTokenBudget),
        submenu: numericSubmenu([500, 1000, 2000, 3000, 4000, 8000], "tokens"),
        description: "Token budget for the <openviking-context> block injected with each prompt.",
      },
      {
        id: "recallLimit",
        label: "result quota",
        currentValue: String(config.recallLimit),
        submenu: numericSubmenu([3, 6, 10, 15, 20, 30], "results"),
        description: "How many memories recall asks for. Each coding category keeps its own slot.",
      },
      {
        id: "scoreThreshold",
        label: "minimum score",
        currentValue: String(config.scoreThreshold),
        submenu: numericSubmenu([0.2, 0.35, 0.5, 0.65, 0.8]),
        description: "Minimum similarity for a memory to be recalled. Higher means fewer, sharper matches.",
      },
      {
        id: "recallMaxContentChars",
        label: "abstract length cap",
        currentValue: String(config.recallMaxContentChars),
        submenu: numericSubmenu([200, 500, 1000, 2000, 4000], "chars"),
        description: "Per-result character cap for the abstracts shown to the model.",
      },
      {
        id: "recallPreferAbstract",
        label: "prefer abstracts",
        currentValue: onOff(config.recallPreferAbstract),
        values: ["on", "off"],
        description: "Prefer compact L0 abstracts over full content in recall results.",
      },
      {
        id: "minQueryLength",
        label: "skip prompts shorter than",
        currentValue: String(config.minQueryLength),
        submenu: numericSubmenu([1, 3, 5, 10, 20], "chars"),
        description: "Prompts shorter than this skip the recall search entirely.",
      },
      {
        id: "recallQueryExpansion",
        label: "query expansion",
        currentValue: config.recallQueryExpansion,
        values: ["auto", "off"],
        description:
          "Server-side query expansion before retrieval. Costs one model call of latency; auto lets the server decide.",
      },
      {
        id: "recallLedger",
        label: "injection ledger",
        currentValue: onOff(config.recallLedger),
        values: ["on", "off"],
        description:
          "Replay the exact recall blocks previously sent with historical messages so provider prompt caches keep hitting.",
      },
    ]),
  };
}

function contextSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  return {
    id: "context",
    title: "Context",
    summary: () => `${config.takeoverEnabled ? "takeover on" : "takeover off"} · keep ${config.takeoverKeepRecentTurns}`,
    items: () => sectionItems([
      {
        id: "takeoverEnabled",
        label: "context takeover",
        currentValue: onOff(config.takeoverEnabled),
        values: ["on", "off"],
        description:
          "Represent committed history with the OpenViking archive overview instead of pi compaction. " +
          "Best changed at session start.",
      },
      {
        id: "takeoverTokenThreshold",
        label: "takeover at",
        currentValue: String(config.takeoverTokenThreshold),
        submenu: numericSubmenu([10000, 20000, 30000, 50000, 100000], "tokens"),
        description: "Synced token pressure required before takeover advances the context boundary.",
      },
      {
        id: "takeoverKeepRecentTurns",
        label: "keep recent turns",
        currentValue: String(config.takeoverKeepRecentTurns),
        submenu: numericSubmenu([1, 2, 3, 5, 8], "turns"),
        description: "Recent user turns kept at full fidelity once takeover is active.",
      },
      {
        id: "takeoverOverviewBudget",
        label: "overview budget",
        currentValue: String(config.takeoverOverviewBudget),
        submenu: numericSubmenu([1000, 2000, 3000, 5000, 8000], "tokens"),
        description: "Token budget for the injected archive overview message.",
      },
      {
        id: "profileTokenBudget",
        label: "profile budget",
        currentValue: String(config.profileTokenBudget),
        submenu: numericSubmenu([2000, 5000, 10000, 20000], "tokens"),
        description: "Token budget for the user-profile block injected at session start.",
      },
      {
        id: "resumeContextBudget",
        label: "resume budget",
        currentValue: String(config.resumeContextBudget),
        submenu: numericSubmenu([8000, 16000, 32000, 64000], "tokens"),
        description: "Token budget for the archive overview fetched when resuming a committed session.",
      },
    ]),
  };
}

function interfaceSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  return {
    id: "interface",
    title: "Interface",
    summary: () => `${config.statusBarLevel} · ${config.logLevel}`,
    items: () => sectionItems([
      {
        id: "statusBarLevel",
        label: "footer status bar",
        currentValue: config.statusBarLevel,
        values: [...STATUS_BAR_LEVELS],
        description:
          "hidden: no segment. minimal: connection and anomalies only. standard: sync, takeover coverage " +
          "and token pressure. verbose: adds labels and the session id.",
      },
      {
        id: "logLevel",
        label: "notification level",
        currentValue: config.logLevel,
        values: ["silent", "error", "info"],
        description: "Verbosity of the startup notices OpenViking prints in pi's UI.",
      },
    ]),
  };
}

function diagnosticsSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  const snapshot = page.opts.snapshot;
  return {
    id: "diagnostics",
    title: "Diagnostics",
    summary: () => snapshot.starting
      ? "◌ starting"
      : `${snapshot.connected ? "● reachable" : "○ offline"} · ${snapshot.pendingCount} pending`,
    items: () => {
      const status = snapshot.starting ? "◌ starting" : snapshot.connected ? "●" : "○";
      // Config-derived rows read the live object, so a change made in Advanced
      // is reflected here immediately. Counts and connection state stay as the
      // snapshot taken when the panel opened.
      const takeover = config.takeoverEnabled
        ? `${snapshot.takeoverCovered}/${snapshot.takeoverSeen} turns · ${snapshot.pendingTokens} tokens pending`
        : "off";

      return sectionItems([
        {
          id: "doctor",
          label: "run full doctor",
          currentValue: "enter",
          description:
            "Check the environment, server connection, configuration sources and local activity, then show the report here.",
          submenu: (_current, done) => new DoctorPanel(page, done),
        },
        infoItem("diagServer", "server", `${status} ${snapshot.endpoint}`),
        infoItem("diagAuth", "authentication", config.authMode || "api_key"),
        infoItem("diagSession", "session", snapshot.sessionId ? `${snapshot.sessionId.slice(0, 12)}…` : "none"),
        infoItem("diagSynced", "synced entries", String(snapshot.syncedEntries)),
        infoItem("diagPeer", "actor peer", config.peerId || "(none)"),
        infoItem("diagScope", "recall scope", config.recallPeerScope),
        infoItem("diagTakeover", "takeover", takeover),
        infoItem("diagPending", "pending queue", `${snapshot.pendingCount} queued`),
        infoItem("diagLog", "debug log", config.debugLogPath || "off"),
      ]);
    },
  };
}

function advancedSection(page: PageContext): SectionSpec {
  const { config } = page.opts;
  return {
    id: "advanced",
    title: "Advanced",
    summary: () => `${config.recallPeerScope} · ${config.workspacePeer ? "peer auto" : "peer off"}`,
    items: () => sectionItems([
      {
        id: "workspacePeer",
        label: "derive peer from workspace",
        currentValue: onOff(config.workspacePeer),
        values: ["on", "off"],
        description: "Derive the actor peer from the workspace's git identity when no explicit peer is set.",
      },
      {
        id: "recallPeerScope",
        label: "recall peer scope",
        currentValue: config.recallPeerScope,
        values: ["all", "actor"],
        description:
          "all: recall other projects' memories with a score penalty. actor: only global memory plus the current workspace.",
      },
      {
        id: "captureMaxLength",
        label: "capture max turn size",
        currentValue: String(config.captureMaxLength),
        submenu: numericSubmenu([8000, 16000, 24000, 48000, 96000], "chars"),
        description: "Upper bound on a single captured turn.",
      },
      {
        id: "captureToolMaxChars",
        label: "tool output cap",
        currentValue: String(config.captureToolMaxChars),
        submenu: numericSubmenu([100000, 500000, 1000000], "chars"),
        description: "Guard against pathological tool output; the server still owns normal truncation.",
      },
      {
        id: "takeoverOverviewPollMs",
        label: "overview poll interval",
        currentValue: String(config.takeoverOverviewPollMs),
        submenu: numericSubmenu([500, 1000, 2000, 5000], "ms"),
        description: "Delay between archive-overview polls after a takeover commit.",
      },
      {
        id: "takeoverOverviewPollMax",
        label: "overview poll attempts",
        currentValue: String(config.takeoverOverviewPollMax),
        submenu: numericSubmenu([5, 10, 15, 30]),
        description: "How many times takeover polls for the archive overview before giving up for this turn.",
      },
      {
        id: "bypassSession",
        label: "bypass memory here",
        currentValue: onOff(config.bypassSession),
        values: ["on", "off"],
        description: "Do not capture or recall anything while working in this workspace.",
      },
      {
        id: "debug",
        label: "debug log",
        currentValue: onOff(config.debug),
        values: ["on", "off"],
        description: "Write JSON Lines debug records to the debug log path shown in Diagnostics.",
      },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Change handling
// ---------------------------------------------------------------------------

type Setter = (config: OVConfig, value: string) => void;

/** Re-resolve the effective peer after the derivation switch changes. */
function recomputePeer(config: OVConfig): void {
  const effective = resolveEffectivePeerId({
    cfg: { ...config, peerId: config.explicitPeerId || "" },
    cwd: process.cwd(),
  });
  config.peerId = effective.peerId;
  config.legacyPeerId = effective.legacyPeerId;
}

/**
 * One setter per editable id. Keeping this as a table instead of a 30-arm
 * switch makes drift visible: `openVikingSettings` checks every section item
 * against these keys, so a renamed row cannot silently stop persisting.
 */
const SETTERS: Record<SettingKey, Setter> = {
  autoCapture: (c, v) => { c.autoCapture = v === "on"; },
  captureAssistantTurns: (c, v) => { c.captureAssistantTurns = v === "on"; },
  captureToolResults: (c, v) => { c.captureToolResults = v === "on"; },
  commitTokenThreshold: (c, v) => { c.commitTokenThreshold = asInt(v); },
  commitKeepRecentCount: (c, v) => { c.commitKeepRecentCount = asInt(v); },
  recallTokenBudget: (c, v) => { c.recallTokenBudget = asInt(v); },
  recallLimit: (c, v) => { c.recallLimit = asInt(v); },
  scoreThreshold: (c, v) => { c.scoreThreshold = Number(v); },
  recallMaxContentChars: (c, v) => { c.recallMaxContentChars = asInt(v); },
  recallPreferAbstract: (c, v) => { c.recallPreferAbstract = v === "on"; },
  minQueryLength: (c, v) => { c.minQueryLength = asInt(v); },
  recallQueryExpansion: (c, v) => { c.recallQueryExpansion = v === "off" ? "off" : "auto"; },
  recallLedger: (c, v) => { c.recallLedger = v === "on"; },
  takeoverEnabled: (c, v) => { c.takeoverEnabled = v === "on"; },
  takeoverTokenThreshold: (c, v) => { c.takeoverTokenThreshold = asInt(v); },
  takeoverKeepRecentTurns: (c, v) => { c.takeoverKeepRecentTurns = asInt(v); },
  takeoverOverviewBudget: (c, v) => { c.takeoverOverviewBudget = asInt(v); },
  profileTokenBudget: (c, v) => { c.profileTokenBudget = asInt(v); },
  resumeContextBudget: (c, v) => { c.resumeContextBudget = asInt(v); },
  statusBarLevel: (c, v) => {
    c.statusBarLevel = ((STATUS_BAR_LEVELS as readonly string[]).includes(v) ? v : "standard") as OVConfig["statusBarLevel"];
  },
  logLevel: (c, v) => {
    c.logLevel = v === "silent" ? "silent" : v === "info" ? "info" : "error";
  },
  workspacePeer: (c, v) => {
    c.workspacePeer = v === "on";
    recomputePeer(c);
  },
  recallPeerScope: (c, v) => { c.recallPeerScope = v === "actor" ? "actor" : "all"; },
  captureMaxLength: (c, v) => { c.captureMaxLength = asInt(v); },
  captureToolMaxChars: (c, v) => { c.captureToolMaxChars = asInt(v); },
  takeoverOverviewPollMs: (c, v) => { c.takeoverOverviewPollMs = asInt(v); },
  takeoverOverviewPollMax: (c, v) => { c.takeoverOverviewPollMax = asInt(v); },
  bypassSession: (c, v) => { c.bypassSession = v === "on"; },
  debug: (c, v) => {
    c.debug = v === "on";
    c.debugLogPath = c.debug ? (c.debugLogPath || DEFAULT_DEBUG_LOG_PATH) : "";
  },
};

function applyChange(page: PageContext, id: string, newValue: string): void {
  const { config } = page.opts;

  if (id === RECALL_INJECT_ID) {
    const disabled = newValue === "off";
    page.opts.recallDisabled = disabled;
    page.opts.onRecallToggle(disabled);
    page.refreshHeader();
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(SETTERS, id)) return;
  SETTERS[id as SettingKey](config, newValue);

  if (!page.opts.onPersist(config, id)) {
    page.ctx?.ui?.notify(
      "OpenViking: could not write the settings file (change applies to this session only)",
      "warning",
    );
  }
  page.refreshHeader();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function headerText(opts: VikingSettingsOptions, theme: any): string {
  const snapshot = opts.snapshot;
  const dot = snapshot.starting
    ? theme.fg("warning", "◌ starting")
    : snapshot.connected
      ? theme.fg("success", "● connected")
      : theme.fg("error", "○ disconnected");
  const session = snapshot.sessionId ? `${snapshot.sessionId.slice(0, 12)}…` : "no session";
  const injection = opts.recallDisabled ? theme.fg("warning", "injection off") : theme.fg("success", "injection on");
  return `${dot} ${theme.fg("dim", `session ${session} · v${EXTENSION_VERSION} ·`)} ${injection}`;
}

function nonTuiSummary(opts: VikingSettingsOptions): string {
  const snapshot = opts.snapshot;
  const state = snapshot.starting ? "starting" : snapshot.connected ? "connected" : "disconnected";
  return `OpenViking: ${state} | session: ${
    snapshot.sessionId?.slice(0, 12) ?? "none"
  } | injection: ${opts.recallDisabled ? "off" : "on"} | pending: ${snapshot.pendingCount}`;
}

export async function openVikingSettings(ctx: any, opts: VikingSettingsOptions): Promise<void> {
  if (ctx?.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    ctx?.ui?.notify(nonTuiSummary(opts), "info");
    return;
  }

  await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: undefined) => void) => {
    const statusLine = new Text("");
    const refreshHeader = () => {
      statusLine.setText(headerText(opts, theme));
      tui?.requestRender?.();
    };

    const page: PageContext = { ctx, opts, theme, tui, refreshHeader };
    refreshHeader();

    const sections = [
      sessionSection(page),
      captureSection(page),
      recallSection(page),
      contextSection(page),
      interfaceSection(page),
      diagnosticsSection(page),
      advancedSection(page),
    ];

    const items = sections.map((section) => sectionItem(section, page));

    const list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      () => {}, // sections own their changes
      () => done(undefined),
      { enableSearch: true },
    );

    const header = new Container();
    header.addChild(new Text(theme.fg("accent", theme.bold("⚡ OpenViking Settings")), 1, 0));
    header.addChild(statusLine);

    const rule = {
      render: (width: number) => [theme.fg("border", "─".repeat(Math.max(0, width)))],
      invalidate() {},
    };

    const root = new Container();
    root.addChild(header);
    root.addChild(rule);
    root.addChild(withHint(list, theme, "  ↑↓ move · Enter opens · type to filter · Esc back"));

    return {
      render: (width: number) => root.render(width),
      invalidate: () => root.invalidate(),
      handleInput: (data: string) => {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
