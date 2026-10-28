import { CommandError, runCommand } from './command.js';
import { markOutgoing, outgoingMap, type ExecutorState, type OutgoingRecord } from './journal.js';
import { MailboxError, type MailboxClient } from './mailbox.js';
import { eventIdentity, loadPlan, recordTaskId, resultIdempotencyKey } from './outbox.js';

const ACTIONABLE = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

const DISCOVERY = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  ...ACTIONABLE.keys(),
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STOPPED = new Set(['no-saved-plan', 'idempotency-conflict', 'send-failed']);

export type WatchResult = {
  noticed: number;
  uncertain: number;
  ran: number;
  stopped: boolean;
};

export { resultIdempotencyKey };

export async function runWatchCycle(input: {
  mailbox: MailboxClient;
  state: ExecutorState;
  stateFile: string;
  outboxFile: string;
  argv: readonly string[];
  contextId: string | undefined;
  timeoutMs: number;
  now: () => Date;
  log: (line: string) => void;
}): Promise<WatchResult> {
  let noticed = 0;
  let uncertain = 0;
  let ran = 0;
  const outgoing = outgoingMap(input.state);
  let discovered;
  try {
    discovered = await discover(input.mailbox, input.contextId);
  } catch (error) {
    if (error instanceof MailboxError && !error.retryable) {
      input.log('mailbox rejected the result poll');
      return { noticed, uncertain, ran, stopped: true };
    }
    throw error;
  }
  for (const taskId of discovered) {
    if (outgoing[taskId] === undefined) {
      remember(input, taskId, blank(input.now()));
    }
  }
  for (const taskId of Object.keys(outgoing)) {
    const record = outgoing[taskId];
    if (record === undefined) {
      continue;
    }
    if (record.phase === 'running' && record.handledEvent !== null) {
      const settled = await settle(input, taskId, record.handledEvent);
      if (settled === 'retry') {
        throw new MailboxError(503, true);
      }
      if (settled === 'processed') {
        noticed += 1;
      } else {
        uncertain += 1;
      }
      continue;
    }
    let outcome;
    try {
      outcome = await input.mailbox.readOutcome(taskId);
    } catch (error) {
      if (error instanceof MailboxError && error.status === 404) {
        if (record.phase !== 'uncertain') {
          remember(input, taskId, {
            ...record,
            phase: 'uncertain',
            reason: 'task-unreadable',
            updatedAt: input.now().toISOString(),
          });
          uncertain += 1;
          input.log(`task ${taskId} is uncertain because it can no longer be read`);
        }
        continue;
      }
      if (error instanceof MailboxError && !error.retryable) {
        input.log('mailbox rejected a task read');
        return { noticed, uncertain, ran, stopped: true };
      }
      throw error;
    }
    const identity = eventIdentity(taskId, outcome.state, outcome.timestamp);
    if (!ACTIONABLE.has(outcome.state)) {
      if (record.state !== outcome.state) {
        remember(input, taskId, { ...record, state: outcome.state, updatedAt: input.now().toISOString() });
      }
      continue;
    }
    if (record.handledEvent === identity && record.phase === 'processed') {
      continue;
    }
    if (record.handledEvent === identity && record.phase === 'uncertain' && record.reason !== null && STOPPED.has(record.reason)) {
      continue;
    }
    if (record.handledEvent === identity && record.phase === 'uncertain') {
      const settled = await settle(input, taskId, identity);
      if (settled === 'retry') {
        throw new MailboxError(503, true);
      }
      if (settled === 'processed') {
        noticed += 1;
      } else {
        uncertain += 1;
      }
      continue;
    }
    const idempotencyKey = resultIdempotencyKey(taskId, outcome.state, outcome.timestamp);
    remember(input, taskId, {
      phase: 'running',
      state: outcome.state,
      handledEvent: identity,
      idempotencyKey,
      reason: null,
      updatedAt: input.now().toISOString(),
    });
    try {
      const stdout = await runCommand({
        argv: input.argv,
        stdin: JSON.stringify({
          taskId,
          state: outcome.state,
          statusTimestamp: outcome.timestamp,
          eventId: identity,
          artifact: outcome.artifact,
          idempotencyKey,
          outboxFile: input.outboxFile,
        }),
        timeoutMs: input.timeoutMs,
      });
      ran += 1;
      for (const createdId of createdTaskIds(stdout)) {
        if (outgoing[createdId] === undefined) {
          remember(input, createdId, blank(input.now()));
        }
      }
    } catch (error) {
      const reason = error instanceof CommandError ? error.message : 'The result command failed.';
      input.log(`task ${taskId} result command stopped: ${reason}`);
    }
    const settled = await settle(input, taskId, identity);
    if (settled === 'retry') {
      throw new MailboxError(503, true);
    }
    if (settled === 'processed') {
      noticed += 1;
    } else {
      uncertain += 1;
    }
  }
  return { noticed, uncertain, ran, stopped: false };
}

