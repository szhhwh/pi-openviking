#!/usr/bin/env node
/**
 * Full diagnostics for the pi extension.
 *
 * The shared doctor owns argument parsing, environment checks, connection
 * probes and report rendering. This entry supplies only what is pi-specific:
 * where the extension is installed, how this harness resolves its config, and
 * which local state directories exist.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  countDirEntries,
  credentialSources,
  homeShort,
  inspectConfigFiles,
  reportCredentials,
  reportPeer,
  reportTimeouts,
  reportToggles,
  runDoctor,
  scanDebugLog,
} from "../shared/doctor-core.mjs";
import {
  EXTENSION_ROOT,
  EXTENSION_VERSION,
  PI_SETTINGS_PATH,
  readSettingsSidecar,
  resolvePiConfig,
} from "../lib/pi-config.mjs";

const host = {
  harness: "pi",
  pluginRoot: EXTENSION_ROOT,
  launcherHint: "pi",
  cliName: "pi",

  loadConfig() {
    return resolvePiConfig();
  },

  resolveIdentity(cfg) {
    return { account: cfg.account, user: cfg.user };
  },

  checkInstall(report) {
    report.section("Install");
    report.ok(`pi-openviking ${EXTENSION_VERSION || "unknown"}`, EXTENSION_ROOT);
    const entry = join(EXTENSION_ROOT, "index.ts");
    if (existsSync(entry)) report.ok(`extension entry ${homeShort(entry)}`);
    else report.fail("extension entry is missing", homeShort(entry), "reinstall the package");
    const sidecar = readSettingsSidecar();
    const overrides = Object.keys(sidecar).length;
    report.info(
      `settings ${homeShort(PI_SETTINGS_PATH)} — ${overrides ? `${overrides} key(s) set by the panel` : "not overriding anything"}`,
    );
  },

  checkConfig(report, cfg, spec) {
    const { cliConf, ovConf } = inspectConfigFiles(report, { harness: "pi", launcherHint: "pi" });
    const sources = credentialSources(cfg, cliConf, ovConf, { section: "pi" });
    const identity = spec.resolveIdentity(cfg);
    const keyInfo = reportCredentials(report, cfg, sources, identity);
    const peer = reportPeer(report, cfg, { cwd: process.cwd() });

    report.section("Tuning");
    reportToggles(report, cfg, { harness: "pi" }, [
      "autoCapture",
      "recallLedger",
      "takeoverEnabled",
    ]);
    reportTimeouts(report, cfg, { launcherHint: "pi" });
    if (cfg.takeoverEnabled) {
      report.info(
        `takeover on at ${cfg.takeoverTokenThreshold} tokens, keeping ${cfg.takeoverKeepRecentTurns} turn(s)`,
      );
    } else {
      report.info("takeover off; pi's own compaction owns long sessions");
    }

    return { keyInfo, peer, cliConf, ovConf };
  },

  checkActivity(report, cfg) {
    report.section("Activity");

    const pendingDir = process.env.OPENVIKING_PENDING_DIR
      || join(homedir(), ".openviking", "pending");
    const pending = countDirEntries(pendingDir, (name) => name.endsWith(".json"));
    if (pending === null) report.info(`pending queue ${homeShort(pendingDir)} not present`);
    else if (pending === 0) report.ok("pending queue empty");
    else report.warn(
      `${pending} write(s) waiting in the pending queue`,
      homeShort(pendingDir),
      "check the connection; queued writes replay at the next session start",
    );

    const ledgerDir = process.env.OPENVIKING_RECALL_LEDGER_DIR
      || join(homedir(), ".openviking", "pi-recall-ledger");
    const ledgers = countDirEntries(ledgerDir, (name) => name.endsWith(".json"));
    if (ledgers === null) report.info(`recall ledger ${homeShort(ledgerDir)} not present`);
    else report.ok(`recall ledger holds ${ledgers} session file(s)`);

    if (!cfg.debugLogPath) {
      report.info("debug log off (enable it under Advanced in /viking)");
      return;
    }
    const log = scanDebugLog(cfg.debugLogPath);
    if (!log.exists) {
      report.info(`debug log ${homeShort(cfg.debugLogPath)} not written yet`);
      return;
    }
    report.info(`debug log ${homeShort(cfg.debugLogPath)} — ${log.lines} line(s)`);
    for (const error of (log.recentErrors || []).slice(0, 3)) {
      report.warn(
        `${error.hook || "pi"} ${error.stage || ""} error`,
        error.message,
        `inspect ${homeShort(cfg.debugLogPath)}`,
      );
    }
  },

  extraResolved() {
    return { settingsPath: PI_SETTINGS_PATH };
  },
};

await runDoctor(host);
