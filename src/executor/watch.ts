import { CommandError, runCommand } from './command.js';
import { markOutgoing, outgoingMap, type ExecutorState, type OutgoingRecord } from './journal.js';
import { MailboxError, type MailboxClient } from './mailbox.js';

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

const STATE_SUFFIX: Record<string, string> = {
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_INPUT_REQUIRED: 'input',
  TASK_STATE_AUTH_REQUIRED: 'auth',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WatchResult = {
  noticed: number;
  uncertain: number;
  ran: number;
  stopped: boolean;
};

export function resultIdempotencyKey(taskId: string, state: string): string {
  const suffix = STATE_SUFFIX[state] ?? 'state';
  return `watch-${taskId.replaceAll('-', '')}-${suffix}`;
}

export async function runWatchCycle(input: {
  mailbox: MailboxClient;
  state: ExecutorState;
  stateFile: string;
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
  for (const [taskId, record] of Object.entries(outgoing)) {
    if (record.phase !== 'running') {
      continue;
    }
    remember(input, taskId, {
      ...record,
      phase: 'uncertain',
      updatedAt: input.now().toISOString(),
    });
    uncertain += 1;
    input.log(`task ${taskId} is uncertain after a stop while its result was being handled`);
  }
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
      remember(input, taskId, {
        phase: 'seen',
        state: '',
        handledState: null,
        idempotencyKey: null,
        updatedAt: input.now().toISOString(),
      });
    }
  }
  for (const taskId of Object.keys(outgoing)) {
    const record = outgoing[taskId];
    if (record === undefined) {
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
    if (!ACTIONABLE.has(outcome.state)) {
      if (record.state !== outcome.state) {
        remember(input, taskId, {
          ...record,
          state: outcome.state,
          updatedAt: input.now().toISOString(),
        });
      }
      continue;
    }
    if (record.handledState === outcome.state && (record.phase === 'processed' || record.phase === 'uncertain')) {
      continue;
    }
    const idempotencyKey = resultIdempotencyKey(taskId, outcome.state);
    remember(input, taskId, {
      phase: 'running',
      state: outcome.state,
      handledState: outcome.state,
      idempotencyKey,
      updatedAt: input.now().toISOString(),
    });
    try {
      const stdout = await runCommand({
        argv: input.argv,
        stdin: JSON.stringify({
          taskId,
          state: outcome.state,
          statusTimestamp: outcome.timestamp,
          artifact: outcome.artifact,
          idempotencyKey,
        }),
        timeoutMs: input.timeoutMs,
      });
      ran += 1;
      for (const createdId of createdTaskIds(stdout)) {
        if (outgoing[createdId] === undefined) {
          remember(input, createdId, {
            phase: 'seen',
            state: '',
            handledState: null,
            idempotencyKey: null,
            updatedAt: input.now().toISOString(),
          });
        }
      }
      remember(input, taskId, {
        phase: 'processed',
        state: outcome.state,
        handledState: outcome.state,
        idempotencyKey,
        updatedAt: input.now().toISOString(),
      });
      noticed += 1;
    } catch (error) {
      remember(input, taskId, {
        phase: 'uncertain',
        state: outcome.state,
        handledState: outcome.state,
        idempotencyKey,
        updatedAt: input.now().toISOString(),
      });
      uncertain += 1;
      const reason = error instanceof CommandError ? error.message : 'The result command failed.';
      input.log(`task ${taskId} result was not handled: ${reason}`);
    }
  }
  return { noticed, uncertain, ran, stopped: false };
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

function remember(
  input: { state: ExecutorState; stateFile: string },
  taskId: string,
  record: OutgoingRecord,
): void {
  markOutgoing(input.stateFile, input.state, taskId, record);
}
