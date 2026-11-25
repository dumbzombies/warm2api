// Anthropic SDK conformance against the proxying surface.

import { afterAll, beforeAll, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { boot, type Harness } from "./harness.ts";
import { getDb } from "../src/db.ts";

let h: Harness;
let client: Anthropic;

beforeAll(async () => {
  h = await boot({ accounts: 1 });
  client = new Anthropic({ baseURL: h.server.url, apiKey: h.config.apiKey });
});

afterAll(async () => {
  await h.close();
});

test("non-streaming message returns text, stop_reason and usage", async () => {
  h.upstream.set({ fixture: "text" });
  const message = await client.messages.create({
    model: "gpt-5.6-luna",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
  const block = message.content[0];
  expect(block?.type).toBe("text");
  expect(message.stop_reason).toBe("end_turn");
  expect(message.usage.input_tokens).toBeGreaterThan(0);
  expect(message.usage.output_tokens).toBeGreaterThan(0);
  if (block?.type === "text") expect(block.text).toBe("Hello from Warm");
});

test("streaming surfaces text deltas and message_stop", async () => {
  h.upstream.set({ fixture: "text" });
  const stream = client.messages.stream({
    model: "gpt-5.6-luna",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });

  let text = "";
  let sawStop = false;
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") text += event.delta.text;
    if (event.type === "message_stop") sawStop = true;
  }
  expect(text).toBe("Hello from Warm");
  expect(sawStop).toBe(true);
});

test("tool use arrives as a parsed tool_use block", async () => {
  h.upstream.set({ fixture: "tool-call" });
  const message = await client.messages.create({
    model: "gpt-5.6-luna",
    max_tokens: 128,
    messages: [{ role: "user", content: "weather in Paris?" }],
    tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object" } }],
  });
  const toolUse = message.content.find((block) => block.type === "tool_use");
  expect(toolUse).toBeDefined();
  if (toolUse && toolUse.type === "tool_use") {
    expect(toolUse.name).toBe("get_weather");
    expect(toolUse.input).toEqual({ city: "Paris" });
  }
  expect(message.stop_reason).toBe("tool_use");
});

test("count_tokens is a positive estimate that scales with text", async () => {
  const short = await client.messages.countTokens({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hello there" }],
  });
  const long = await client.messages.countTokens({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hello there hello there hello there hello there" }],
  });
  expect(Number.isInteger(short.input_tokens)).toBe(true);
  expect(short.input_tokens).toBeGreaterThan(0);
  expect(long.input_tokens).toBeGreaterThan(short.input_tokens);
});

test("prompt-caching blocks pass through unchanged", async () => {
  h.upstream.set({ fixture: "text" });
  await client.messages.create({
    model: "gpt-5.6-luna",
    max_tokens: 64,
    system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });
  const captured = h.upstream.messages[h.upstream.messages.length - 1];
  const system = captured?.body?.system as Array<Record<string, unknown>> | undefined;
  expect(system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  expect(String(captured?.headers["anthropic-beta"])).toContain("prompt-caching-2024-07-31");
});

test("a mid-stream upstream error surfaces and is logged as 529", async () => {
  h.upstream.set({ fixture: "error-overloaded" });
  const before = getDb().query("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };

  let failed = false;
  try {
    // `create` resolves to the event stream only once awaited in this SDK version.
    const stream = await client.messages.create({
      model: "gpt-5.6-luna",
      max_tokens: 64,
      messages: [{ role: "user", content: "boom" }],
      stream: true,
    });
    for await (const _event of stream) {
      /* drain until the error frame arrives */
    }
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);

  // The proxy writes the audit row before it emits the error frame, so the row
  // is already there by the time the SDK throws.
  const after = getDb().query("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
  expect(after.n).toBeGreaterThan(before.n);
  const row = getDb()
    .query<{ status: number; error_code: string | null }, []>(
      "SELECT status, error_code FROM request_log ORDER BY id DESC LIMIT 1",
    )
    .get();
  expect(row?.status).toBe(529);
  expect(row?.error_code).toBe("overloaded");
});
