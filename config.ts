import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestVersion } from "./shared/credentials.mjs";
import { buildPluginConfig } from "./shared/plugin-config.mjs";

/** The version the User-Agent reports, read from the manifest the gate checks. */
export const EXTENSION_VERSION = readManifestVersion(new URL("./package.json", import.meta.url));

/** Per-segment visibility for the footer status bar (local feature). */
export interface StatusBarConfig {
  enabled: boolean;
  showSync: boolean;
  showTakeover: boolean;
  showInjection: boolean;
  showSession: boolean;
}

const DEFAULT_STATUS_BAR: StatusBarConfig = {
  enabled: true,
  showSync: true,
  showTakeover: true,
  showInjection: true,
  showSession: true,
};

export interface OVConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  account: string;
  user: string;
  /** `trusted` or `api_key`; only the former puts the identity on the wire. */
  authMode: string;
  sendIdentityHeaders: boolean;
  peerId: string;
  /** The pre-git workspace id, when it differs — recall still reaches it. */
  legacyPeerId: string;
  userAgent: string;
  harness: string;
  workspacePeer: boolean;
  recallPeerScope: "actor" | "all";
  recallQueryExpansion: "auto" | "off";
  recallQueryExpansionConfigured: boolean;
  autoCapture: boolean;
  /** Local spelling of the capture master toggle; `false` also disables via isCaptureEnabled. */
  syncTurns: boolean;
  recallTokenBudget: number;
  recallMaxContentChars: number;
  recallPreferAbstract: boolean;
  recallLimit: number;
  recallLimitConfigured: boolean;
  recallLedger: boolean;
  scoreThreshold: number;
  minQueryLength: number;
  profileTokenBudget: number;
  resumeContextBudget: number;
  commitTokenThreshold: number;
  commitKeepRecentCount: number;
  takeoverEnabled: boolean;
  takeoverTokenThreshold: number;
  takeoverKeepRecentTurns: number;
  takeoverOverviewBudget: number;
  takeoverOverviewPollMs: number;
  takeoverOverviewPollMax: number;
  captureToolResults: boolean;
  captureMode: "semantic" | "keyword";
  captureMaxLength: number;
  captureToolMaxChars: number;
  captureAssistantTurns: boolean;
  /** Kept as this extension's original spelling; projected onto the shared one. */
  bypassPatterns: string[];
  bypassSession: boolean;
  bypassSessionPatterns: string[];
  logLevel: "silent" | "error" | "info";
  debugLogPath: string;
  /** Local: footer status bar visibility. */
  statusBar: StatusBarConfig;
}

function configFilePath(extensionDir: string): string {
  return join(extensionDir, "config.json");
}

function readConfigFile(extensionDir: string): any {
  try {
    const p = configFilePath(extensionDir);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // fall through
  }
  return {};
}

/**
 * Load the extension's configuration.
 *
 * Every knob is declared in `shared/config-schema.mjs` and resolved from the
 * same layers as every other harness: env → the workspace file → `ovcli.conf`'s
 * `plugin.pi` → `ovcli.conf`'s `plugin` → defaults. This entry is sidecar-free
 * so the shared loader's semantics stay intact; the settings-page sidecar is
 * applied by `loadConfigFromModuleUrl`.
 */
export function loadConfig(cwd: string = process.cwd()): OVConfig {
  const config = buildPluginConfig("pi", { cwd, version: EXTENSION_VERSION, deriveEffectivePeer: true });

  return {
    ...config,
    // `bypassSessionPatterns` is the name the shared matcher reads and every
    // other harness spells; `bypassPatterns` was this extension's own and is
    // still accepted. Both hold the same list so either can be inspected.
    bypassPatterns: config.bypassSessionPatterns,
    // OPENVIKING_DEBUG_LOG is the shared spelling and lands in the schema;
    // OV_DEBUG_LOG is pi's older name, kept working so existing setups log.
    debugLogPath: config.debugLogPath || String(process.env.OV_DEBUG_LOG || "").trim(),
    // The whole resolution, not just the id: `legacyPeerId` is what lets recall
    // under `actor` scope still reach memories written before the git-derived
    // peer replaced the path-derived one.
    peerId: config.effectivePeer.peerId,
  } as OVConfig;
}

/**
 * Overlay the extension sidecar `config.json` (settings-page persistence,
 * local feature): whatever it carries overrides the standard resolution, so
 * the operator's last settings-page choice always wins.
 */
