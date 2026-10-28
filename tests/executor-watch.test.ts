import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { loadState, type ExecutorState } from '../src/executor/journal.js';
import { MailboxError, type MailboxClient, type TaskOutcome } from '../src/executor/mailbox.js';
import { resultIdempotencyKey, runWatchCycle } from '../src/executor/watch.js';

const executorId = 'executor-0123456789abcdef';
const taskId = '018f1000-0000-7000-8000-000000000041';

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), 'bslmesh-watch-'));
}

function fresh(dir: string): { state: ExecutorState; file: string } {
  return {
    state: { executorId, tasks: {} },
    file: path.join(dir, 'state.json'),
  };
}

function mailbox(outcomes: Record<string, TaskOutcome>): MailboxClient & { published: number } {
  return {
    published: 0,
    listSubmitted: () => Promise.resolve([]),
    listRequester: (_contextId, state) => Promise.resolve(
      Object.entries(outcomes).flatMap(([id, outcome]) => (outcome.state === state ? [{ id }] : [])),
    ),
    read: () => Promise.resolve({ text: '', state: '', claimToken: null }),
    readOutcome: (id) => {
      const outcome = outcomes[id];
      if (outcome === undefined) {
        return Promise.reject(new MailboxError(404, false));
      }
      return Promise.resolve(outcome);
    },
    claim: () => Promise.resolve(),
    publish: function publish() {
      this.published += 1;
      return Promise.resolve();
    },
  };
}

function command(): string[] {
  return [process.execPath, '-e', `const fs=require('fs'); let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{fs.appendFileSync(process.env.OUT, s+'\\n'); process.stdout.write('noted')})`];
}

test('a completed result is handed to the command once and is not posted back onto that task', async () => {
  const dir = directory();
  const stored = fresh(dir);
  const seen = path.join(dir, 'seen');
  const box = mailbox({
    [taskId]: {
      state: 'TASK_STATE_COMPLETED',
      timestamp: '2026-10-28T12:00:00.000Z',
      artifact: 'reversed:abc',
    },
  });
  const input = {
    mailbox: box,
    state: stored.state,
    stateFile: stored.file,
    argv: command(),
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T12:01:00.000Z'),
    log: () => undefined,
  };
  const env = process.env['OUT'];
  process.env['OUT'] = seen;
  try {
    const first = await runWatchCycle(input);
    expect(first).toMatchObject({ noticed: 1, ran: 1, uncertain: 0, stopped: false });
    expect(box.published).toBe(0);
    const event = JSON.parse(readFileSync(seen, 'utf8').trim()) as {
      taskId: string;
      state: string;
      artifact: string;
      idempotencyKey: string;
    };
    expect(event).toMatchObject({
      taskId,
      state: 'TASK_STATE_COMPLETED',
      artifact: 'reversed:abc',
      idempotencyKey: resultIdempotencyKey(taskId, 'TASK_STATE_COMPLETED'),
    });
    const second = await runWatchCycle({
      ...input,
      state: loadState(stored.file, executorId),
    });
    expect(second.ran).toBe(0);
    expect(readFileSync(seen, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    if (env === undefined) {
      delete process.env['OUT'];
    } else {
      process.env['OUT'] = env;
    }
  }
});

test('a stop while handling a result stays uncertain and does not run the command again', async () => {
  const dir = directory();
  const file = path.join(dir, 'state.json');
  const state: ExecutorState = {
    executorId,
    tasks: {},
    outgoing: {
      [taskId]: {
        phase: 'running',
        state: 'TASK_STATE_FAILED',
        handledState: 'TASK_STATE_FAILED',
        idempotencyKey: resultIdempotencyKey(taskId, 'TASK_STATE_FAILED'),
        updatedAt: '2026-10-28T12:02:00.000Z',
      },
    },
  };
  const box = mailbox({
    [taskId]: { state: 'TASK_STATE_FAILED', timestamp: '2026-10-28T12:02:00.000Z', artifact: 'failed' },
  });
  const result = await runWatchCycle({
    mailbox: box,
    state,
    stateFile: file,
    argv: [process.execPath, '-e', 'process.stdout.write("should-not-run")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T12:03:00.000Z'),
    log: () => undefined,
  });
  expect(result).toMatchObject({ noticed: 0, ran: 0, uncertain: 1 });
  expect(loadState(file, executorId).outgoing?.[taskId]?.phase).toBe('uncertain');
});

test('failure and intervention are separate results, and a later state is a new event', async () => {
  const dir = directory();
  const stored = fresh(dir);
  const seen = path.join(dir, 'seen');
  const outcomes: Record<string, TaskOutcome> = {
    [taskId]: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-10-28T12:04:00.000Z', artifact: 'need a decision' },
  };
  const box = mailbox(outcomes);
  process.env['OUT'] = seen;
  try {
    const intervention = await runWatchCycle({
      mailbox: box,
      state: stored.state,
      stateFile: stored.file,
      argv: command(),
      contextId: undefined,
      timeoutMs: 5000,
      now: () => new Date('2026-10-28T12:04:30.000Z'),
      log: () => undefined,
    });
    expect(intervention.ran).toBe(1);
    outcomes[taskId] = { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-28T12:05:00.000Z', artifact: 'done' };
    const completed = await runWatchCycle({
      mailbox: box,
      state: loadState(stored.file, executorId),
      stateFile: stored.file,
      argv: command(),
      contextId: undefined,
      timeoutMs: 5000,
      now: () => new Date('2026-10-28T12:05:30.000Z'),
      log: () => undefined,
    });
    expect(completed.ran).toBe(1);
    const lines = readFileSync(seen, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ state: 'TASK_STATE_INPUT_REQUIRED' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ state: 'TASK_STATE_COMPLETED', artifact: 'done' });
  } finally {
    delete process.env['OUT'];
  }
});

test('ids printed by the command are remembered without choosing a recipient', async () => {
  const dir = directory();
  const stored = fresh(dir);
  const created = '018f1000-0000-7000-8000-000000000042';
  const box = mailbox({
    [taskId]: { state: 'TASK_STATE_REJECTED', timestamp: '2026-10-28T12:06:00.000Z', artifact: 'no' },
  });
  box.readOutcome = (id) => {
    if (id === created) {
      return Promise.resolve({ state: 'TASK_STATE_SUBMITTED', timestamp: '2026-10-28T12:06:01.000Z', artifact: '' });
    }
    const outcome = {
      [taskId]: { state: 'TASK_STATE_REJECTED', timestamp: '2026-10-28T12:06:00.000Z', artifact: 'no' },
    }[id];
    if (outcome === undefined) {
      return Promise.reject(new MailboxError(404, false));
    }
    return Promise.resolve(outcome);
  };
  const result = await runWatchCycle({
    mailbox: box,
    state: stored.state,
    stateFile: stored.file,
    argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ watch: [created] }))})`],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T12:06:30.000Z'),
    log: () => undefined,
  });
  expect(result.ran).toBe(1);
  expect(loadState(stored.file, executorId).outgoing?.[created]?.phase).toBe('seen');
});
