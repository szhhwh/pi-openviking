import {
  extractPartsFromPayload,
  extractTextFromPayload,
  sanitizeCapturedText,
  shouldCaptureText,
  truncateCaptureText,
} from "../shared/capture-utils.mjs";

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "tool" || value === "tool_result" || value === "toolresult") return "user";
  if (value === "tool_call" || value === "toolcall") return "assistant";
  return "";
}

const TOOL_RESULT_ROLES = new Set([
  "tool",
  "tool_result",
  "toolresult",
  "function",
  "function_call_output",
  "functioncalloutput",
]);

function normalizeTypeName(value) {
  return String(value || "").toLowerCase().replace(/[-\s]/g, "_");
}

/** A payload that is nothing but a tool result (Pi: `toolResult`, OpenAI: `tool`). */
function isToolResultPayload(payload) {
  return TOOL_RESULT_ROLES.has(normalizeTypeName(payload?.role || payload?.type || payload?.kind));
}

/** A structured part carrying tool output rather than a tool call's input. */
function isToolResultPart(part) {
  return part?.type === "tool" && Object.prototype.hasOwnProperty.call(part, "tool_output");
}

function entryPayload(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return entry.message;
  }
  if (entry.message && typeof entry.message === "object") return entry.message;
  return entry;
}

function faithfulDecision(rawText, cfg) {
  const sanitized = sanitizeCapturedText(rawText);
  if (!sanitized) return { shouldCapture: false, reason: "empty", text: "" };
  const capped = truncateCaptureText(sanitized, cfg.captureMaxLength || 24000);
  const compact = String(capped || "").replace(/\s+/g, " ").trim();
  if (/^\[openviking-memory\]/i.test(compact)) {
    return { shouldCapture: false, reason: "plugin_status", text: "" };
  }
  if (/^\/[a-z0-9_-]{1,64}\b/i.test(compact)) {
    return { shouldCapture: false, reason: "slash_command", text: "" };
  }
  return { shouldCapture: true, reason: "faithful", text: capped };
}

export function extractBranchCapturePayloads(branch, syncedEntryCount = 0, cfg = {}) {
  const entries = Array.isArray(branch) ? branch : [];
  const previousCount = Math.max(0, Number(syncedEntryCount) || 0);
  const resetWatermark = entries.length < previousCount;
  const start = resetWatermark ? 0 : Math.min(previousCount, entries.length);
  // Tool output dominates a coding session's bytes and the pending-token count
  // that drives commits, while the tool call's input already tells the
  // extractor what ran. Off by default (README/config schema), so the gate
  // drops result-only entries and result parts unless it is explicitly on.
  const keepToolResults = cfg.captureToolResults === true;
  const payloads = [];

  for (const entry of entries.slice(start)) {
    const payload = entryPayload(entry);
    if (!payload) continue;
    if (!keepToolResults && isToolResultPayload(payload)) continue;

    const role = normalizeRole(payload.role || payload.type || payload.kind);
    if (!role) continue;
    if (role === "assistant" && cfg.captureAssistantTurns === false) continue;

    const parts = extractPartsFromPayload(payload, { toolMaxChars: cfg.captureToolMaxChars });
    const structuredParts = parts.filter(
      (part) => part?.type !== "text" && (keepToolResults || !isToolResultPart(part)),
    );
    // With results off, the decision must read the conversation text only:
    // extractTextFromPayload() renders result parts as "[tool-result ...]"
    // lines, which would carry the dropped output into `content` instead.
    const rawText = keepToolResults
      ? extractTextFromPayload(payload, { toolMaxChars: cfg.captureToolMaxChars })
      : parts
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n\n");
    const decision = cfg.faithfulCapture || cfg.takeoverEnabled
      ? faithfulDecision(rawText, cfg)
      : shouldCaptureText(rawText, role, cfg);
    if (!decision.shouldCapture && structuredParts.length === 0) continue;

    // decision.text is derived from rawText, which renders tool I/O as
    // "[tool-result ...]" lines. For a tool-only payload that would resend the
    // same output the tool part already carries, so only keep it when the
    // payload really had text of its own.
    const hasTextPart = parts.some((part) => part?.type === "text");
    const bodyParts = [
      ...(hasTextPart && decision.shouldCapture && decision.text
        ? [{ type: "text", text: decision.text }]
        : []),
      ...structuredParts,
    ];
    const body = bodyParts.length > 0
      ? { role, parts: bodyParts }
      : { role, content: decision.text };
    if (cfg.peerId) body.peer_id = cfg.peerId;
    payloads.push(body);
  }

  return {
    payloads,
    nextEntryCount: entries.length,
    observedEntryCount: entries.length,
    resetWatermark,
  };
}
