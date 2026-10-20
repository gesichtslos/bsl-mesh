import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { projectHook } from './allowlist.js';
import { unionDuration } from './intervals.js';
import { measurementsFromSdkUsage, sdkCost } from './sdk-usage.js';
import { captureSnapshot, type EnvironmentSnapshot } from './snapshot.js';
import {
  OUTCOMES,
  PROVENANCE,
  type FormKind,
  type Measurement,
  type Outcome,
  type ProjectedHook,
  type Provenance,
  type SourceKind,
} from './types.js';

const FAMILY = /^[a-z0-9-]{1,80}$/;
const METHOD = /^[A-Za-z0-9 ._-]{10,120}$/;

export type Verification = {
  method: string;
  origin: Provenance;
  observed_exit_code: number | null;
};

export type Attempt = {
  id: string;
  ordinal: number;
  started_at: string;
  ended_at: string | null;
  outcome: Outcome;
};

export type LocalSession = {
  id: string;
  digest: string;
  task_id: string | null;
  cursor_version: string | null;
  model_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  end_reason: ProjectedHook['session_end_reason'];
  duration_ms: number | null;
  tool_calls: number;
  tool_failures: number;
  tool_duration_sum_ms: number;
  undated_tools: number;
  intervals: Array<{ start: number; end: number }>;
  prompt_events: number;
  saw_prompt: boolean;
  saw_boundary: boolean;
  saw_tool: boolean;
};

export type SdkNote = {
  status: 'finished' | 'error' | 'cancelled' | null;
  duration_ms: number | null;
  model_id: string | null;
  measurements: Measurement[];
};

export type TaskRun = {
  id: string;
  report_id: string;
  family: string;
  source_kind: SourceKind;
  form: FormKind;
  configuration_family: string | null;
  snapshot_ids: string[];
  attempts: Attempt[];
  outcome: Outcome;
  verification: Verification | null;
  started_at: string;
  ended_at: string | null;
  sdk: SdkNote | null;
};

type State = {
  schema: 1;
  enabled: boolean;
  quarantined: boolean;
  tasks: TaskRun[];
  sessions: LocalSession[];
  snapshots: EnvironmentSnapshot[];
  seen: string[];
  max_hook_overhead_ms: number | null;
};

export type CollectorStatus = {
  enabled: boolean;
  store_dir: string;
  quarantined: boolean;
  sources: {
    cursor_ide_hooks: 'template_only';
    cursor_cli: 'not_observed';
    cursor_sdk: 'usage_optional';
  };
  tasks: number;
  sessions: number;
};

function emptyState(): State {
  return {
    schema: 1,
    enabled: false,
    quarantined: false,
    tasks: [],
    sessions: [],
    snapshots: [],
    seen: [],
    max_hook_overhead_ms: null,
  };
}

function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      closeSync(fd);
      try {
        return fn();
      } finally {
        unlinkSync(lock);
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  throw new Error('Local telemetry lock was not acquired.');
}

