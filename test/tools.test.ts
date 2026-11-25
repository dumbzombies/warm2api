import { expect, test } from "bun:test";
import { toolChoiceNudge, toolResultsToAnthropic, toolsToAnthropic, toolUsesToCalls } from "../src/translate/tools.ts";
import { toAnthropicRequest } from "../src/translate/openai-in.ts";
import type { OpenAIChatRequest } from "../src/types.ts";

test("tools map to input_schema and drop strict", () => {
  const mapped = toolsToAnthropic([
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Weather",
        strict: true,
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
  expect(mapped).toEqual([
    {
      name: "get_weather",
      description: "Weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]);
  expect(toolsToAnthropic([])).toBeUndefined();
  expect(toolsToAnthropic(undefined)).toBeUndefined();
});

test("tool_choice nudge text is exact", () => {
  expect(toolChoiceNudge("auto")).toBeNull();
  expect(toolChoiceNudge("none")).toBeNull();
  expect(toolChoiceNudge(undefined)).toBeNull();
  expect(toolChoiceNudge("required")).toBe("You must call at least one of the provided tools in this turn.");
  expect(toolChoiceNudge({ type: "function", function: { name: "get_weather" } })).toBe(
    'You must call the tool "get_weather" in this turn.',
  );
});

test("tool_use blocks become OpenAI tool calls with JSON arguments", () => {
  const calls = toolUsesToCalls([
    { type: "text", text: "hi" },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
  ]);
  expect(calls).toEqual([
    { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
  ]);
});

test("tool results keep the tool_use_id and is_error flag", () => {
  expect(toolResultsToAnthropic({ role: "tool", tool_call_id: "toolu_1", content: "18C" })).toEqual({
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: "18C",
  });
  expect(
    toolResultsToAnthropic({ role: "tool", tool_call_id: "toolu_2", content: "boom", is_error: true }),
  ).toMatchObject({ is_error: true });
});

test("malformed tool arguments degrade to an empty object", () => {
  const body: OpenAIChatRequest = {
    model: "gpt-5.6-luna",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{oops" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ],
  };
  const { request } = toAnthropicRequest(body, "gpt-5.6-luna");
  const assistant = request.messages.find((m) => m.role === "assistant");
  const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
  const toolUse = blocks.find((b) => b.type === "tool_use");
  expect(toolUse).toMatchObject({ id: "call_1", name: "get_weather", input: {} });
});

test("a full request translates to the expected Anthropic body", () => {
  const body: OpenAIChatRequest = {
    model: "gpt-5.6-luna",
    messages: [
      { role: "system", content: "Be terse." },
      { role: "developer", content: "Prefer JSON." },
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "toolu_9", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_9", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "required",
    temperature: 0.3,
    max_tokens: 500,
  };
  const { request, nudge } = toAnthropicRequest(body, "gpt-5.6-luna");
  expect(nudge).toBe("You must call at least one of the provided tools in this turn.");
  expect(request.system).toBe(
    "Be terse.\n\nPrefer JSON.\n\nYou must call at least one of the provided tools in this turn.",
  );
  expect(request.max_tokens).toBe(500);
  expect(request.temperature).toBe(0.3);
  expect(request.tools).toEqual([{ name: "f", input_schema: { type: "object" } }]);
  // Consecutive user turns merge into one block list.
  expect(request.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "hi" },
      { type: "text", text: "again" },
    ],
  });
  expect(request.messages[1]?.role).toBe("assistant");
  expect(request.messages[2]).toEqual({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }],
  });
});

test("tool_choice none drops tools entirely", () => {
  const { request } = toAnthropicRequest(
    {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      tool_choice: "none",
    },
    "gpt-5.6-luna",
  );
  expect(request.tools).toBeUndefined();
  expect(request.system).toBeUndefined();
});

test("json_schema response format becomes a system instruction and a validator", () => {
  const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
  const { request, jsonSchema } = toAnthropicRequest(
    {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "a", schema } },
    },
    "gpt-5.6-luna",
  );
  expect(jsonSchema).toEqual(schema);
  expect(String(request.system)).toContain("Respond with JSON only");
});
