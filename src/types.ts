// Wire types shared across the proxy. Anthropic is the native dialect; the
// OpenAI types describe what we accept in and must emit out.

export interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
}

export type AnthropicThinking =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
  thinking?: AnthropicThinking;
  output_config?: { effort?: string };
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicEvent {
  type: string;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  display_name?: string;
  created_at?: string;
  context_window?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

export interface UsageWindow {
  id?: string;
  scope?: string;
  label?: string;
  hours?: number;
  limit_usd?: string;
  used_usd?: string;
  reserved_usd?: string;
  remaining_usd?: string;
  restores_at?: string | null;
  merges?: number;
  [key: string]: unknown;
}

export interface UsageSnapshot {
  plan?: string;
  period?: { starts_at?: string; resets_at?: string };
  pools?: UsageWindow[];
  usage_windows?: UsageWindow[];
  window_merges?: {
    enabled?: boolean;
    allowed?: number;
    used?: number;
    remaining?: number;
    next_available_at?: string | null;
  };
  capacity?: Array<{ model?: string; share?: number }>;
  entitlement?: unknown;
  free_launch?: unknown;
  request_count?: number;
  input_tokens?: string;
  output_tokens?: string;
  credits_spent?: string;
  [key: string]: unknown;
}

export interface RecentRuns {
  runs?: unknown[];
  summary?: {
    total?: number;
    completed?: number;
    failed?: number;
    input_tokens?: number;
    output_tokens?: number;
    cost?: string;
  };
  [key: string]: unknown;
}

// ---------- OpenAI surface ----------

export interface OpenAIFunction {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

export interface OpenAITool {
  type?: string;
  function: OpenAIFunction;
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | { type: "allowed_tools"; allowed_tools?: { mode?: string; tools?: OpenAITool[] } };

export interface OpenAIToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string; detail?: string };
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface OpenAIResponseFormat {
  type?: string;
  json_schema?: { name?: string; schema?: unknown; strict?: boolean; description?: string };
  strict?: boolean;
  [key: string]: unknown;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  reasoning_effort?: string;
  response_format?: OpenAIResponseFormat;
  n?: number;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  audio?: unknown;
  modalities?: string[];
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAIChatMessageOut {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIChatMessageOut;
    finish_reason: string;
    logprobs: null;
  }>;
  usage: OpenAIUsage;
}