export class LocalTelemetry {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly root: string = process.cwd(),
  ) {}

  status(): CollectorStatus {
    const state = this.read();
    return {
      enabled: state.enabled,
      store_dir: this.dir,
      quarantined: state.quarantined,
      sources: {
        cursor_ide_hooks: 'template_only',
        cursor_cli: 'not_observed',
        cursor_sdk: 'usage_optional',
      },
      tasks: state.tasks.length,
      sessions: state.sessions.length,
    };
  }

  enable(): CollectorStatus {
    return this.update((state) => {
      state.enabled = true;
      return this.statusFrom(state);
    });
  }

  disable(): CollectorStatus {
    return this.update((state) => {
      state.enabled = false;
      return this.statusFrom(state);
    });
  }

  list(): Array<{ id: string; family: string; outcome: Outcome; attempts: number; sessions: number }> {
    const state = this.read();
    return state.tasks.map((task) => ({
      id: task.id,
      family: task.family,
      outcome: task.outcome,
      attempts: task.attempts.length,
      sessions: state.sessions.filter((session) => session.task_id === task.id).length,
    }));
  }

  startTask(input: {
    family: string;
    form: FormKind;
    sourceKind: SourceKind;
    configurationFamily: string | null;
    mcpIds: readonly string[];
    cursorVersion: string | null;
    cliVersion: string | null;
  }): TaskRun {
    if (!FAMILY.test(input.family)) {
      throw new Error('Task family must be a short lowercase token.');
    }
    return this.update((state) => {
      if (!state.enabled) {
        throw new Error('Local collection is disabled.');
      }
      const current = this.now().toISOString();
      const snapshot = captureSnapshot({
        id: randomUUID(),
        capturedAt: current,
        root: this.root,
        platform: process.platform,
        nodeVersion: process.versions.node,
        cursorVersion: input.cursorVersion,
        cliVersion: input.cliVersion,
        modelId: null,
        family: input.family,
        form: input.form,
        configurationFamily: input.configurationFamily,
        mcpIds: input.mcpIds,
      });
      state.snapshots.push(snapshot);
      const task: TaskRun = {
        id: randomUUID(),
        report_id: randomUUID(),
        family: input.family,
        source_kind: input.sourceKind,
        form: input.form,
        configuration_family: snapshot.context.configuration_family,
        snapshot_ids: [snapshot.id],
        attempts: [{ id: randomUUID(), ordinal: 1, started_at: current, ended_at: null, outcome: 'unknown' }],
        outcome: 'unknown',
        verification: null,
        started_at: current,
        ended_at: null,
        sdk: null,
      };
      state.tasks.push(task);
      return task;
    });
  }

  startAttempt(taskId: string): Attempt {
    return this.update((state) => {
      const task = this.task(state, taskId);
      const open = task.attempts.find((attempt) => attempt.ended_at === null);
      const current = this.now().toISOString();
      if (open !== undefined) {
        open.ended_at = current;
        open.outcome = 'unknown';
      }
      const attempt: Attempt = {
        id: randomUUID(),
        ordinal: task.attempts.length + 1,
        started_at: current,
        ended_at: null,
        outcome: 'unknown',
      };
      task.attempts.push(attempt);
      task.outcome = 'unknown';
      task.ended_at = null;
      return attempt;
    });
  }

  finishTask(taskId: string, outcome: Outcome, verification: Verification | null): TaskRun {
    if (!OUTCOMES.includes(outcome)) {
      throw new Error('Task outcome is not one of the known states.');
    }
    if (outcome === 'success_verified') {
      if (verification === null || !METHOD.test(verification.method) || !PROVENANCE.includes(verification.origin)) {
        throw new Error('success_verified requires a verification method and origin.');
      }
    }
    return this.update((state) => {
      const task = this.task(state, taskId);
      const current = this.now().toISOString();
      this.retakeSnapshot(state, task, current);
      task.outcome = outcome;
      task.verification = outcome === 'success_verified' ? verification : null;
      task.ended_at = current;
      const open = task.attempts.find((attempt) => attempt.ended_at === null);
      if (open !== undefined) {
        open.ended_at = current;
        open.outcome = outcome;
      }
      return task;
    });
  }

  ingest(raw: unknown, overheadMs: number): { recorded: boolean } {
    const observedAt = this.now().toISOString();
    const projected = projectHook(raw, observedAt, overheadMs);
    if (projected === null) {
      return { recorded: false };
    }
    return this.update((state) => {
      if (!state.enabled) {
        return { recorded: false };
      }
      if (state.seen.includes(projected.dedupe_key)) {
        return { recorded: false };
      }
      state.seen.push(projected.dedupe_key);
      if (state.max_hook_overhead_ms === null || projected.overhead_ms > state.max_hook_overhead_ms) {
        state.max_hook_overhead_ms = projected.overhead_ms;
      }
      const digest = projected.conversation_digest;
      if (digest === null) {
        return { recorded: true };
      }
      let session = state.sessions.find((item) => item.digest === digest);
      if (session === undefined) {
        const open = state.tasks.filter((task) => task.ended_at === null);
        session = {
          id: randomUUID(),
          digest,
          task_id: open.length === 1 ? open[0]?.id ?? null : null,
          cursor_version: projected.cursor_version,
          model_id: projected.model_id,
          started_at: projected.event === 'sessionStart' ? projected.observed_at : null,
          ended_at: null,
          end_reason: null,
          duration_ms: null,
          tool_calls: 0,
          tool_failures: 0,
          tool_duration_sum_ms: 0,
          undated_tools: 0,
          intervals: [],
          prompt_events: 0,
          saw_prompt: false,
          saw_boundary: false,
          saw_tool: false,
        };
        state.sessions.push(session);
      }
      if (projected.cursor_version !== null) {
        session.cursor_version = projected.cursor_version;
      }
      if (projected.model_id !== null) {
        session.model_id = projected.model_id;
      }
      if (projected.event === 'sessionStart') {
        session.saw_boundary = true;
        session.started_at ??= projected.observed_at;
      }
      if (projected.event === 'sessionEnd') {
        session.saw_boundary = true;
        session.ended_at = projected.observed_at;
        session.end_reason = projected.session_end_reason;
        session.duration_ms = projected.duration_ms;
      }
      if (projected.event === 'beforeSubmitPrompt') {
        session.saw_prompt = true;
        session.prompt_events += 1;
      }
      if (projected.event === 'postToolUse' || projected.event === 'postToolUseFailure') {
        session.saw_tool = true;
        if (projected.event === 'postToolUseFailure') {
          session.tool_failures += 1;
        }
        session.tool_calls += 1;
        if (projected.duration_ms === null) {
          session.undated_tools += 1;
        } else {
          session.tool_duration_sum_ms += projected.duration_ms;
          const end = Date.parse(projected.observed_at);
          session.intervals.push({ start: end - projected.duration_ms, end });
        }
      }
      return { recorded: true };
    });
  }

  importSdk(taskId: string, payload: unknown): TaskRun {
    const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const status = body['status'];
    const sdkStatus = status === 'finished' || status === 'error' || status === 'cancelled' ? status : null;
    const duration = typeof body['durationMs'] === 'number' && Number.isFinite(body['durationMs'])
      ? Math.round(body['durationMs'])
      : null;
    const model = typeof body['modelId'] === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(body['modelId'])
      ? body['modelId']
      : null;
    const usage = Object.hasOwn(body, 'usage') ? body['usage'] : undefined;
    return this.update((state) => {
      const task = this.task(state, taskId);
      task.sdk = {
        status: sdkStatus,
        duration_ms: duration,
        model_id: model,
        measurements: [...measurementsFromSdkUsage(usage), sdkCost(usage)],
      };
      return task;
    });
  }

  preview(taskId: string): Record<string, unknown> {
    const state = this.read();
    return buildReport(state, this.task(state, taskId));
  }

  deleteLocal(): { deleted: true } {
    return this.update((state) => {
      const quarantined = state.quarantined;
      const enabled = state.enabled;
      const next = emptyState();
      next.quarantined = quarantined;
      next.enabled = enabled;
      state.tasks = next.tasks;
      state.sessions = next.sessions;
      state.snapshots = next.snapshots;
      state.seen = next.seen;
      state.max_hook_overhead_ms = null;
      return { deleted: true as const };
    });
  }

  private retakeSnapshot(state: State, task: TaskRun, capturedAt: string): void {
    const current = state.snapshots.find((item) => item.id === task.snapshot_ids.at(-1));
    const session = state.sessions.find((item) => item.task_id === task.id && item.model_id !== null);
    const next = captureSnapshot({
      id: randomUUID(),
      capturedAt,
      root: this.root,
      platform: process.platform,
      nodeVersion: process.versions.node,
      cursorVersion: session?.cursor_version ?? current?.cursor_version ?? null,
      cliVersion: current?.cli_version ?? null,
      modelId: session?.model_id ?? null,
      family: task.family,
      form: task.form,
      configurationFamily: task.configuration_family,
      mcpIds: current?.mcp_components.map((item) => item.id) ?? [],
    });
    if (current !== undefined && current.fingerprint === next.fingerprint) {
      return;
    }
    state.snapshots.push(next);
    task.snapshot_ids.push(next.id);
  }

  private task(state: State, taskId: string): TaskRun {
    const task = state.tasks.find((item) => item.id === taskId);
    if (task === undefined) {
      throw new Error('Measured task was not found.');
    }
    return task;
  }

  private statusFrom(state: State): CollectorStatus {
    return {
      enabled: state.enabled,
      store_dir: this.dir,
      quarantined: state.quarantined,
      sources: {
        cursor_ide_hooks: 'template_only',
        cursor_cli: 'not_observed',
        cursor_sdk: 'usage_optional',
      },
      tasks: state.tasks.length,
      sessions: state.sessions.length,
    };
  }

  private update<T>(fn: (state: State) => T): T {
    return withLock(this.dir, () => {
      const state = this.read();
      const result = fn(state);
      this.write(state);
      return result;
    });
  }

  private file(): string {
    return path.join(this.dir, 'state.json');
  }

  private read(): State {
    mkdirSync(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as State;
      if (parsed.schema !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error('schema');
      }
      return parsed;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        return emptyState();
      }
      const quarantined = path.join(this.dir, `state.corrupt-${Date.now()}.json`);
      try {
        renameSync(this.file(), quarantined);
      } catch {
        // The unreadable file stays in place when it cannot be moved.
      }
      const fresh = emptyState();
      fresh.quarantined = true;
      this.write(fresh);
      return fresh;
    }
  }

  private write(state: State): void {
    const file = this.file();
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
  }
}

