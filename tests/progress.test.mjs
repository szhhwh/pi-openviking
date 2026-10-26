// Progress reporting for the request path: the footer phase/elapsed state and
// the recall lifecycle hooks that drive it. Both are pure enough to test
// without a TUI: a fake ctx records the calls pi would receive.

import test from "node:test";
import assert from "node:assert/strict";
import { RecallProgress, formatElapsed } from "../progress.ts";
import { RecallManager } from "../recall.ts";

function fakeCtx() {
  const workingMessages = [];
  const statuses = [];
  return {
    hasUI: true,
    workingMessages,
    statuses,
    ui: {
      setWorkingMessage: (message) => workingMessages.push(message),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  };
}

function snapshotLog() {
  const seen = [];
  const reporter = new RecallProgress((snapshot, ctx) => {
    if (ctx) seen.push(snapshot ? { ...snapshot } : null);
  });
  return { reporter, seen };
}

test("begin publishes a phase, sets the working message, and clears both on end", () => {
  const ctx = fakeCtx();
  const { reporter, seen } = snapshotLog();

  reporter.begin(ctx, "recall");
  assert.deepEqual(ctx.workingMessages, ["0s"]);
  assert.equal(seen.at(-1)?.phase, "recall");
  assert.ok(seen.at(-1).elapsedMs >= 0);
  assert.deepEqual(reporter.snapshot().phase, "recall");

  reporter.end("recall");
  assert.deepEqual(ctx.workingMessages, ["0s", undefined]);
  assert.equal(seen.at(-1), null, "clearing notifies the footer");
  assert.equal(reporter.snapshot(), null);
});

test("same-phase entries nest, mismatched ends are ignored", () => {
  const ctx = fakeCtx();
  const { reporter } = snapshotLog();

  reporter.begin(ctx, "recall");
  reporter.begin(ctx, "recall");
  reporter.end("recall");
  assert.equal(reporter.snapshot()?.phase, "recall", "one holder still active");
  reporter.end("connect");
  assert.equal(reporter.snapshot()?.phase, "recall", "foreign phase cannot clear");
  reporter.end("recall");
  assert.equal(reporter.snapshot(), null);
});

test("connect never downgrades a live recall", () => {
  const ctx = fakeCtx();
  const { reporter } = snapshotLog();

  reporter.begin(ctx, "recall");
  reporter.begin(ctx, "connect");
  assert.equal(reporter.snapshot()?.phase, "recall");
  reporter.end("connect");
  assert.equal(reporter.snapshot()?.phase, "recall", "the ignored begin does not pair");
  reporter.end("recall");
  assert.equal(reporter.snapshot(), null);
});

test("dispose clears an in-flight phase and restores the working message", () => {
  const ctx = fakeCtx();
  const { reporter } = snapshotLog();

  reporter.begin(ctx, "connect");
  reporter.dispose();
  assert.equal(reporter.snapshot(), null);
  assert.deepEqual(ctx.workingMessages, ["0s", undefined]);
  reporter.dispose(); // idempotent
  assert.equal(ctx.workingMessages.length, 2);
});

test("non-UI contexts keep the state machine but skip the working message", () => {
  const ctx = { ...fakeCtx(), hasUI: false };
  const { reporter } = snapshotLog();

  reporter.begin(ctx, "recall");
  assert.deepEqual(ctx.workingMessages, []);
  assert.equal(reporter.snapshot()?.phase, "recall");
  reporter.end("recall");
});

test("formatElapsed is seconds only", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(1000), "1s");
  assert.equal(formatElapsed(2500), "2s");
});

const cfg = {
  endpoint: "http://ov.test", apiKey: "", account: "", user: "", peerId: "",
  minQueryLength: 3, recallLimit: 6, recallMaxContentChars: 500,
  recallTokenBudget: 2000, scoreThreshold: 0.35,
};

test("searchPending brackets the retrieval with onStart/onEnd", async () => {
  const events = [];
  const mockClient = {
    fetchJSON: async () => ({
      ok: false, result: null, status: 0, error: { message: "down" },
    }),
  };
  const recall = new RecallManager(mockClient, cfg);
  recall.queueSearch("query long enough for recall");
  await recall.searchPending(undefined, {
    onStart: () => events.push("start"),
    onEnd: () => events.push("end"),
  });
  assert.deepEqual(events, ["start", "end"]);
});

test("short-circuited searches never announce progress", async () => {
  const events = [];
  const mockClient = {
    fetchJSON: async () => {
      events.push("fetch");
      return { ok: false, result: null, status: 0, error: { message: "down" } };
    },
  };
  const hooks = {
    onStart: () => events.push("start"),
    onEnd: () => events.push("end"),
  };

  // Query below minQueryLength: no request, no progress.
  const shortQuery = new RecallManager(mockClient, cfg);
  shortQuery.queueSearch("hi");
  await shortQuery.searchPending(undefined, hooks);

  // Already-aborted turn: no request, no progress.
  const aborted = new RecallManager(mockClient, cfg);
  aborted.queueSearch("query long enough for recall");
  await aborted.searchPending(AbortSignal.abort(), hooks);

  // Recall switched off: no request, no progress.
  const disabled = new RecallManager(mockClient, { ...cfg, enabled: false });
  disabled.queueSearch("query long enough for recall");
  await disabled.searchPending(undefined, hooks);

  assert.deepEqual(events, [], "no fetch and no progress hooks");
});

test("onEnd fires when the retrieval throws", async () => {
  const events = [];
  const mockClient = {
    fetchJSON: async () => {
      throw new Error("boom");
    },
  };
  const recall = new RecallManager(mockClient, cfg);
  recall.queueSearch("query long enough for recall");
  await assert.rejects(() =>
    recall.searchPending(undefined, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    })
  );
  assert.deepEqual(events, ["start", "end"]);
});
