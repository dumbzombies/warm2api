// Anthropic SSE → OpenAI Chat Completions frames. The two surfaces disagree on
// tool-call indexing and finish reasons; both are folded here once.

import { mergeUsage } from "../upstream.ts";
import type {
  AnthropicEvent,
  AnthropicUsage,
  OpenAIChatResponse,
  OpenAIUsage,
  OpenAIToolCall,
} from "../types.ts";

export interface OpenAIContext {
  id: string;
  model: string;
  includeUsage: boolean;
  onUsage?: (usage: OpenAIUsage, raw: AnthropicUsage) => void;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
  pause_turn: "stop",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(value: unknown): Partial<AnthropicUsage> {
  const record = asRecord(value) ?? {};
  return {
    input_tokens: numeric(record.input_tokens),
    output_tokens: numeric(record.output_tokens),
    cache_read_input_tokens: numeric(record.cache_read_input_tokens),
    cache_creation_input_tokens: numeric(record.cache_creation_input_tokens),
  };
}

export function toOpenAIUsage(u: AnthropicUsage): OpenAIUsage {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const prompt = u.input_tokens + cacheRead + (u.cache_creation_input_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens,
    total_tokens: prompt + u.output_tokens,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

interface Sink {
  content(text: string): void;
  reasoning(text: string): void;
  toolStart(index: number, id: string, name: string): void;
  toolArgs(index: number, partial: string): void;
}

async function fold(
  events: AsyncIterable<AnthropicEvent>,
  sink: Sink,
): Promise<{ usage: AnthropicUsage; finish: string | null }> {
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let finish: string | null = null;
  let toolCount = 0;
  let currentTool: number | null = null;

  for await (const event of events) {
    if (event.type === "message_start") {
      usage = mergeUsage(usage, usageFrom(asRecord(event.message)?.usage));
      continue;
    }
    if (event.type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (!block) continue;
      if (block.type === "tool_use") {
        currentTool = toolCount;
        toolCount += 1;
        sink.toolStart(currentTool, String(block.id ?? ""), String(block.name ?? ""));
      } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        sink.content(block.text);
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (!delta) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        sink.content(delta.text);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        sink.reasoning(delta.thinking);
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        currentTool !== null
      ) {
        sink.toolArgs(currentTool, delta.partial_json);
      }
      continue;
    }
    if (event.type === "message_delta") {
      usage = mergeUsage(usage, usageFrom(event.usage));
      const stop = asRecord(event.delta)?.stop_reason;
      if (typeof stop === "string") finish = FINISH[stop] ?? "stop";
    }
  }
  return { usage, finish };
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A blocking queue so a push-driven fold can feed a pull-driven generator. */
class FrameQueue {
  private items: string[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(item: string): void {
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *drain(): AsyncGenerator<string> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiter = resolve;
      await promise;
    }
  }
}

/** Stream OpenAI chunks. `usage` stays null until the totals are known. */
export async function* sseToOpenAI(
  events: AsyncIterable<AnthropicEvent>,
  ctx: OpenAIContext,
): AsyncGenerator<string> {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${ctx.id}`;
  const chunk = (delta: unknown, finishReason: string | null, usage: OpenAIUsage | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(ctx.includeUsage ? { usage } : {}),
  });

  const queue = new FrameQueue();
  let failure: unknown = null;

  const work = (async () => {
    queue.push(frame(chunk({ role: "assistant" }, null)));
    const { usage, finish } = await fold(events, {
      content: (text) => queue.push(frame(chunk({ content: text }, null))),
      reasoning: (text) => queue.push(frame(chunk({ reasoning_content: text }, null))),
      toolStart: (index, toolId, name) =>
        queue.push(
          frame(
            chunk(
              { tool_calls: [{ index, id: toolId, type: "function", function: { name, arguments: "" } }] },
              null,
            ),
          ),
        ),
      toolArgs: (index, partial) =>
        queue.push(frame(chunk({ tool_calls: [{ index, function: { arguments: partial } }] }, null))),
    });
    const usageOut = toOpenAIUsage(usage);
    ctx.onUsage?.(usageOut, usage);
    queue.push(frame(chunk({}, finish ?? "stop")));
    if (ctx.includeUsage) {
      queue.push(frame({ id, object: "chat.completion.chunk", created, model: ctx.model, choices: [], usage: usageOut }));
    }
    queue.push("data: [DONE]\n\n");
  })().catch((err: unknown) => {
    failure = err;
  }).finally(() => queue.end());

  for await (const out of queue.drain()) yield out;
  await work;
  if (failure) throw failure;
}

export async function collectOpenAI(
  events: AsyncIterable<AnthropicEvent>,
  ctx: { id: string; model: string; onUsage?: (usage: OpenAIUsage, raw: AnthropicUsage) => void },
): Promise<OpenAIChatResponse> {
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  const calls: OpenAIToolCall[] = [];

  const { usage, finish } = await fold(events, {
    content: (text) => {
      content += text;
    },
    reasoning: (text) => {
      reasoning += text;
    },
    toolStart: (index, id, name) => {
      calls[index] = { id, type: "function", function: { name, arguments: "" } };
    },
    toolArgs: (index, partial) => {
      const call = calls[index];
      if (call) call.function.arguments += partial;
    },
  });

  const openaiUsage = toOpenAIUsage(usage);
  ctx.onUsage?.(openaiUsage, usage);

  const toolCalls = calls.filter((call): call is OpenAIToolCall => Boolean(call));
  const message: OpenAIChatResponse["choices"][number]["message"] = {
    role: "assistant",
    content: content.length > 0 ? content : toolCalls.length > 0 ? null : "",
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: `chatcmpl-${ctx.id}`,
    object: "chat.completion",
    created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        logprobs: null,
      },
    ],
    usage: openaiUsage,
  };
}
