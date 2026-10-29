import test from "node:test";
import assert from "node:assert/strict";
import { getAgentPrompt, appendSystemPrompt } from "../lib/host-events.mjs";
import { RecallManager } from "../recall.ts";

for (const [host, event] of [
  ["oh-my-pi", { prompt: "Recall the deployment decision", systemPrompt: ["policy", "tools"] }],
  ["Pi user", { messageType: "user", prompt: "Recall the deployment decision", systemPrompt: "policy" }],
  ["Pi custom text", { messageType: "custom", message: { content: "Recall the deployment decision" } }],
  ["Pi custom parts", { messageType: "custom", message: { content: [
    { type: "image", data: "ignored" },
    { type: "text", text: "Recall the deployment decision" },
  ] } }],
]) {
  test(`${host} start searches the current prompt and injects its memory`, async () => {
    const queries = [];
    const recall = new RecallManager({
      fetchJSON: async (_path, init) => {
        queries.push(JSON.parse(init.body).query);
        return { ok: true, result: { rendered: "- Deploy using blue/green" } };
      },
    }, {
      minQueryLength: 3, recallLimit: 6, recallMaxContentChars: 500,
      recallTokenBudget: 2000, scoreThreshold: 0.35, peerId: "",
    });
    recall.queueSearch(getAgentPrompt(event));
    await recall.searchPending();
    assert.deepEqual(queries, ["Recall the deployment decision"]);
    const messages = recall.injectRecall([{ role: "user", content: "Recall the deployment decision" }]);
    assert.match(messages[0].content, /Deploy using blue\/green/);
    assert.match(messages[0].content, /Recall the deployment decision$/);
  });
}

test("custom message text takes precedence over a fallback prompt and excludes non-text parts", () => {
  assert.equal(getAgentPrompt({ messageType: "custom", prompt: "stale prompt", message: { content: [
    { type: "text", text: "first" }, { type: "image" }, null,
    { type: "text", text: "second" },
  ] } }), "first\nsecond");
});

test("image-only starts and revived agents have no recall query", () => {
  assert.equal(getAgentPrompt({ prompt: "", reason: "revive" }), "");
  assert.equal(getAgentPrompt({ messageType: "custom", message: { content: [{ type: "image" }] } }), "");
  assert.equal(getAgentPrompt({}), "");
});

test("oh-my-pi policy blocks retain their boundaries without mutating the event", () => {
  const policy = Object.freeze(["first policy, with comma", "second policy"]);
  assert.deepEqual(appendSystemPrompt(policy, "OV context"), [
    "first policy, with comma", "second policy", "OV context",
  ]);
  assert.deepEqual(policy, ["first policy, with comma", "second policy"]);
});

test("Pi system prompts append context with paragraph separation", () => {
  assert.equal(appendSystemPrompt("Pi policy", "OV context"), "Pi policy\n\nOV context");
  assert.equal(appendSystemPrompt("", "OV context"), "OV context");
});
