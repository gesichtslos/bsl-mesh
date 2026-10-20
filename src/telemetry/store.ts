import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { projectHook } from './allowlist.js';
import { unionDuration } from './intervals.js';
import { measurementsFromSdkUsage, sdkCost } from './sdk-usage.js';
import { captureSnapshot, type EnvironmentSnapshot } from './snapshot.js';
import { acceptedVerification, parseTelemetryReport } from './schema.js';
import {
  OUTCOMES,
  type FormKind,
  type Measurement,
  type Outcome,
  type ProjectedHook,
  type Provenance,
  type SourceKind,
} from './types.js';

const FAMILY = /^[a-z0-9-]{1,80}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

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

export type Observation = {
  dedupe_key: string;
  event: ProjectedHook['event'];
  conversation_digest: string | null;
  observed_at: string;
  cursor_version: string | null;
  model_id: string | null;
  duration_ms: number | null;
  failure: boolean;
  tool: boolean;
  stable_tool_id: boolean;
  prompt: boolean;
  session_end: boolean;
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
  schema: 2;
  enabled: boolean;
  quarantined: boolean;
  tasks: TaskRun[];
  observations: Observation[];
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
    schema: 2,
    enabled: false,
    quarantined: false,
    tasks: [],
    observations: [],
    snapshots: [],
    seen: [],
    max_hook_overhead_ms: null,
  };
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(dir, DIRECTORY_MODE);
}

function writePrivateFile(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, file);
  chmodSync(file, FILE_MODE);
}

