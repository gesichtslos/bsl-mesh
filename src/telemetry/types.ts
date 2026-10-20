export const SCHEMA_VERSION = '1';

export const OUTCOMES = [
  'success_verified',
  'success_unverified',
  'partial',
  'failed',
  'abandoned',
  'unknown',
] as const;

export const PROVENANCE = [
  'instrumented',
  'provider_reported',
  'agent_reported',
  'owner_reported',
  'derived',
  'unknown',
] as const;

export const MEASUREMENT_NAMES = [
  'tool_call_count',
  'tool_failure_count',
  'tool_duration_sum_ms',
  'tool_busy_ms',
  'session_duration_ms',
  'task_calendar_ms',
  'active_agent_ms',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cost_usd',
  'prompt_count',
  'hook_overhead_ms',
] as const;

export const HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'stop',
  'beforeSubmitPrompt',
] as const;

export type Outcome = (typeof OUTCOMES)[number];
export type Provenance = (typeof PROVENANCE)[number];
export type MeasurementName = (typeof MEASUREMENT_NAMES)[number];
export type HookEventName = (typeof HOOK_EVENTS)[number];
export type FormKind = 'ordinary' | 'managed' | 'unknown';
export type SourceKind = 'organic' | 'synthetic';
export type MeasureSource = 'cursor-ide' | 'cursor-cli' | 'cursor-sdk' | 'local-clock' | 'unknown';

export type Measurement = {
  name: MeasurementName;
  unit: 'count' | 'millisecond' | 'token' | 'usd';
  value: number | null;
  state: 'known' | 'unknown';
  provenance: Provenance;
  source: MeasureSource;
};

export type ProjectedHook = {
  event: HookEventName;
  dedupe_key: string;
  conversation_digest: string | null;
  generation_digest: string | null;
  cursor_version: string | null;
  model_id: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  failure_type: 'timeout' | 'error' | 'permission_denied' | null;
  stop_status: 'completed' | 'aborted' | 'error' | null;
  session_end_reason: 'completed' | 'aborted' | 'error' | 'window_close' | 'user_close' | null;
  observed_at: string;
  overhead_ms: number;
  stable_tool_id: boolean;
};
