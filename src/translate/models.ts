// Per-model facts: context window, output cap, local price (for the receipt
// only, never for routing) and the withdrawn-name alias table.

import type { ModelInfo } from "../types.ts";

export interface ModelMeta {
  context: number;
  maxOutput: number | null;
  inPerM?: number;
  outPerM?: number;
}

export const DEFAULT_MODEL = "gpt-5.6-luna";

const TABLE: Array<{ match: string[]; meta: ModelMeta }> = [
  { match: ["opus-5"], meta: { context: 1_000_000, maxOutput: null, inPerM: 5, outPerM: 25 } },
  { match: ["fable-5", "mythos-5"], meta: { context: 1_000_000, maxOutput: null, inPerM: 10, outPerM: 50 } },
  { match: ["opus-4"], meta: { context: 200_000, maxOutput: null, inPerM: 15, outPerM: 75 } },
  { match: ["sonnet-5", "sonnet-4"], meta: { context: 200_000, maxOutput: null, inPerM: 3, outPerM: 15 } },
  { match: ["haiku-4"], meta: { context: 200_000, maxOutput: null, inPerM: 3, outPerM: 15 } },
];

const FALLBACK: ModelMeta = { context: 200_000, maxOutput: null };

export function modelMeta(model: string): ModelMeta {
  const id = model.toLowerCase();
  for (const entry of TABLE) {
    if (entry.match.some((name) => id.includes(name))) return entry.meta;
  }
  return FALLBACK;
}

/** Withdrawn ids the gateway still answers for under a different name. */
export const ALIASES: Record<string, string> = {
  "kimi-k2.6-nitro": "kimi-k2.6",
  "kimi-k2.7-code-nitro": "kimi-k2.7-code",
  "glm-5.2-nitro": "glm-5.2",
  "claude-sonnet-4-6": "gpt-5.6-luna",
  "claude-opus-4-8": "gpt-5.6-luna",
  "claude-fable-5": "gpt-5.6-luna",
  "claude-sonnet-5": "gpt-5.6-luna",
};

/**
 * Aliases apply only when the requested id is absent from the live catalog, so a
 * real `claude-sonnet-5` for a staff account is never silently redirected.
 */
export function resolveModel(requested: string | undefined, catalogIds: readonly string[] | null): string {
  const wanted = requested?.trim() || DEFAULT_MODEL;
  if (catalogIds && catalogIds.length > 0) {
    if (catalogIds.includes(wanted)) return wanted;
    return ALIASES[wanted] ?? wanted;
  }
  return ALIASES[wanted] ?? wanted;
}

export function clampMaxTokens(model: string, requested: number | undefined, fallback = 32_000): number {
  const base = typeof requested === "number" && requested > 0 ? Math.trunc(requested) : fallback;
  const cap = modelMeta(model).maxOutput;
  return cap ? Math.min(base, cap) : base;
}

/** Local cost receipt in micro-dollars. Advisory only. */
export function costMicro(model: string, inputTokens: number, outputTokens: number): number {
  const meta = modelMeta(model);
  const inMicro = meta.inPerM ? meta.inPerM * Math.max(0, inputTokens) : 0;
  const outMicro = meta.outPerM ? meta.outPerM * Math.max(0, outputTokens) : 0;
  return inMicro + outMicro;
}

/** Offline catalog so `/v1/models` answers before any account exists. */
export function seedModels(): ModelInfo[] {
  const ids = [
    DEFAULT_MODEL,
    "kimi-k2.6",
    "kimi-k2.7-code",
    "glm-5.2",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ];
  return ids.map((id) => ({
    id,
    display_name: id,
    created_at: new Date(0).toISOString(),
    context_window: modelMeta(id).context,
    max_output_tokens: modelMeta(id).maxOutput ?? undefined,
  }));
}