async function settle(
  input: {
    mailbox: MailboxClient;
    state: ExecutorState;
    stateFile: string;
    outboxFile: string;
    now: () => Date;
    log: (line: string) => void;
  },
  sourceTaskId: string,
  identity: string,
): Promise<'processed' | 'uncertain' | 'retry'> {
  const plan = loadPlan(input.outboxFile, identity);
  if (plan === null) {
    remember(input, sourceTaskId, {
      phase: 'uncertain',
      state: input.state.outgoing?.[sourceTaskId]?.state ?? '',
      handledEvent: identity,
      idempotencyKey: input.state.outgoing?.[sourceTaskId]?.idempotencyKey ?? null,
      reason: 'no-saved-plan',
      updatedAt: input.now().toISOString(),
    });
    input.log(`task ${sourceTaskId} stayed uncertain because no send plan was saved`);
    return 'uncertain';
  }
  for (const action of plan.actions) {
    if (action.taskId !== null) {
      if (outgoingMap(input.state)[action.taskId] === undefined) {
        remember(input, action.taskId, blank(input.now()));
      }
      continue;
    }
    try {
      const createdId = await input.mailbox.sendPrepared(action.idempotencyKey, action.body);
      recordTaskId(input.outboxFile, identity, action.index, createdId);
      if (outgoingMap(input.state)[createdId] === undefined) {
        remember(input, createdId, blank(input.now()));
      }
    } catch (error) {
      if (error instanceof MailboxError && error.retryable) {
        return 'retry';
      }
      const reason = error instanceof MailboxError && error.status === 409 ? 'idempotency-conflict' : 'send-failed';
      remember(input, sourceTaskId, {
        phase: 'uncertain',
        state: input.state.outgoing?.[sourceTaskId]?.state ?? '',
        handledEvent: identity,
        idempotencyKey: input.state.outgoing?.[sourceTaskId]?.idempotencyKey ?? null,
        reason,
        updatedAt: input.now().toISOString(),
      });
      input.log(`task ${sourceTaskId} stayed uncertain because a saved send could not be restored (${reason})`);
      return 'uncertain';
    }
  }
  const current = input.state.outgoing?.[sourceTaskId];
  remember(input, sourceTaskId, {
    phase: 'processed',
    state: current?.state ?? '',
    handledEvent: identity,
    idempotencyKey: current?.idempotencyKey ?? plan.eventKey,
    reason: null,
    updatedAt: input.now().toISOString(),
  });
  return 'processed';
}

async function discover(mailbox: MailboxClient, contextId: string | undefined): Promise<string[]> {
  const ids = new Set<string>();
  for (const state of DISCOVERY) {
    const page = await mailbox.listRequester(contextId, state);
    for (const task of page) {
      ids.add(task.id);
    }
  }
  return [...ids];
}

function createdTaskIds(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { watch?: unknown };
    if (!Array.isArray(parsed.watch)) {
      return [];
    }
    return parsed.watch.filter((item): item is string => typeof item === 'string' && UUID.test(item));
  } catch {
    return [];
  }
}

function blank(now: Date): OutgoingRecord {
  return {
    phase: 'seen',
    state: '',
    handledEvent: null,
    idempotencyKey: null,
    reason: null,
    updatedAt: now.toISOString(),
  };
}

function remember(
  input: { state: ExecutorState; stateFile: string },
  taskId: string,
  record: OutgoingRecord,
): void {
  markOutgoing(input.stateFile, input.state, taskId, record);
}