export function buildReport(state: State, task: TaskRun): Record<string, unknown> {
  const sessions = state.sessions.filter((session) => session.task_id === task.id);
  const snapshot = state.snapshots.find((item) => item.id === task.snapshot_ids.at(-1));
  const toolEvents = sessions.some((session) => session.saw_tool || session.saw_boundary);
  const dated = sessions.every((session) => session.undated_tools === 0);
  const durations = sessions.map((session) => session.duration_ms);
  const sessionDuration = sessions.length === 1 && durations[0] !== undefined && durations[0] !== null
    ? durations[0]
    : null;
  const intervals = sessions.flatMap((session) => session.intervals);
  const busy = !toolEvents || !dated
    ? null
    : intervals.length === 0
      ? 0
      : unionDuration(intervals);
  const calendar = task.ended_at === null ? null : Date.parse(task.ended_at) - Date.parse(task.started_at);
  const measurements: Measurement[] = [
    countMeasurement('tool_call_count', toolEvents ? sessions.reduce((sum, session) => sum + session.tool_calls, 0) : null, 'cursor-ide'),
    countMeasurement('tool_failure_count', toolEvents ? sessions.reduce((sum, session) => sum + session.tool_failures, 0) : null, 'cursor-ide'),
    msMeasurement('tool_duration_sum_ms', toolEvents && dated ? sessions.reduce((sum, session) => sum + session.tool_duration_sum_ms, 0) : null, 'instrumented', 'cursor-ide'),
    msMeasurement('tool_busy_ms', busy, 'derived', 'cursor-ide'),
    msMeasurement('session_duration_ms', sessionDuration, 'instrumented', 'cursor-ide'),
    msMeasurement('task_calendar_ms', calendar, 'derived', 'local-clock'),
    msMeasurement('active_agent_ms', null, 'unknown', 'unknown'),
    countMeasurement('prompt_count', sessions.some((session) => session.saw_prompt)
      ? sessions.reduce((sum, session) => sum + session.prompt_events, 0)
      : null, 'cursor-ide'),
    msMeasurement('hook_overhead_ms', state.max_hook_overhead_ms, 'instrumented', 'cursor-ide'),
  ];
  if (task.sdk !== null) {
    measurements.push(...task.sdk.measurements);
    measurements.push(msMeasurement('session_duration_ms', task.sdk.duration_ms, 'provider_reported', 'cursor-sdk'));
  } else {
    measurements.push(
      ...measurementsFromSdkUsage(undefined),
      sdkCost(undefined),
    );
  }
  const host = task.sdk !== null && sessions.length > 0
    ? 'mixed'
    : task.sdk !== null
      ? 'cursor-sdk'
      : sessions.length > 0
        ? 'cursor-ide'
        : 'unknown';
  return {
    schema_version: '1',
    report_id: task.report_id,
    source_kind: task.source_kind,
    environment: {
      snapshot_id: snapshot?.id ?? null,
      previous_snapshot_ids: task.snapshot_ids.slice(0, -1),
      host,
      cursor_version: snapshot?.cursor_version ?? null,
      cli_version: snapshot?.cli_version ?? null,
      model_id: snapshot?.model_id ?? sessions.find((session) => session.model_id !== null)?.model_id ?? null,
      os_family: snapshot?.os_family ?? 'unknown',
      tools: snapshot?.tools ?? [],
      rules: snapshot?.rules ?? [],
      skills: snapshot?.skills ?? [],
      mcp_components: snapshot?.mcp_components ?? [],
      task_family: task.family,
      context: {
        form: task.form,
        configuration_family: task.configuration_family,
      },
    },
    task: {
      family: task.family,
      outcome: task.outcome,
      attempt_count: task.attempts.length,
      session_count: sessions.length,
      verification: task.verification,
    },
    measurements,
  };
}

function countMeasurement(name: Measurement['name'], value: number | null, source: Measurement['source']): Measurement {
  return {
    name,
    unit: 'count',
    value,
    state: value === null ? 'unknown' : 'known',
    provenance: value === null ? 'unknown' : 'instrumented',
    source,
  };
}

function msMeasurement(
  name: Measurement['name'],
  value: number | null,
  provenance: Provenance,
  source: Measurement['source'],
): Measurement {
  return {
    name,
    unit: 'millisecond',
    value,
    state: value === null ? 'unknown' : 'known',
    provenance: value === null ? 'unknown' : provenance,
    source,
  };
}
