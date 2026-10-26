import {
  DEFAULT_DEBUG_LOG_PATH,
  EXTENSION_ROOT,
  EXTENSION_VERSION,
  STATUS_BAR_LEVELS,
  resolvePiConfig,
  savePiConfig,
} from "./lib/pi-config.mjs";

export { DEFAULT_DEBUG_LOG_PATH, EXTENSION_ROOT, EXTENSION_VERSION, STATUS_BAR_LEVELS };

export type StatusBarLevel = "hidden" | "minimal" | "standard" | "verbose";

export interface OVConfig {
  endpoint: string;
  apiKey: string;
  account: string;
  user: string;
  /** `trusted` or `api_key`; only the former puts the identity on the wire. */
  authMode: string;
  sendIdentityHeaders: boolean;
  peerId: string;
  /** The id named by a config layer, before workspace derivation. */
  explicitPeerId?: string;
  /** The pre-git workspace id, when it differs — recall still reaches it. */
  legacyPeerId: string;
  userAgent: string;
  harness: string;
  workspacePeer: boolean;
  recallPeerScope: "actor" | "all";
  recallQueryExpansion: "auto" | "off";
  autoCapture: boolean;
  recallTokenBudget: number;
  recallMaxContentChars: number;
  recallPreferAbstract: boolean;
  recallLimit: number;
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
  bypassSession: boolean;
  bypassSessionPatterns: string[];
  logLevel: "silent" | "error" | "info";
  debug: boolean;
  debugLogPath: string;
  /** Footer density, one knob instead of five independent booleans. */
  statusBarLevel: StatusBarLevel;
}

/**
 * The shared layer stack only. Tests and callers that must not pick up the
 * operator's saved panel choices use this.
 */
export function loadConfig(cwd: string = process.cwd()): OVConfig {
  return resolvePiConfig({ cwd, applySidecar: false });
}

/** The effective configuration: shared layers plus the panel's sidecar. */
export function loadEffectiveConfig(cwd: string = process.cwd()): OVConfig {
  return resolvePiConfig({ cwd, applySidecar: true });
}

/**
 * Persist the panel-owned settings to `~/.openviking/pi-settings.json`.
 * Pass the changed keys so untouched values keep coming from env/ovcli.conf.
 */
export function saveConfig(config: OVConfig, keys?: readonly string[]): boolean {
  return savePiConfig(config, keys);
}
