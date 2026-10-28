import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseCommand } from '../src/executor/command.js';
import { runCycle } from '../src/executor/cycle.js';
import { loadState, type ExecutorState } from '../src/executor/journal.js';
import { MailboxError, type MailboxClient, type TaskBody, type WaitingTask } from '../src/executor/mailbox.js';

const executorId = 'executor-0123456789abcdef';

function state(directory: string): { state: ExecutorState; file: string } {
  return {
    state: { executorId, tasks: {} },
    file: path.join(directory, 'state.json'),
  };
}

function mailbox(tasks: WaitingTask[], claimToken = executorId): MailboxClient & { claims: number; published: string[] } {
  return {
    claims: 0,
    published: [],
    listSubmitted: () => Promise.resolve(tasks),
    read: () => Promise.resolve({ text: 'work item', state: 'TASK_STATE_WORKING', claimToken } satisfies TaskBody),
    claim: function claim() {
      this.claims += 1;
      return Promise.resolve();
    },
    publish: function publish(_taskId: string, text: string) {
      this.published.push(text);
      return Promise.resolve();
    },
  };
}

test('the command is an argv array and the task text is data, not a shell line', () => {
  expect(parseCommand('["node","-e","process.stdin.pipe(process.stdout)"]')).toEqual([
    'node',
    '-e',
    'process.stdin.pipe(process.stdout)',
  ]);
  expect(() => parseCommand('node -e "rm -rf /"')).toThrow(/JSON array/);
});

test('a new task is claimed once, the command runs once, and a later cycle does not run it again', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-'));
  const stored = state(directory);
  const box = mailbox([{ id: '018f1000-0000-7000-8000-000000000031' }]);
  const argv = [process.execPath, '-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write("ok:"+s.trim()))'];
  const first = await runCycle({
    mailbox: box,
    state: stored.state,
    stateFile: stored.file,
    argv,
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    log: () => undefined,
  });
  expect(first).toMatchObject({ published: 1, ran: 1, uncertain: 0, stopped: false });
  expect(box.claims).toBe(1);
  expect(box.published).toEqual(['ok:work item']);
  const second = await runCycle({
    mailbox: box,
    state: loadState(stored.file, executorId),
    stateFile: stored.file,
    argv,
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T10:01:00.000Z'),
    log: () => undefined,
  });
  expect(second.ran).toBe(0);
  expect(box.claims).toBe(1);
});

test('a crash after claim does not start the command again', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-'));
  const file = path.join(directory, 'state.json');
  const stored: ExecutorState = {
    executorId,
    tasks: {
      '018f1000-0000-7000-8000-000000000032': {
        phase: 'claimed',
        answer: null,
        updatedAt: '2026-10-28T10:00:00.000Z',
      },
    },
  };
  const box = mailbox([{ id: '018f1000-0000-7000-8000-000000000032' }]);
  const argv = [process.execPath, '-e', 'process.stdout.write("should-not-run")'];
  const result = await runCycle({
    mailbox: box,
    state: stored,
    stateFile: file,
    argv,
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T10:02:00.000Z'),
    log: () => undefined,
  });
  expect(result).toMatchObject({ published: 0, ran: 0, uncertain: 1 });
  expect(box.claims).toBe(0);
  expect(loadState(file, executorId).tasks['018f1000-0000-7000-8000-000000000032']?.phase).toBe('uncertain');
});

test('a conflicting claim does not run the command', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bslmesh-executor-'));
  const stored = state(directory);
  const box = mailbox([{ id: '018f1000-0000-7000-8000-000000000033' }]);
  box.claim = () => Promise.reject(new MailboxError(409, false));
  const result = await runCycle({
    mailbox: box,
    state: stored.state,
    stateFile: stored.file,
    argv: [process.execPath, '-e', 'process.stdout.write("no")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T10:03:00.000Z'),
    log: () => undefined,
  });
  expect(result).toMatchObject({ ran: 0, uncertain: 1, published: 0 });
});
