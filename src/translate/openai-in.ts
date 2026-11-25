// OpenAI Chat Completions request → Anthropic Messages request. Everything the
// gateway cannot express is either rejected explicitly or emulated in the prompt.

import { unsupportedParameter } from "../errors.ts";
import { clampMaxTokens } from "./models.ts";
import { toolChoiceNudge, toolResultsToAnthropic, toolsToAnthropic } from "./tools.ts";
import type {
  AnthropicBlock,
  AnthropicMessage,
  AnthropicRequest,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIToolMessage,
} from "../types.ts";

export interface TranslationResult {
  request: AnthropicRequest;
  nudge: string | null;
  jsonSchema: unknown | null;
}

const DEFAULT_MAX_TOKENS = 32_000;

function rejectUnsupported(body: OpenAIChatRequest): void {
  if (body.logprobs) throw unsupportedParameter("logprobs");
  if (body.top_logprobs !== undefined && body.top_logprobs !== null) throw unsupportedParameter("top_logprobs");
  if (typeof body.n === "number" && body.n > 1) throw unsupportedParameter("n");
  if (body.seed !== undefined && body.seed !== null) throw unsupportedParameter("seed");

  const format = body.response_format;
  const strictJsonObject =
    format?.type === "json_object" && (format.strict === true || format.json_schema?.strict === true);
  if (strictJsonObject) throw unsupportedParameter("response_format.strict");
  if (body.audio) throw unsupportedParameter("audio");
  if (Array.isArray(body.modalities) && body.modalities.some((m) => m !== "text")) {
    throw unsupportedParameter("modalities");
  }
}

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function imageBlock(part: OpenAIContentPart): AnthropicBlock | null {
  const url = part.image_url?.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function userBlocks(content: OpenAIMessage["content"]): AnthropicBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "image_url") {
      const image = imageBlock(part);
      if (image) blocks.push(image);
    } else {
      console.warn(`[warm2api] dropping unsupported content part: ${part.type}`);
    }
  }
  return blocks;
}

function parseArguments(raw: string | undefined, toolName: string): unknown {
  const text = (raw ?? "").trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`[warm2api] tool call ${toolName} had malformed JSON arguments; sending {}`);
    return {};
  }
}

function assistantBlocks(msg: OpenAIMessage): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  // Signed thinking must lead the assistant turn; unsigned thinking is display-only.
  if (msg.reasoning_content && typeof msg.signature === "string" && msg.signature.length > 0) {
    blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: msg.signature });
  }
  if (typeof msg.content === "string") {
    if (msg.content.length > 0) blocks.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    blocks.push(...userBlocks(msg.content));
  }
  for (const call of msg.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input: parseArguments(call.function?.arguments, call.function?.name ?? ""),
    });
  }
  return blocks;
}

/** Concatenate adjacent same-role turns; the wire format wants strict alternation. */
function mergeAdjacent(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      const previousBlocks = typeof previous.content === "string"
        ? [{ type: "text", text: previous.content }]
        : previous.content;
      const nextBlocks = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
      previous.content = [...previousBlocks, ...nextBlocks];
      continue;
    }
    merged.push({ role: message.role, content: message.content });
  }
  return merged;
}

export function toAnthropicRequest(body: OpenAIChatRequest, model: string): TranslationResult {
  rejectUnsupported(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw unsupportedParameter("messages");
  }

  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of body.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(msg.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    if (msg.role === "user") {
      messages.push({ role: "user", content: userBlocks(msg.content) });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = assistantBlocks(msg);
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      messages.push({ role: "user", content: [toolResultsToAnthropic(msg as OpenAIToolMessage)] });
      continue;
    }
    throw unsupportedParameter(`role:${msg.role}`);
  }

  const choice = body.tool_choice;
  const nudge = toolChoiceNudge(choice);
  if (nudge) systemParts.push(nudge);

  const tools = choice === "none" ? undefined : toolsToAnthropic(body.tools);

  let jsonSchema: unknown | null = null;
  const format = body.response_format;
  if (format?.type === "json_schema") {
    const schema = format.json_schema?.schema ?? format.json_schema ?? null;
    if (schema) {
      jsonSchema = schema;
      systemParts.push(`Respond with JSON only, matching this schema: ${JSON.stringify(schema)}`);
    }
  }

  const maxTokens = clampMaxTokens(model, body.max_tokens ?? body.max_completion_tokens, DEFAULT_MAX_TOKENS);

  const request: AnthropicRequest = {
    model,
    max_tokens: maxTokens,
    messages: mergeAdjacent(messages),
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(tools ? { tools } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
  };

  return { request, nudge, jsonSchema };
}

/** Minimal structural check: object/array/scalar type presence and required keys. */
export function validateJson(value: unknown, schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const spec = schema as Record<string, unknown>;
  const type = spec.type;

  if (typeof type === "string") {
    if (type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return false;
    if (type === "array" && !Array.isArray(value)) return false;
    if (type === "string" && typeof value !== "string") return false;
    if (type === "number" && typeof value !== "number") return false;
    if (type === "integer" && !Number.isInteger(value)) return false;
    if (type === "boolean" && typeof value !== "boolean") return false;
    if (type === "null" && value !== null) return false;
  }

  if (Array.isArray(spec.required) && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of spec.required) {
      if (typeof key === "string" && !(key in record)) return false;
    }
  }

  if (Array.isArray(spec.items) === false && spec.items && Array.isArray(value)) {
    return value.every((item) => validateJson(item, spec.items));
  }
  return true;
}

/** Parse the model's final text as JSON and check it against the schema. */
export function parseJsonResponse(text: string, schema: unknown): { ok: boolean; value?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  return validateJson(parsed, schema) ? { ok: true, value: parsed } : { ok: false };
}
