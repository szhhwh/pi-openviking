import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWatermark,
  saveWatermark,
  watermarkMatches,
} from "../lib/sync-watermark.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ov-watermark-"));
}

test("saveWatermark round-trips count, entry id and session", () => {
  const dir = tempDir();
  try {
    assert.equal(saveWatermark("session-a", {
      count: 42,
      lastEntryId: "entry-42",
      ovSessionId: "pi-session-a",
    }, dir), true);

    assert.deepEqual(loadWatermark("session-a", dir), {
      count: 42,
      lastEntryId: "entry-42",
      ovSessionId: "pi-session-a",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWatermark ignores a missing, corrupt or zero-count file", () => {
  const dir = tempDir();
  try {
    assert.equal(loadWatermark("absent", dir), null);

    writeFileSync(join(dir, "corrupt.json"), "{not json");
    assert.equal(loadWatermark("corrupt", dir), null);

    saveWatermark("zero", { count: 0 }, dir);
    assert.equal(loadWatermark("zero", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveWatermark writes atomically and leaves no temp file", () => {
  const dir = tempDir();
  try {
    saveWatermark("session-b", { count: 3, lastEntryId: "e3" }, dir);
    assert.deepEqual(readdirSync(dir), ["session-b.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watermarkMatches accepts a branch that still has the recorded entry", () => {
  const branch = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.equal(
    watermarkMatches({ count: 3, lastEntryId: "c", ovSessionId: "ov-1" }, branch, "ov-1"),
    true,
  );
});

test("watermarkMatches rejects a rewritten branch with the same length", () => {
  const branch = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(
    watermarkMatches({ count: 3, lastEntryId: "OLD", ovSessionId: "ov-1" }, branch, "ov-1"),
    false,
  );
});

test("watermarkMatches rejects a count past the end, a foreign session, and zero", () => {
  const branch = [{ id: "a" }, { id: "b" }];
  assert.equal(watermarkMatches({ count: 5, lastEntryId: "b", ovSessionId: "ov-1" }, branch, "ov-1"), false);
  assert.equal(watermarkMatches({ count: 2, lastEntryId: "b", ovSessionId: "ov-2" }, branch, "ov-1"), false);
  assert.equal(watermarkMatches({ count: 0, lastEntryId: "", ovSessionId: "" }, branch, "ov-1"), false);
  assert.equal(watermarkMatches({ count: 2, lastEntryId: "b" }, branch, ""), true);
});

test("watermarkMatches falls back to the count when the host has no entry ids", () => {
  const branch = [{}, {}, {}];
  assert.equal(watermarkMatches({ count: 2, lastEntryId: "", ovSessionId: "ov-1" }, branch, "ov-1"), true);
});
