// OpenAI tools <-> Anthropic tool blocks. The gateway has no `tool_choice`, so
// "required" and a named function are emulated with a system-prompt nudge.

import type { AnthropicBlock, OpenAITool, OpenAIToolCall, OpenAIToolChoice, OpenAIToolMessage } from "../types.ts";

interface AnthropicToolOut {
  name: string;
  description?: string;
  input_schema: unknown;
}

export function toolsToAnthropic(tools: OpenAITool[] | undefined): AnthropicToolOut[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: "object", properties: {} },
  }));
}

export function toolChoiceNudge(choice: OpenAIToolChoice | undefined): string | null {
  if (!choice || choice === "auto" || choice === "none") return null;
  if (choice === "required") return "You must call at least one of the provided tools in this turn.";
  if (typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    return `You must call the tool "${choice.function.name}" in this turn.`;
  }
  return null;
}

/** Every `tool_use` block in order, with `arguments` as the wire JSON text. */
export function toolUsesToCalls(blocks: AnthropicBlock[]): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    calls.push({
      id: String(block.id ?? `call_${calls.length}`),
      type: "function",
      function: {
        name: String(block.name ?? ""),
        arguments: JSON.stringify(block.input ?? {}),
      },
    });
  }
  return calls;
}

/** `role:"tool"` → the `tool_result` block that belongs in a user turn. */
export function toolResultsToAnthropic(msg: OpenAIToolMessage): AnthropicBlock {
  const content = msg.content;
  const normalised =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === "text")
            .map((part) => ({ type: "text", text: part.text ?? "" }))
        : "";
  return {
    type: "tool_result",
    tool_use_id: msg.tool_call_id,
    content: normalised,
    ...(msg.is_error === true ? { is_error: true } : {}),
  };
}
