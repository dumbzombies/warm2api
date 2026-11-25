import { expect, test } from "bun:test";
import { ALIASES, clampMaxTokens, costMicro, DEFAULT_MODEL, modelMeta, resolveModel, seedModels } from "../src/translate/models.ts";

test("aliases only apply when the id is absent from the live catalog", () => {
  expect(resolveModel("claude-sonnet-4-6", [])).toBe(ALIASES["claude-sonnet-4-6"]);
  expect(resolveModel("claude-sonnet-4-6", null)).toBe(ALIASES["claude-sonnet-4-6"]);
  expect(resolveModel("claude-sonnet-4-6", ["gpt-5.6-luna"])).toBe("gpt-5.6-luna");
  // A real staff-only id survives when the catalog actually offers it.
  expect(resolveModel("claude-sonnet-5", ["claude-sonnet-5"])).toBe("claude-sonnet-5");
  expect(resolveModel("kimi-k2.6", ["kimi-k2.6"])).toBe("kimi-k2.6");
  expect(resolveModel(undefined, null)).toBe(DEFAULT_MODEL);
  expect(resolveModel("  ", null)).toBe(DEFAULT_MODEL);
});

test("context windows come from the model family", () => {
  expect(modelMeta("claude-opus-5").context).toBe(1_000_000);
  expect(modelMeta("claude-sonnet-5").context).toBe(200_000);
  expect(modelMeta("claude-haiku-4-5").context).toBe(200_000);
  expect(modelMeta("gpt-5.6-luna").context).toBe(200_000);
  expect(modelMeta("mystery-model").context).toBe(200_000);
});

test("max_tokens clamps to the model cap and falls back when absent", () => {
  expect(clampMaxTokens("gpt-5.6-luna", undefined)).toBe(32_000);
  expect(clampMaxTokens("gpt-5.6-luna", 10)).toBe(10);
  expect(clampMaxTokens("gpt-5.6-luna", -5)).toBe(32_000);
  expect(clampMaxTokens("gpt-5.6-luna", 12_345.9)).toBe(12_345);
  expect(clampMaxTokens("claude-sonnet-4", 999_999, 64)).toBe(999_999);
});

test("cost receipts are integer micro-dollars", () => {
  expect(costMicro("gpt-5.6-luna", 1_000, 500)).toBe(0);
  expect(costMicro("claude-opus-5", 1_000_000, 0)).toBe(5_000_000);
  expect(costMicro("claude-opus-5", 0, 1_000_000)).toBe(25_000_000);
  expect(costMicro("claude-opus-5", 2_000_000, 1_000_000)).toBe(10_000_000 + 25_000_000);
  expect(Number.isInteger(costMicro("claude-sonnet-5", 123, 456))).toBe(true);
});

test("the seed catalog always includes the default model", () => {
  const ids = seedModels().map((m) => m.id);
  expect(ids).toContain(DEFAULT_MODEL);
  expect(new Set(ids).size).toBe(ids.length);
});