function applySidecarConfig(config: OVConfig, extensionDir: string): OVConfig {
  const file = readConfigFile(extensionDir);
  const statusBarFile = file && typeof file.statusBar === "object" && file.statusBar ? file.statusBar : {};
  const takeoverFile = file && typeof file.takeover === "object" && file.takeover ? file.takeover : {};

  return {
    ...config,
    // Persisted sidecar overrides (settings-page choices, e.g. resume/commit
    // budgets, recall toggles, statusBar). Credential-derived fields never
    // appear in the file, so spreading is safe.
    ...file,
    // Recompute the derived spellings the sidecar cannot override.
    bypassPatterns: (config as any).bypassSessionPatterns,
    debugLogPath: (config as any).debugLogPath,
    peerId: (config as any).peerId,
    // Local: nested takeover block from the sidecar maps onto the flat knobs.
    takeoverEnabled: takeoverFile.enabled !== undefined ? Boolean(takeoverFile.enabled) : config.takeoverEnabled,
    takeoverTokenThreshold: takeoverFile.tokenThreshold ?? config.takeoverTokenThreshold,
    takeoverKeepRecentTurns: takeoverFile.keepRecentTurns ?? config.takeoverKeepRecentTurns,
    takeoverOverviewBudget: takeoverFile.overviewBudget ?? config.takeoverOverviewBudget,
    // Local: capture master toggle (settings page), default on.
    syncTurns: file.syncTurns !== undefined ? Boolean(file.syncTurns) : true,
    // Local: footer status bar (settings page), default all on.
    statusBar: { ...DEFAULT_STATUS_BAR, ...statusBarFile },
  } as OVConfig;
}

export function loadConfigFromModuleUrl(moduleUrl: string): OVConfig {
  return applySidecarConfig(loadConfig(), dirname(fileURLToPath(moduleUrl)));
}

/**
 * Persist user-manageable settings back to the sidecar config.json.
 *
 * Unknown keys already present in the file are preserved, and the nested
 * `takeover` object is merged rather than replaced. Credential-derived fields
 * (endpoint, apiKey, account, user, peerId) are deliberately not written:
 * they come from the credentials resolver / environment, and the hand-edited
 * file intentionally does not carry them.
 */
export function saveConfig(extensionDir: string, config: OVConfig): boolean {
  const configPath = configFilePath(extensionDir);
  let existing: any = readConfigFile(extensionDir);

  const priorTakeover = existing.takeover && typeof existing.takeover === "object" ? existing.takeover : {};
  const priorStatusBar = existing.statusBar && typeof existing.statusBar === "object" ? existing.statusBar : {};
  const next: any = {
    ...existing,
    enabled: config.enabled,
    syncTurns: config.syncTurns,
    recallTokenBudget: config.recallTokenBudget,
    recallMaxContentChars: config.recallMaxContentChars,
    recallPreferAbstract: config.recallPreferAbstract,
    recallLedger: config.recallLedger,
    recallPeerScope: config.recallPeerScope,
    recallQueryExpansion: config.recallQueryExpansion,
    scoreThreshold: config.scoreThreshold,
    minQueryLength: config.minQueryLength,
    profileTokenBudget: config.profileTokenBudget,
    resumeContextBudget: config.resumeContextBudget,
    commitTokenThreshold: config.commitTokenThreshold,
    commitKeepRecentCount: config.commitKeepRecentCount,
    captureToolResults: config.captureToolResults,
    captureMode: config.captureMode,
    captureMaxLength: config.captureMaxLength,
    captureToolMaxChars: config.captureToolMaxChars,
    captureAssistantTurns: config.captureAssistantTurns,
    statusBar: {
      ...priorStatusBar,
      enabled: config.statusBar.enabled,
      showSync: config.statusBar.showSync,
      showTakeover: config.statusBar.showTakeover,
      showInjection: config.statusBar.showInjection,
      showSession: config.statusBar.showSession,
    },
    logLevel: config.logLevel,
    takeover: {
      ...priorTakeover,
      enabled: config.takeoverEnabled,
      tokenThreshold: config.takeoverTokenThreshold,
      keepRecentTurns: config.takeoverKeepRecentTurns,
      overviewBudget: config.takeoverOverviewBudget,
    },
  };

  // Drop the legacy flat key once the nested object is authoritative.
  delete next.statusBarEnabled;

  try {
    writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function saveConfigFromModuleUrl(moduleUrl: string, config: OVConfig): boolean {
  return saveConfig(dirname(fileURLToPath(moduleUrl)), config);
}