function withLock<T>(dir: string, fn: () => T): T {
  ensurePrivateDirectory(dir);
  const lock = path.join(dir, 'lock');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', FILE_MODE);
      chmodSync(lock, FILE_MODE);
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
      sessions: conversationCount(state.observations),
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

  list(): Array<{ id: string; family: string; outcome: Outcome; attempts: number; sessions: number | null }> {
    const state = this.read();
    return state.tasks.map((task) => ({
      id: task.id,
      family: task.family,
      outcome: task.outcome,
      attempts: task.attempts.length,
      sessions: covering(state, task).unambiguousConversations,
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
    const accepted = acceptedVerification(outcome, verification);
    return this.update((state) => {
      const task = this.task(state, taskId);
      const current = this.now().toISOString();
      this.retakeSnapshot(state, task, current);
      task.outcome = outcome;
      task.verification = accepted;
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
      const tool = projected.event === 'postToolUse' || projected.event === 'postToolUseFailure';
      state.observations.push({
        dedupe_key: projected.dedupe_key,
        event: projected.event,
        conversation_digest: projected.conversation_digest,
        observed_at: projected.observed_at,
        cursor_version: projected.cursor_version,
        model_id: projected.model_id,
        duration_ms: tool ? projected.duration_ms : projected.event === 'sessionEnd' ? projected.duration_ms : null,
        failure: projected.event === 'postToolUseFailure',
        tool,
        stable_tool_id: projected.stable_tool_id,
        prompt: projected.event === 'beforeSubmitPrompt',
        session_end: projected.event === 'sessionEnd',
      });
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
    return parseTelemetryReport(buildReport(state, this.task(state, taskId)));
  }

  deleteLocal(): { deleted: true } {
    return this.update((state) => {
      const quarantined = state.quarantined;
      const enabled = state.enabled;
      const next = emptyState();
      next.quarantined = quarantined;
      next.enabled = enabled;
      state.tasks = next.tasks;
      state.observations = next.observations;
      state.snapshots = next.snapshots;
      state.seen = next.seen;
      state.max_hook_overhead_ms = null;
      return { deleted: true as const };
    });
  }

  private retakeSnapshot(state: State, task: TaskRun, capturedAt: string): void {
    const current = state.snapshots.find((item) => item.id === task.snapshot_ids.at(-1));
    const covered = covering(state, task);
    const next = captureSnapshot({
      id: randomUUID(),
      capturedAt,
      root: this.root,
      platform: process.platform,
      nodeVersion: process.versions.node,
      cursorVersion: covered.cursorVersion ?? current?.cursor_version ?? null,
      cliVersion: current?.cli_version ?? null,
      modelId: covered.modelAttribution === 'single' ? covered.modelId : null,
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
      sessions: conversationCount(state.observations),
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
    ensurePrivateDirectory(this.dir);
    try {
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as State;
      if (parsed.schema !== 2 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.observations)) {
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
        chmodSync(quarantined, FILE_MODE);
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
    ensurePrivateDirectory(this.dir);
    writePrivateFile(this.file(), JSON.stringify(state));
  }
}

type Coverage = {
  mine: Observation[];
  ambiguous: Observation[];
  unambiguousConversations: number | null;
  cursorVersion: string | null;
  modelId: string | null;
  modelAttribution: 'single' | 'mixed' | 'unknown';
};

function tasksCovering(state: State, observedAt: string): TaskRun[] {
  const time = Date.parse(observedAt);
  return state.tasks.filter((task) => {
    const start = Date.parse(task.started_at);
    const end = task.ended_at === null ? Number.POSITIVE_INFINITY : Date.parse(task.ended_at);
    return time >= start && time <= end;
  });
}

function covering(state: State, task: TaskRun): Coverage {
  const mine: Observation[] = [];
  const ambiguous: Observation[] = [];
  for (const observation of state.observations) {
    const owners = tasksCovering(state, observation.observed_at);
    if (!owners.some((item) => item.id === task.id)) {
      continue;
    }
    if (owners.length === 1) {
      mine.push(observation);
    } else {
      ambiguous.push(observation);
    }
  }
  const conversations = new Set(mine.map((item) => item.conversation_digest).filter((item) => item !== null));
  const models = new Set<string>();
  for (const observation of mine) {
    if (observation.model_id !== null) {
      models.add(observation.model_id);
    }
  }
  if (task.sdk?.model_id !== null && task.sdk?.model_id !== undefined) {
    models.add(task.sdk.model_id);
  }
  const toolEvents = mine.filter((item) => item.tool);
  const modelMissing = toolEvents.some((item) => item.model_id === null) || (task.sdk !== null && task.sdk.model_id === null && toolEvents.length > 0);
  let modelAttribution: Coverage['modelAttribution'] = 'unknown';
  let modelId: string | null = null;
  if (!modelMissing && models.size === 1) {
    modelAttribution = 'single';
    modelId = [...models][0] ?? null;
  } else if (models.size > 1) {
    modelAttribution = 'mixed';
  }
  return {
    mine,
    ambiguous,
    unambiguousConversations: ambiguous.length === 0 ? conversations.size : null,
    cursorVersion: mine.find((item) => item.cursor_version !== null)?.cursor_version ?? null,
    modelId,
    modelAttribution,
  };
}

function conversationCount(observations: readonly Observation[]): number {
  return new Set(observations.map((item) => item.conversation_digest).filter((item) => item !== null)).size;
}

function conversationSpansAnotherTask(state: State, task: TaskRun, digest: string): boolean {
  return state.observations.some((observation) => {
    if (observation.conversation_digest !== digest) {
      return false;
    }
    const owners = tasksCovering(state, observation.observed_at);
    return owners.length === 1 && owners[0]?.id !== task.id;
  });
}

export function buildReport(state: State, task: TaskRun): Record<string, unknown> {
  const covered = covering(state, task);
  const snapshot = state.snapshots.find((item) => item.id === task.snapshot_ids.at(-1));
  const tools = covered.mine.filter((item) => item.tool);
  const prompts = covered.mine.filter((item) => item.prompt);
  const ambiguousTools = covered.ambiguous.some((item) => item.tool);
  const unstable = tools.some((item) => !item.stable_tool_id);
  const undated = tools.some((item) => item.duration_ms === null);
  const preciseTools = tools.length > 0 && !ambiguousTools && !unstable;
  const intervals = preciseTools && !undated
    ? tools.flatMap((item) => (
      item.duration_ms === null
        ? []
        : [{ start: Date.parse(item.observed_at) - item.duration_ms, end: Date.parse(item.observed_at) }]
    ))
    : [];
  const ends = covered.mine.filter((item) => item.session_end && item.duration_ms !== null);
  const soleConversation = [...new Set(covered.mine.map((item) => item.conversation_digest).filter((item) => item !== null))];
  const sessionDuration = soleConversation.length === 1
    && ends.length === 1
    && ends[0]?.conversation_digest === soleConversation[0]
    && !conversationSpansAnotherTask(state, task, soleConversation[0] ?? '')
    ? ends[0]?.duration_ms ?? null
    : null;
  const calendar = task.ended_at === null ? null : Date.parse(task.ended_at) - Date.parse(task.started_at);
  const sawBoundary = covered.mine.some((item) => item.event === 'sessionStart' || item.session_end);
  const toolCount = preciseTools || (sawBoundary && !ambiguousTools && !unstable) ? tools.length : null;
  const measurements: Measurement[] = [
    countMeasurement('tool_call_count', toolCount, 'cursor-ide'),
    countMeasurement('tool_failure_count', toolCount === null ? null : tools.filter((item) => item.failure).length, 'cursor-ide'),
    msMeasurement('tool_duration_sum_ms', toolCount !== null && !undated && !unstable && !ambiguousTools ? tools.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0) : null, 'instrumented', 'cursor-ide'),
    msMeasurement('tool_busy_ms', toolCount !== null && !undated && !unstable && !ambiguousTools ? (intervals.length === 0 ? 0 : unionDuration(intervals)) : null, 'derived', 'cursor-ide'),
    msMeasurement('session_duration_ms', sessionDuration, 'instrumented', 'cursor-ide'),
    msMeasurement('task_calendar_ms', calendar, 'derived', 'local-clock'),
    msMeasurement('active_agent_ms', null, 'unknown', 'unknown'),
    countMeasurement('prompt_count', covered.ambiguous.some((item) => item.prompt) ? null : prompts.length > 0 ? prompts.length : null, 'cursor-ide'),
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
  const host = task.sdk !== null && covered.mine.length > 0
    ? 'mixed'
    : task.sdk !== null
      ? 'cursor-sdk'
      : covered.mine.length > 0
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
      cursor_version: snapshot?.cursor_version ?? covered.cursorVersion,
      cli_version: snapshot?.cli_version ?? null,
      model_id: covered.modelId,
      model_attribution: covered.modelAttribution,
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
      session_count: covered.unambiguousConversations,
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
