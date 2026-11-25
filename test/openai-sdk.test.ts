// OpenAI SDK conformance: the official client is the judge, not our own code.

import { afterAll, beforeAll, expect, test } from "bun:test";
import OpenAI from "openai";
import { boot, type Harness } from "./harness.ts";
import { getDb } from "../src/db.ts";
import { listAccounts } from "../src/accounts.ts";

let h: Harness;
let client: OpenAI;

beforeAll(async () => {
  h = await boot({ accounts: 1 });
  client = new OpenAI({ baseURL: `${h.server.url}/v1`, apiKey: h.config.apiKey });
});

afterAll(async () => {
  await h.close();
});

test("non-streaming completion returns text and usage", async () => {
  h.upstream.set({ fixture: "text" });
  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(completion.choices[0].message.content).toBe("Hello from Warm");
  expect(completion.usage?.prompt_tokens ?? 0).toBeGreaterThan(0);
  expect(completion.choices[0].finish_reason).toBe("stop");
});

test("streaming deltas join to the same text", async () => {
  h.upstream.set({ fixture: "text" });
  const stream = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  let text = "";
  let finish: string | null = null;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content ?? "";
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
  }
  expect(text).toBe("Hello from Warm");
  expect(finish).toBe("stop");
});

test("tool_choice required yields a tool call", async () => {
  h.upstream.set({ fixture: "tool-call" });
  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "weather in Paris?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    tool_choice: "required",
  });
  const call = completion.choices[0].message.tool_calls?.[0];
  expect(call?.function.name).toBe("get_weather");
  expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({ city: "Paris" });
  expect(completion.choices[0].finish_reason).toBe("tool_calls");

  const captured = h.upstream.messages[h.upstream.messages.length - 1]?.body;
  const system = String(captured?.system ?? "");
  expect(system).toContain("You must call at least one of the provided tools");
});

test("parallel tool calls keep distinct indexes", async () => {
  h.upstream.set({ fixture: "parallel-tools" });
  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "weather and time" }],
    tools: [
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
      { type: "function", function: { name: "get_time", parameters: { type: "object" } } },
    ],
  });
  const calls = completion.choices[0].message.tool_calls ?? [];
  expect(calls.length).toBe(2);
  expect(calls.map((c) => c.function.name)).toEqual(["get_weather", "get_time"]);
});

test("tool result round-trip keeps the tool_use_id", async () => {
  h.upstream.set({ fixture: "text" });
  await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [
      { role: "user", content: "weather please" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "toolu_01", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_01", content: "18C and sunny" },
    ],
  });

  const captured = h.upstream.messages[h.upstream.messages.length - 1]?.body;
  const messages = captured?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const toolMessage = messages.find((m) => m.content.some((b) => b.type === "tool_result"));
  expect(toolMessage).toBeDefined();
  const result = toolMessage?.content.find((b) => b.type === "tool_result");
  expect(result?.tool_use_id).toBe("toolu_01");
  const assistant = messages.find((m) => m.content.some((b) => b.type === "tool_use"));
  expect(assistant?.content.find((b) => b.type === "tool_use")).toMatchObject({ id: "toolu_01", name: "get_weather" });
});

test("thinking levels map to budget_tokens and reasoning_content streams", async () => {
  h.upstream.set({ fixture: "thinking" });
  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "think" }],
    reasoning_effort: "high",
  });
  const captured = h.upstream.messages[h.upstream.messages.length - 1]?.body;
  expect(captured?.thinking).toEqual({ type: "enabled", budget_tokens: 24000 });
  expect(Number(captured?.max_tokens)).toBeGreaterThanOrEqual(28096);
  expect(captured?.temperature).toBeUndefined();
  expect(completion.choices[0].message.reasoning_content).toBe("Let me think about it.");

  h.upstream.set({ fixture: "text" });
  await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "no thinking" }],
    reasoning_effort: "low",
  });
  const off = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "off" }],
    reasoning_effort: "minimal",
  });
  expect(off.choices[0].message.content).toBe("Hello from Warm");

  h.upstream.set({ fixture: "thinking" });
  const stream = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "think stream" }],
    stream: true,
    reasoning_effort: "medium",
  });
  let reasoning = "";
  for await (const chunk of stream) reasoning += chunk.choices[0]?.delta?.reasoning_content ?? "";
  expect(reasoning).toBe("Let me think about it.");
});

test("explicit off disables thinking", async () => {
  h.upstream.set({ fixture: "text" });
  await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "off please" }],
    // The SDK types do not include "off"; the wire accepts it.
    ...({ reasoning_effort: "off" } as Record<string, unknown>),
  });
  const captured = h.upstream.messages[h.upstream.messages.length - 1]?.body;
  expect(captured?.thinking).toEqual({ type: "disabled" });
});

test("include_usage emits exactly one totals chunk", async () => {
  h.upstream.set({ fixture: "text" });
  const stream = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  const usageChunks = [];
  for await (const chunk of stream) {
    if (chunk.usage && chunk.choices.length === 0) usageChunks.push(chunk);
  }
  expect(usageChunks.length).toBe(1);
  expect(usageChunks[0].usage?.total_tokens).toBeGreaterThan(0);
});

/** The SDK's APIPromise is not a plain Promise, so match on the thrown status. */
async function rejectionStatus(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? err.status : null;
    return typeof status === "number" ? status : -1;
  }
}

test("n:2 is rejected as an unsupported parameter", async () => {
  const status = await rejectionStatus(() =>
    client.chat.completions.create({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      n: 2,
    }),
  );
  expect(status).toBe(400);
});

test("a wrong api key is rejected", async () => {
  const bad = new OpenAI({ baseURL: `${h.server.url}/v1`, apiKey: "nope" });
  expect(await rejectionStatus(() => bad.models.list())).toBe(401);
});

test("models.list exposes the live catalog", async () => {
  const page = await client.models.list();
  const ids = page.data.map((m) => m.id);
  expect(ids).toContain("gpt-5.6-luna");
  for (const id of h.upstream.behaviour.models) expect(ids).toContain(id);
});

test("the upstream sees the CLI identity headers and no attestation", async () => {
  h.upstream.set({ fixture: "text" });
  await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "headers" }],
  });
  const headers = h.upstream.messages[h.upstream.messages.length - 1]?.headers ?? {};
  expect(headers["x-warm-client"]).toBe("keelcode-cli/0.6.0");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  expect(headers["x-warm-attest"]).toBeUndefined();
  expect(String(headers.authorization)).toStartWith("Bearer tok_");
  const body = h.upstream.messages[h.upstream.messages.length - 1]?.body;
  expect(body?.stream).toBe(true);
});

test("completed requests are logged against the account", async () => {
  const rows = getDb().query("SELECT COUNT(*) AS n FROM request_log").get() as { n: number };
  expect(rows.n).toBeGreaterThan(0);
  const account = listAccounts()[0];
  expect(account.requests).toBeGreaterThan(0);
  expect(account.inputTokens).toBeGreaterThan(0);
});
