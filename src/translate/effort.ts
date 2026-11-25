// Thinking-level translation. Two upstream styles exist: `output_config.effort`
// for the newer Claude family, `thinking.budget_tokens` for everything else.

import type { AnthropicRequest } from "../types.ts";

export type Effort = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high", "xhigh", "max"];

export const BUDGET: Record<Effort, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 24000,
  xhigh: 28000,
  max: 32000,
};

export const WIRE_EFFORT: Record<Exclude<Effort, "off">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const OUTPUT_CONFIG_MODELS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-sonnet-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
];

export function styleFor(model: string): "output_config" | "budget_tokens" {
  const id = model.toLowerCase();
  return OUTPUT_CONFIG_MODELS.some((name) => id.includes(name)) ? "output_config" : "budget_tokens";
}

/** Map a client-supplied effort string onto the domain, or null when unknown. */
export function normaliseEffort(value: unknown): Effort | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "off" || key === "none" || key === "disabled") return "off";
  if (key === "minimal" || key === "low") return "low";
  if (key === "medium" || key === "med") return "medium";
  if (key === "high") return "high";
  if (key === "xhigh" || key === "extra-high" || key === "extra_high") return "xhigh";
  if (key === "max" || key === "maximum") return "max";
  return null;
}

/**
 * Mutates the request in place. `off` disables thinking; every other level sets
 * the style-appropriate fields. Temperature is dropped whenever thinking is on.
 */
export function applyEffort(body: AnthropicRequest, model: string, effort: Effort): void {
  if (effort === "off") {
    body.thinking = { type: "disabled" };
    if (styleFor(model) === "budget_tokens") body.reasoning_effort = "none";
    delete body.temperature;
    return;
  }

  const budget = BUDGET[effort];
  if (styleFor(model) === "output_config") {
    body.output_config = { effort: WIRE_EFFORT[effort as Exclude<Effort, "off">] };
    delete body.reasoning_effort;
    return;
  }

  body.thinking = { type: "enabled", budget_tokens: budget };
  body.max_tokens = Math.max(typeof body.max_tokens === "number" ? body.max_tokens : 0, budget + 4096);
  delete body.reasoning_effort;
  delete body.temperature;
}
