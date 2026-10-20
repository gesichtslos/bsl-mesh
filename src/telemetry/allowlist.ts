import { createHash } from 'node:crypto';

import { HOOK_EVENTS, type HookEventName, type ProjectedHook } from './types.js';

const SLUG = /^[A-Za-z0-9._-]{1,80}$/;
const VERSION = /^[0-9][A-Za-z0-9._+-]{0,40}$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const FAILURES = new Set(['timeout', 'error', 'permission_denied']);
const STOP = new Set(['completed', 'aborted', 'error']);
const SESSION_END = new Set(['completed', 'aborted', 'error', 'window_close', 'user_close']);

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function slug(value: unknown): string | null {
  return typeof value === 'string' && SLUG.test(value) ? value : null;
}

function version(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

function duration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > WEEK_MS) {
    return null;
  }
  return Math.round(value);
}

function enumValue<T extends string>(value: unknown, allowed: Set<string>): T | null {
  return typeof value === 'string' && allowed.has(value) ? value as T : null;
}

export function projectHook(input: unknown, observedAt: string, overheadMs: number): ProjectedHook | null {
  const body = record(input);
  if (body === null) {
    return null;
  }
  const name = body['hook_event_name'];
  if (typeof name !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(name)) {
    return null;
  }
  const event = name as HookEventName;
  const conversation = typeof body['conversation_id'] === 'string' ? digest(body['conversation_id']) : null;
  const session = typeof body['session_id'] === 'string' ? digest(body['session_id']) : conversation;
  const generation = typeof body['generation_id'] === 'string' ? digest(body['generation_id']) : null;
  const toolUse = typeof body['tool_use_id'] === 'string' ? digest(body['tool_use_id']) : null;
  if (session === null && toolUse === null && generation === null) {
    return null;
  }
  const model = slug(body['model_id']) ?? slug(body['model']);
  const toolEvent = event === 'preToolUse' || event === 'postToolUse' || event === 'postToolUseFailure';
  const stableToolId = toolEvent && toolUse !== null;
  const dedupeKey = stableToolId
    ? digest(`${event}:${toolUse}`)
    : toolEvent
      ? digest([
        event,
        session,
        generation,
        slug(body['tool_name']),
        duration(body['duration'] ?? body['duration_ms']),
        enumValue(body['failure_type'], FAILURES),
        observedAt,
      ].join(':'))
      : event === 'sessionStart' || event === 'sessionEnd'
        ? digest(`${event}:${session}`)
        : digest(`${event}:${session}:${generation}`);
  const projected: ProjectedHook = {
    event,
    dedupe_key: dedupeKey,
    conversation_digest: conversation,
    generation_digest: generation,
    cursor_version: version(body['cursor_version']),
    model_id: model,
    tool_name: slug(body['tool_name']),
    duration_ms: duration(body['duration'] ?? body['duration_ms']),
    failure_type: enumValue(body['failure_type'], FAILURES),
    stop_status: event === 'stop' ? enumValue(body['status'], STOP) : null,
    session_end_reason: event === 'sessionEnd' ? enumValue(body['reason'], SESSION_END) : null,
    observed_at: observedAt,
    overhead_ms: duration(overheadMs) ?? 0,
    stable_tool_id: stableToolId,
  };
  return projected;
}
