export function getAgentPrompt(event: {
  messageType?: string;
  prompt?: string;
  message?: { content?: unknown };
}): string;

export function appendSystemPrompt(systemPrompt: string, additions: string): string;
export function appendSystemPrompt(systemPrompt: string[], additions: string): string[];
