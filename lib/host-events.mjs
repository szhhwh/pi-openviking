/** Pi distinguishes user/custom starts; oh-my-pi supplies prompt directly. */
export function getAgentPrompt(event) {
  if (event.messageType !== "custom" && typeof event.prompt === "string") {
    return event.prompt;
  }
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Keep oh-my-pi policy blocks separate and Pi's string prompt intact. */
export function appendSystemPrompt(systemPrompt, additions) {
  if (Array.isArray(systemPrompt)) return [...systemPrompt, additions];
  return systemPrompt ? `${systemPrompt}\n\n${additions}` : additions;
}
