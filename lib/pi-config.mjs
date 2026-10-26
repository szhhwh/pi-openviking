/**
 * Pi's configuration resolution and settings sidecar.
 *
 * Lives in `lib/` so the doctor script — a plain Node entrypoint that cannot
 * import TypeScript — resolves exactly the same configuration the extension
 * does. `config.ts` is the typed view over this module.
 *
 * Resolution: env → workspace `.openviking/config.json` → `plugin.pi` →
 * `plugin` → defaults, then the settings sidecar this page writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KNOB_BY_NAME, coerceKnobValue } from "../shared/config-schema.mjs";
import { loadCredentialFiles, readManifestVersion } from "../shared/credentials.mjs";
import { PI_SETTING_KEYS } from "./pi-settings.mjs";
import { buildPluginConfig, resolveSettings } from "../shared/plugin-config.mjs";
import { resolveEffectivePeerId } from "../shared/workspace-peer.mjs";

/** Extension root (this file sits in `<root>/lib`). */
export const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXTENSION_VERSION = readManifestVersion(join(EXTENSION_ROOT, "package.json"));

/**
 * The settings file, outside the install checkout on purpose: `pi update`
 * resets the git package and runs `git clean -fdx`, which would delete a
 * sidecar that lived beside this module.
 */
export const PI_SETTINGS_PATH = process.env.OPENVIKING_PI_SETTINGS
  || join(homedir(), ".openviking", "pi-settings.json");

export const DEFAULT_DEBUG_LOG_PATH = join(homedir(), ".openviking", "logs", "pi.jsonl");

export const STATUS_BAR_LEVELS = ["hidden", "minimal", "standard", "verbose"];
const DEFAULT_STATUS_BAR_LEVEL = "standard";

/**
 * The settings the panel edits. The canonical list lives in
 * `pi-settings.mjs`; keeping the alias here lets the sidecar and doctor share
 * one allowlist without duplicating the keys.
 */
export const PI_UI_KEYS = PI_SETTING_KEYS;

/** Keys from earlier layouts: removed on the next save, never read. */
const LEGACY_KEYS = [
  "enabled",
  "syncTurns",
  "bypassPatterns",
  "statusBar",
  "statusBarEnabled",
  "takeover",
];

const SENTINEL = Symbol("invalid");

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function normalizeStatusBarLevel(value) {
  const word = String(value ?? "").trim().toLowerCase();
  return STATUS_BAR_LEVELS.includes(word) ? word : DEFAULT_STATUS_BAR_LEVEL;
}

/** Read the panel's own settings file, coerced against the shared schema. */
export function readSettingsSidecar() {
  const raw = readJson(PI_SETTINGS_PATH);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out = {};
  for (const key of PI_UI_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (key === "statusBarLevel") {
      if (STATUS_BAR_LEVELS.includes(String(raw[key]).trim().toLowerCase())) {
        out[key] = normalizeStatusBarLevel(raw[key]);
      }
      continue;
    }
    const knob = KNOB_BY_NAME.get(key);
    if (!knob) continue;
    const value = coerceKnobValue(knob, raw[key], SENTINEL);
    if (value !== SENTINEL) out[key] = value;
  }
  return out;
}

/**
 * Resolve the whole pi configuration.
 *
 * `applySidecar` is off for tests and for callers that only want the shared
 * layer stack; the extension itself applies the panel's choices on top.
 */
export function resolvePiConfig({ cwd = process.cwd(), applySidecar = true } = {}) {
  const config = buildPluginConfig("pi", {
    cwd,
    version: EXTENSION_VERSION,
    deriveEffectivePeer: true,
  });

  // Pi ships takeover off. The shared schema defaults it on for harnesses that
  // delivered it first, so only an explicit layer may turn it on here. The
  // check has to read the same layers buildPluginConfig did, ov.conf included:
  // resolving without the legacy section made an ov.conf opt-in look absent.
  const files = loadCredentialFiles(process.env);
  const legacy = files.ovFile?.pi && typeof files.ovFile.pi === "object" && !Array.isArray(files.ovFile.pi)
    ? files.ovFile.pi
    : {};
  const { configured } = resolveSettings("pi", {
    cwd,
    clientVersion: EXTENSION_VERSION,
    legacy,
    cliFile: files.cliFile,
  });
  const takeoverEnabled = configured.has("takeoverEnabled") ? config.takeoverEnabled : false;

  const merged = {
    ...config,
    takeoverEnabled,
    statusBarLevel: DEFAULT_STATUS_BAR_LEVEL,
  };

  // buildPluginConfig resolves the explicit peer and the workspace-derived one
  // separately; pi always uses the effective pair, including the legacy id
  // that `actor` recall still has to reach.
  if (config.effectivePeer) {
    merged.peerId = config.effectivePeer.peerId || config.peerId;
    merged.legacyPeerId = config.effectivePeer.legacyPeerId || config.legacyPeerId || "";
  }

  let explicitDebug;
  if (applySidecar) {
    const sidecar = readSettingsSidecar();
    explicitDebug = sidecar.debug;
    Object.assign(merged, sidecar);
    // Peer derivation ran before the sidecar existed, so a saved switch that
    // disables or re-enables it has to be re-applied here or the next start
    // would keep sending the peer the panel just turned off.
    if (sidecar.workspacePeer !== undefined) {
      const effective = resolveEffectivePeerId({
        cfg: { ...merged, peerId: merged.explicitPeerId || "" },
        cwd,
      });
      merged.peerId = effective.peerId;
      merged.legacyPeerId = effective.legacyPeerId;
    }
  }

  // The master switch is gone: a disabled extension cannot open the panel that
  // would re-enable it, so capture must not read a stale `enabled` either.
  delete merged.enabled;

  // A panel "off" is authoritative even when a log path is configured; without
  // an explicit panel choice, setting a path still enables logging as before.
  merged.debug = explicitDebug !== undefined
    ? Boolean(explicitDebug)
    : Boolean(merged.debug) || Boolean(merged.debugLogPath);
  merged.debugLogPath = merged.debug ? (merged.debugLogPath || DEFAULT_DEBUG_LOG_PATH) : "";
  merged.statusBarLevel = normalizeStatusBarLevel(merged.statusBarLevel);

  return merged;
}

/**
 * Write the panel's settings back. Unknown keys are preserved, the known
 * legacy keys are dropped, and credentials are never written.
 */
export function savePiConfig(config, keys = PI_UI_KEYS) {
  const existing = readJson(PI_SETTINGS_PATH);
  const next = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...existing }
    : {};

  // Persist only what the panel changed. Writing every allowlisted key would
  // pin env- and ovcli-derived values the user never touched, silently
  // shadowing later changes to those layers.
  const wanted = new Set(
    (Array.isArray(keys) ? keys : [keys]).filter((key) => PI_UI_KEYS.includes(key)),
  );

  for (const key of LEGACY_KEYS) delete next[key];
  for (const key of wanted) {
    if (config[key] === undefined) continue;
    next[key] = key === "statusBarLevel"
      ? normalizeStatusBarLevel(config[key])
      : config[key];
  }

  try {
    mkdirSync(dirname(PI_SETTINGS_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(PI_SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    try { chmodSync(PI_SETTINGS_PATH, 0o600); } catch { /* pre-existing file */ }
    return true;
  } catch {
    return false;
  }
}
