import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import {
  MEASUREMENT_NAMES,
  OUTCOMES,
  PROVENANCE,
  type MeasurementName,
  type Outcome,
  type Provenance,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const SLUG = /^[A-Za-z0-9._-]{1,80}$/;
const FAMILY = /^[a-z0-9-]{1,80}$/;
const METHOD = /^[A-Za-z0-9 ._-]{10,120}$/;

const TOP_KEYS = ['schema_version', 'report_id', 'source_kind', 'environment', 'task', 'measurements'];
const ENV_KEYS = [
  'snapshot_id', 'previous_snapshot_ids', 'host', 'cursor_version', 'cli_version', 'model_id',
  'os_family', 'tools', 'rules', 'skills', 'mcp_components', 'task_family', 'context',
];
const TASK_KEYS = ['family', 'outcome', 'attempt_count', 'session_count', 'verification'];
const MEASURE_KEYS = ['name', 'unit', 'value', 'state', 'provenance', 'source'];
const UNITS: Record<MeasurementName, 'count' | 'millisecond' | 'token' | 'usd'> = {
  tool_call_count: 'count',
  tool_failure_count: 'count',
  prompt_count: 'count',
  tool_duration_sum_ms: 'millisecond',
  tool_busy_ms: 'millisecond',
  session_duration_ms: 'millisecond',
  task_calendar_ms: 'millisecond',
  active_agent_ms: 'millisecond',
  hook_overhead_ms: 'millisecond',
  input_tokens: 'token',
  output_tokens: 'token',
  cache_read_tokens: 'token',
  cache_write_tokens: 'token',
  total_tokens: 'token',
  reasoning_tokens: 'token',
  cost_usd: 'usd',
};

function fail(): never {
  throw new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail();
  }
  const body = value as Record<string, unknown>;
  const present = Object.keys(body);
  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) {
    fail();
  }
  return body;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail();
  }
  return value;
}

function nullableSlug(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !SLUG.test(value)) {
    fail();
  }
  return value;
}

function refs(value: unknown, hashed: boolean): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 200) {
    fail();
  }
  return value.map((item) => {
    const body = record(item, hashed ? ['id', 'sha256'] : ['id', 'version']);
    if (typeof body['id'] !== 'string' || !SLUG.test(body['id'])) {
      fail();
    }
    if (hashed) {
      if (typeof body['sha256'] !== 'string' || !SHA.test(body['sha256'])) {
        fail();
      }
    } else if (body['version'] !== null && (typeof body['version'] !== 'string' || !SLUG.test(body['version']))) {
      fail();
    }
    return body;
  });
}

function measurement(value: unknown): Record<string, unknown> {
  const body = record(value, MEASURE_KEYS);
  const name = body['name'];
  if (typeof name !== 'string' || !MEASUREMENT_NAMES.includes(name as MeasurementName)) {
    fail();
  }
  const measurementName = name as MeasurementName;
  if (body['unit'] !== UNITS[measurementName]) {
    fail();
  }
  const source = body['source'];
  if (source !== 'cursor-ide' && source !== 'cursor-cli' && source !== 'cursor-sdk' && source !== 'local-clock' && source !== 'unknown') {
    fail();
  }
  const provenance = body['provenance'];
  if (typeof provenance !== 'string' || !PROVENANCE.includes(provenance as Provenance)) {
    fail();
  }
  if (body['state'] === 'unknown') {
    if (body['value'] !== null || provenance !== 'unknown') {
      fail();
    }
  } else if (body['state'] === 'known') {
    const number = body['value'];
    const limit = body['unit'] === 'token' ? 100_000_000 : body['unit'] === 'usd' ? 1_000_000 : body['unit'] === 'count' ? 1_000_000 : 7 * 24 * 60 * 60 * 1000;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > limit || provenance === 'unknown') {
      fail();
    }
  } else {
    fail();
  }
  return body;
}

export function parseTelemetryReport(input: unknown): Record<string, unknown> {
  const body = record(input, TOP_KEYS);
  if (body['schema_version'] !== '1') {
    fail();
  }
  uuid(body['report_id']);
  if (body['source_kind'] !== 'organic' && body['source_kind'] !== 'synthetic') {
    fail();
  }
  const environment = record(body['environment'], ENV_KEYS);
  if (environment['snapshot_id'] !== null) {
    uuid(environment['snapshot_id']);
  }
  if (!Array.isArray(environment['previous_snapshot_ids']) || environment['previous_snapshot_ids'].length > 20) {
    fail();
  }
  for (const id of environment['previous_snapshot_ids']) {
    uuid(id);
  }
  const host = environment['host'];
  if (host !== 'cursor-ide' && host !== 'cursor-cli' && host !== 'cursor-sdk' && host !== 'mixed' && host !== 'unknown') {
    fail();
  }
  nullableSlug(environment['cursor_version']);
  nullableSlug(environment['cli_version']);
  nullableSlug(environment['model_id']);
  const os = environment['os_family'];
  if (os !== 'linux' && os !== 'darwin' && os !== 'windows' && os !== 'unknown') {
    fail();
  }
  if (!Array.isArray(environment['tools']) || environment['tools'].length > 40) {
    fail();
  }
  for (const tool of environment['tools']) {
    const item = record(tool, ['name', 'version']);
    if (typeof item['name'] !== 'string' || !SLUG.test(item['name'])) {
      fail();
    }
    nullableSlug(item['version']);
  }
  refs(environment['rules'], true);
  refs(environment['skills'], true);
  refs(environment['mcp_components'], false);
  if (typeof environment['task_family'] !== 'string' || !FAMILY.test(environment['task_family'])) {
    fail();
  }
  const context = record(environment['context'], ['form', 'configuration_family']);
  if (context['form'] !== 'ordinary' && context['form'] !== 'managed' && context['form'] !== 'unknown') {
    fail();
  }
  nullableSlug(context['configuration_family']);
  const task = record(body['task'], TASK_KEYS);
  if (task['family'] !== environment['task_family']) {
    fail();
  }
  if (typeof task['outcome'] !== 'string' || !OUTCOMES.includes(task['outcome'] as Outcome)) {
    fail();
  }
  if (typeof task['attempt_count'] !== 'number' || !Number.isInteger(task['attempt_count']) || task['attempt_count'] < 1 || task['attempt_count'] > 100) {
    fail();
  }
  if (typeof task['session_count'] !== 'number' || !Number.isInteger(task['session_count']) || task['session_count'] < 0 || task['session_count'] > 100) {
    fail();
  }
  if (task['outcome'] === 'success_verified') {
    const verification = record(task['verification'], ['method', 'origin', 'observed_exit_code']);
    if (typeof verification['method'] !== 'string' || !METHOD.test(verification['method'])) {
      fail();
    }
    if (typeof verification['origin'] !== 'string' || !PROVENANCE.includes(verification['origin'] as Provenance) || verification['origin'] === 'unknown') {
      fail();
    }
    const exitCode = verification['observed_exit_code'];
    if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
      fail();
    }
  } else if (task['verification'] !== null) {
    fail();
  }
  if (!Array.isArray(body['measurements']) || body['measurements'].length < 1 || body['measurements'].length > 40) {
    fail();
  }
  body['measurements'].map(measurement);
  return body;
}
