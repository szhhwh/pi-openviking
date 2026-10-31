/**
 * The canonical list of settings the `/viking` panel owns.
 *
 * This is the single source of truth for the sidecar allowlist (`pi-config`)
 * and for the panel's setters (`settings.ts`, which types its setter table as
 * `Record<SettingKey, Setter>` so a missing or extra key fails typechecking).
 * Keys are the resolved config names; credentials and bootstrap switches are
 * deliberately absent.
 */
export const PI_SETTING_KEYS = /** @type {const} */ ([
  // Capture
  "autoCapture",
  "captureAssistantTurns",
  "captureToolResults",
  "commitTokenThreshold",
  "commitKeepRecentCount",
  // Recall
  "recallTokenBudget",
  "recallLimit",
  "scoreThreshold",
  "recallMaxContentChars",
  "recallPreferAbstract",
  "minQueryLength",
  "recallQueryExpansion",
  "recallLedger",
  // Context and takeover
  "takeoverEnabled",
  "takeoverTokenThreshold",
  "takeoverKeepRecentTurns",
  "takeoverOverviewBudget",
  "profileTokenBudget",
  "resumeContextBudget",
  // Interface and advanced
  "statusBarLevel",
  "logLevel",
  "workspacePeer",
  "recallPeerScope",
  "captureMaxLength",
  "captureToolMaxChars",
  "takeoverOverviewPollMs",
  "takeoverOverviewPollMax",
  "bypassSession",
  "debug",
]);
