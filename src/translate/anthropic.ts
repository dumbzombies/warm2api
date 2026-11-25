// Anthropic surface: almost a proxy. Model aliasing, max_tokens clamping and
// (when enabled) attestation aside, events go through untouched.

import { clampMaxTokens } from "./models.ts";
import { mergeUsage } from "../upstream.ts";
import type {
  AnthropicBlock,
  AnthropicEvent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicUsage,
} from "../types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function prepareAnthropicRequest(body: AnthropicRequest, model: string): AnthropicRequest {
  return {
    ...body,
    model,
    max_tokens: clampMaxTokens(model, body.max_tokens),
  };
}

function blockFrom(value: unknown): AnthropicBlock | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;
  return { ...record, type: record.type };
}

function usageFromRecord(value: unknown): Partial<AnthropicUsage> {
  const record = asRecord(value) ?? {};
  return {
    input_tokens: numeric(record.input_tokens),
    output_tokens: numeric(record.output_tokens),
    cache_read_input_tokens: numeric(record.cache_read_input_tokens),
    cache_creation_input_tokens: numeric(record.cache_creation_input_tokens),
  };
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Fold an event stream into the single `message` object a non-stream client expects. */
export async function collectMessage(
  events: AsyncIterable<AnthropicEvent>,
  model: string,
): Promise<AnthropicMessageResponse> {
  let id = `msg_${Math.random().toString(36).slice(2, 12)}`;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: string | null = null;
  let stopSequence: string | null = null;
  const blocks: AnthropicBlock[] = [];
  const partial = new Map<number, string>();

  for await (const event of events) {
    if (event.type === "message_start") {
      const message = asRecord(event.message);
      if (typeof message?.id === "string") id = message.id;
      usage = mergeUsage(usage, usageFromRecord(message?.usage));
      continue;
    }

    if (event.type === "content_block_start") {
      const block = blockFrom(event.content_block);
      const index = numeric(event.index);
      if (!block) continue;
      blocks[index] = block;
      if (block.type === "tool_use") partial.set(index, "");
      continue;
    }

    if (event.type === "content_block_delta") {
      const index = numeric(event.index);
      const block = blocks[index];
      const delta = asRecord(event.delta);
      if (!block || !delta) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partial.set(index, `${partial.get(index) ?? ""}${delta.partial_json}`);
      }
      continue;
    }

    if (event.type === "content_block_stop") {
      const index = numeric(event.index);
      const block = blocks[index];
      const json = partial.get(index);
      if (block?.type === "tool_use" && json !== undefined) {
        try {
          block.input = json.trim().length > 0 ? JSON.parse(json) : {};
        } catch {
          block.input = {};
        }
      }
      continue;
    }

    if (event.type === "message_delta") {
      usage = mergeUsage(usage, usageFromRecord(event.usage));
      const delta = asRecord(event.delta);
      if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      if (typeof delta?.stop_sequence === "string") stopSequence = delta.stop_sequence;
    }
  }

  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: blocks.filter((block) => block !== undefined),
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

/** Re-serialise parsed events as SSE frames for a streaming client. */
export async function* anthropicFrames(events: AsyncIterable<AnthropicEvent>): AsyncGenerator<string> {
  for await (const event of events) {
    yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

export function errorFrame(error: {
  type: string;
  message: string;
}): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`;
}

/**
 * Local token estimate: the gateway has no count_tokens route. ASCII counts as
 * four characters per token, everything else as two, plus per-message framing
 * and the full length of the tool schemas.
 */
export function estimateTokens(body: AnthropicRequest): number {
  let ascii = 0;
  let nonAscii = 0;
  const add = (text: string): void => {
    for (const char of text) {
      if (char.charCodeAt(0) < 128) ascii += 1;
      else nonAscii += 1;
    }
  };

  const addBlocks = (content: AnthropicMessage["content"] | AnthropicBlock[] | undefined): void => {
    if (typeof content === "string") {
      add(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (typeof block.text === "string") add(block.text);
      if (typeof block.thinking === "string") add(block.thinking);
      if (typeof block.content === "string") add(block.content);
      const source = asRecord(block.source);
      if (source) {
        if (typeof source.data === "string") add(source.data);
        if (typeof source.url === "string") add(source.url);
      }
    }
  };

  addBlocks(body.system);
  for (const message of body.messages ?? []) addBlocks(message.content);

  const framing = 4 * (body.messages?.length ?? 0);
  const toolJson = body.tools && body.tools.length > 0 ? JSON.stringify(body.tools) : "";
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 2) + framing + toolJson.length);
}
