import { expect, test } from "bun:test";
import { applyEffort, BUDGET, EFFORTS, normaliseEffort, styleFor, WIRE_EFFORT } from "../src/translate/effort.ts";
import type { AnthropicRequest } from "../src/types.ts";

const BUDGET_MODEL = "gpt-5.6-luna";
const CONFIG_MODEL = "claude-opus-5";

test("style follows the model family", () => {
  expect(styleFor(BUDGET_MODEL)).toBe("budget_tokens");
  expect(styleFor("kimi-k2.6")).toBe("budget_tokens");
  expect(styleFor(CONFIG_MODEL)).toBe("output_config");
  expect(styleFor("claude-sonnet-5")).toBe("output_config");
  expect(styleFor("claude-opus-4-8")).toBe("output_config");
});

test("all six levels are accepted and unknown strings are not", () => {
  for (const level of EFFORTS) expect(normaliseEffort(level)).toBe(level);
  expect(normaliseEffort("minimal")).toBe("low");
  expect(normaliseEffort("none")).toBe("off");
  expect(normaliseEffort("medium")).toBe("medium");
  expect(normaliseEffort("MED")).toBe("medium");
  expect(normaliseEffort("turbo")).toBeNull();
  expect(normaliseEffort(undefined)).toBeNull();
});

test("off disables thinking and drops temperature", () => {
  const body: AnthropicRequest = { temperature: 0.7, max_tokens: 1000 };
  applyEffort(body, BUDGET_MODEL, "off");
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.reasoning_effort).toBe("none");
  expect(body.temperature).toBeUndefined();
});

test("budget style sets budget_tokens and raises max_tokens", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const body: AnthropicRequest = { temperature: 0.2, max_tokens: 100 };
    applyEffort(body, BUDGET_MODEL, level);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: BUDGET[level] });
    expect(body.max_tokens).toBe(BUDGET[level] + 4096);
    expect(body.temperature).toBeUndefined();
  }
});

test("a generous max_tokens is never lowered by the thinking budget", () => {
  const body: AnthropicRequest = { max_tokens: 200_000 };
  applyEffort(body, BUDGET_MODEL, "low");
  expect(body.max_tokens).toBe(200_000);
});

test("output_config style sets the wire effort and leaves max_tokens alone", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const body: AnthropicRequest = { max_tokens: 777 };
    applyEffort(body, CONFIG_MODEL, level);
    expect(body.output_config).toEqual({ effort: WIRE_EFFORT[level] });
    expect(body.max_tokens).toBe(777);
    expect(body.thinking).toBeUndefined();
  }
});
