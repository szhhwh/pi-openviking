// Abort semantics for the Esc-interrupt fix: the agent abort signal must
// cancel in-flight retrieval fetches, short-circuit the fallback chain, and
// leave the recall block empty for the cancelled turn.
import assert from "node:assert/strict";
import { OVClient } from "../client.ts";
import { RecallManager } from "../recall.ts";

const cfg = {
  endpoint: "http://ov.test", apiKey: "", account: "", user: "", peerId: "",
  minQueryLength: 3, recallLimit: 6, recallMaxContentChars: 500,
  recallTokenBudget: 2000, scoreThreshold: 0.35,
};
const client = new OVClient(cfg);

// 1. fetchJSON: external abort cancels a hanging fetch immediately
{
  const ctrl = new AbortController();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () =>
      rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
  });
  const t0 = Date.now();
  const pending = client.fetchJSON("/api/v1/search/search", { method: "POST" }, 45000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 50);
  const res = await pending;
  const dt = Date.now() - t0;
  globalThis.fetch = realFetch;
  assert.equal(res.ok, false, "aborted fetch must return ok:false");
  assert.equal(res.error.aborted, true, "error.aborted must flag the user abort");
  assert.ok(dt < 500, `abort must cancel promptly (took ${dt}ms, budget 45s)`);
  console.log(`PASS 1: external abort cancels hanging fetch in ${dt}ms (budget 45s)`);
}

// 2. fetchJSON: timeout path still works without an external signal
{
  const realFetch = globalThis.fetch;
  let sawSignal;
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    sawSignal = init?.signal;
    init?.signal?.addEventListener("abort", () =>
      rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
  });
  const res = await client.fetchJSON("/health", undefined, 80);
  globalThis.fetch = realFetch;
  assert.equal(res.ok, false);
  assert.equal(res.error.aborted, true, "timeout abort is also flagged");
  assert.ok(sawSignal, "fetch must receive the combined timeout signal");
  console.log("PASS 2: internal timeout still aborts and is flagged");
}

// 3. searchPending: pre-aborted signal short-circuits, zero requests
{
  const calls = [];
  const mockClient = {
    fetchJSON: async (path, init, timeoutMs, signal) => {
      calls.push({ path, timeoutMs, signal });
      return { ok: false, result: null, status: 0, error: { message: "down" } };
    },
  };
  const recall = new RecallManager(mockClient, cfg);
  recall.queueSearch("does viking recall abort cleanly");
  const block = await recall.searchPending(AbortSignal.abort());
  assert.equal(block, null);
  assert.equal(calls.length, 0, "no requests may be made after abort");
  console.log("PASS 3: pre-aborted searchPending issues zero requests");
}

// 4. searchPending: signal reaches every fetchJSON call as 4th arg
{
  const calls = [];
  const mockClient = {
    fetchJSON: async (path, init, timeoutMs, signal) => {
      calls.push({ path, timeoutMs, signal });
      // context face fails -> recall-core falls back through the chain
      return { ok: false, result: null, status: 0, error: { message: "down" } };
    },
  };
  const ctrl = new AbortController();
  const recall = new RecallManager(mockClient, cfg);
  recall.queueSearch("does viking recall abort cleanly");
  await recall.searchPending(ctrl.signal);
  assert.ok(calls.length > 0, "fallback chain ran");
  for (const c of calls) {
    assert.equal(c.signal, ctrl.signal, `signal must be threaded to ${c.path}`);
  }
  console.log(`PASS 4: signal threaded to all ${calls.length} fetchJSON calls in fallback chain`);
}

// 5. searchPending: abort mid-flight stops the hanging request fast
{
  const ctrl = new AbortController();
  const mockClient = {
    fetchJSON: (path, init, timeoutMs, signal) => new Promise((resolve) => {
      // Mirror real fetch semantics: a signal already aborted at call time
      // rejects immediately instead of hanging.
      if (signal?.aborted) {
        return resolve({ ok: false, result: null, status: 0, error: { message: "aborted", aborted: true } });
      }
      const t = setTimeout(() => resolve({ ok: true, result: { rendered: "late" } }), 30000);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve({ ok: false, result: null, status: 0, error: { message: "aborted", aborted: true } });
      }, { once: true });
    }),
  };
  const recall = new RecallManager(mockClient, cfg);
  recall.queueSearch("does viking recall abort cleanly");
  const t0 = Date.now();
  const pending = recall.searchPending(ctrl.signal);
  setTimeout(() => ctrl.abort(), 50);
  const block = await pending;
  const dt = Date.now() - t0;
  assert.equal(block, null, "aborted recall yields no block");
  assert.ok(dt < 500, `mid-flight abort must return fast (took ${dt}ms)`);
  console.log(`PASS 5: mid-flight abort returns in ${dt}ms instead of 30s`);
}

console.log("\nAll abort-semantics checks passed.");
