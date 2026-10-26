import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The sidecar path is read when lib/pi-config.mjs is first imported, so point
// every layer at this test's temp directory before importing the config module.
const dir = await mkdtemp(join(tmpdir(), "ov-pi-sidecar-"));
const settingsPath = join(dir, "pi-settings.json");

process.env.OPENVIKING_PI_SETTINGS = settingsPath;
process.env.OPENVIKING_CREDENTIAL_SOURCE = "env";
process.env.OPENVIKING_URL = "http://127.0.0.1:1933";
process.env.OPENVIKING_CLI_CONFIG_FILE = join(dir, "ovcli.conf");
process.env.OPENVIKING_CONFIG_FILE = join(dir, "ov.conf");
for (const name of [
  "OPENVIKING_API_KEY",
  "OPENVIKING_ACCOUNT",
  "OPENVIKING_USER",
  "OPENVIKING_PEER_ID",
  "OPENVIKING_WORKSPACE_PEER",
  "OPENVIKING_RECALL_PEER_SCOPE",
  "OPENVIKING_DEBUG_LOG",
  "OPENVIKING_DEBUG",
  "OPENVIKING_TAKEOVER",
]) delete process.env[name];

await writeFile(join(dir, "ovcli.conf"), JSON.stringify({ plugin: { pi: {} } }), "utf8");

const { loadEffectiveConfig, saveConfig } = await import("../config.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSettings(value) {
  await writeFile(settingsPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readSettings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

test("sidecar values are coerced and legacy keys are ignored", async () => {
  await writeSettings({
    statusBarLevel: "minimal",
    recallTokenBudget: "4000",
    takeoverEnabled: true,
    workspacePeer: false,
    enabled: false,
    syncTurns: false,
    bypassPatterns: ["/tmp/scratch*"],
    statusBar: { enabled: false, showSession: false },
    takeover: { enabled: false },
    unknownKey: "kept on disk but not read",
  });

  const cfg = loadEffectiveConfig();
  assert.equal(cfg.statusBarLevel, "minimal");
  assert.equal(cfg.recallTokenBudget, 4000, "numeric strings are coerced");
  assert.equal(cfg.takeoverEnabled, true);
  assert.equal(cfg.workspacePeer, false);
  assert.equal(cfg.peerId, "", "disabling workspace derivation re-resolves the peer");
  assert.equal("enabled" in cfg, false);
  assert.equal("syncTurns" in cfg, false);
  assert.equal("bypassPatterns" in cfg, false);
  assert.equal("statusBar" in cfg, false);
});

test("an invalid statusBarLevel falls back to standard", async () => {
  await writeSettings({ statusBarLevel: "loud" });
  assert.equal(loadEffectiveConfig().statusBarLevel, "standard");
});

test("saving one setting leaves untouched keys out of the sidecar", async () => {
  await writeSettings({
    recallTokenBudget: 3000,
    enabled: false,
    statusBar: { enabled: false },
    keepMe: "unknown keys survive",
  });

  const cfg = loadEffectiveConfig();
  cfg.statusBarLevel = "verbose";
  assert.equal(saveConfig(cfg, ["statusBarLevel"]), true);

  const saved = await readSettings();
  assert.deepEqual(
    Object.keys(saved).sort(),
    ["keepMe", "recallTokenBudget", "statusBarLevel"],
    "only the changed key is added; legacy keys are deleted",
  );
  assert.equal(saved.recallTokenBudget, 3000);
  assert.equal(saved.statusBarLevel, "verbose");
});

test("an explicit debug off wins over a configured log path", async () => {
  await writeSettings({ debug: false });
  process.env.OPENVIKING_DEBUG_LOG = join(dir, "debug.jsonl");
  try {
    const cfg = loadEffectiveConfig();
    assert.equal(cfg.debug, false);
    assert.equal(cfg.debugLogPath, "");
  } finally {
    delete process.env.OPENVIKING_DEBUG_LOG;
  }
});
