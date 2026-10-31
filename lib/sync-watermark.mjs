/**
 * Persistent capture watermark for sessions without takeover.
 *
 * `SyncManager.syncedEntryCount` lives in process memory. Takeover persists its
 * own copy in the pi session branch, but pi ships takeover off, so a continued
 * session (`pi -c` / `omp -c`) started at entry 0 and the first `turn_end`
 * re-uploaded the whole branch to OpenViking — every tool call and result a
 * second time. One JSON file per pi session under
 * `~/.openviking/pi-sync-watermark/`, written atomically.
 *
 * The file stores the entry id at the watermark as well as the count: a branch
 * that was rewritten (compaction, /tree navigation) must not resume from a
 * count that now points at different content. A corrupt or stale file only
 * costs one replay, never a skipped capture.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WATERMARK_VERSION = 1;

export function defaultWatermarkDir() {
  return process.env.OPENVIKING_SYNC_WATERMARK_DIR
    || join(homedir(), ".openviking", "pi-sync-watermark");
}

function filePath(dir, sessionId) {
  // Session ids are uuids today; sanitize anyway so a hostile id cannot escape the dir.
  const safe = String(sessionId || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${safe}.json`);
}

/**
 * Read the watermark recorded for a pi session.
 * Returns `{ count, lastEntryId, ovSessionId }` or null when absent/unusable.
 */
export function loadWatermark(sessionId, dir = defaultWatermarkDir()) {
  if (!sessionId) return null;
  try {
    const data = JSON.parse(readFileSync(filePath(dir, sessionId), "utf-8"));
    if (!data || data.version !== WATERMARK_VERSION) return null;
    const count = Math.max(0, Math.floor(Number(data.count) || 0));
    if (!count) return null;
    return {
      count,
      lastEntryId: typeof data.lastEntryId === "string" ? data.lastEntryId : "",
      ovSessionId: typeof data.ovSessionId === "string" ? data.ovSessionId : "",
    };
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), same durability pattern as the pending queue. */
export function saveWatermark(sessionId, { count, lastEntryId = "", ovSessionId = "" } = {}, dir = defaultWatermarkDir()) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  if (!sessionId || !value) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    try { chmodSync(dir, DIR_MODE); } catch { /* pre-existing dir */ }
    const target = filePath(dir, sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      version: WATERMARK_VERSION,
      count: value,
      lastEntryId: String(lastEntryId || ""),
      ovSessionId: String(ovSessionId || ""),
    }), { mode: FILE_MODE });
    renameSync(tmp, target);
    return true;
  } catch {
    // Best effort; a failed write degrades to the pre-watermark behaviour.
    return false;
  }
}

/**
 * Does the persisted watermark still describe this branch?
 *
 * Rejects a count past the end (branch shrank), an id mismatch (the entry at
 * the watermark changed, so the branch was rewritten), and a watermark for a
 * different OpenViking session. A branch whose entries carry no ids (hosts
 * without them) can only be checked by count.
 */
export function watermarkMatches(watermark, branch, ovSessionId = "") {
  if (!watermark || !Array.isArray(branch)) return false;
  const count = Math.max(0, Math.floor(Number(watermark.count) || 0));
  if (count <= 0 || count > branch.length) return false;
  if (watermark.ovSessionId && ovSessionId && watermark.ovSessionId !== ovSessionId) return false;
  if (watermark.lastEntryId) {
    return branch[count - 1]?.id === watermark.lastEntryId;
  }
  return true;
}
