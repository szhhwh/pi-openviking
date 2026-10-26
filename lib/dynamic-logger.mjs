/**
 * A logger whose destination can change while the session is running.
 *
 * The panel's debug switch mutates `config.debugLogPath`, but `createLogger`
 * captures its path at construction. This wrapper re-creates the underlying
 * logger when the path changes, so the switch takes effect on the next record
 * instead of at the next process start.
 */
import { createLogger } from "../shared/debug-log.mjs";

export function createDynamicLogger(name, getPath) {
  let path = String(getPath() || "");
  let logger = createLogger(name, { debug: Boolean(path), debugLogPath: path });

  const refresh = () => {
    const next = String(getPath() || "");
    if (next === path) return;
    path = next;
    logger = createLogger(name, { debug: Boolean(path), debugLogPath: path });
  };

  return {
    log(stage, data) {
      refresh();
      logger.log(stage, data);
    },
    logError(stage, error) {
      refresh();
      logger.logError(stage, error);
    },
  };
}
