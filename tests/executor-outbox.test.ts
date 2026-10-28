import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { loadState, type ExecutorState } from '../src/executor/journal.js';
import type { MailboxClient } from '../src/executor/mailbox.js';
import { actionIdempotencyKey, commitPlan, loadPlan, resultIdempotencyKey } from '../src/executor/outbox.js';
import { runWatchCycle } from '../src/executor/watch.js';

const sourceId = '018f1000-0000-7000-8000-000000000051';
const eventId = `${sourceId}|TASK_STATE_COMPLETED|2026-10-28T14:00:00.000Z`;
const eventKey = resultIdempotencyKey(sourceId, 'TASK_STATE_COMPLETED', '2026-10-28T14:00:00.000Z');

test('a saved plan is not replaced, and recovery repeats the accepted send once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bslmesh-outbox-'));
  const outbox = path.join(dir, 'outbox.json');
  const stateFile = path.join(dir, 'state.json');
  const first = commitPlan(outbox, eventId, eventKey, [{
    recipientAgentId: '018f1000-0000-7000-8000-000000000061',
    text: 'Первое поручение.',
    contextId: '018f1000-0000-7000-8000-000000000071',
  }]);
  commitPlan(outbox, eventId, eventKey, [{
    recipientAgentId: '018f1000-0000-7000-8000-000000000062',
    text: 'Другой текст, который не должен заменить план.',
  }]);
  expect(loadPlan(outbox, eventId)?.actions[0]?.body).toEqual(first.actions[0]?.body);
  expect(first.actions[0]?.idempotencyKey).toBe(actionIdempotencyKey(eventKey, 0));
  const created = '018f1000-0000-7000-8000-000000000081';
  let sends = 0;
  const state: ExecutorState = {
    executorId: 'executor-0123456789abcdef',
    tasks: {},
    outgoing: {
      [sourceId]: {
        phase: 'running',
        state: 'TASK_STATE_COMPLETED',
        handledEvent: eventId,
        idempotencyKey: eventKey,
        reason: null,
        updatedAt: '2026-10-28T14:00:01.000Z',
      },
    },
  };
  const mailbox: MailboxClient = {
    listSubmitted: () => Promise.resolve([]),
    listRequester: () => Promise.resolve([]),
    read: () => Promise.resolve({ text: '', state: '', claimToken: null }),
    readOutcome: (id) => Promise.resolve(id === sourceId
      ? { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-28T14:00:00.000Z', artifact: 'done' }
      : { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-10-28T14:00:02.000Z', artifact: '' }),
    claim: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    sendPrepared: () => {
      sends += 1;
      return Promise.resolve(created);
    },
  };
  const recovered = await runWatchCycle({
    mailbox,
    state,
    stateFile,
    outboxFile: outbox,
    argv: [process.execPath, '-e', 'process.stdout.write("model")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T14:00:30.000Z'),
    log: () => undefined,
  });
  expect(recovered).toMatchObject({ ran: 0, noticed: 1, uncertain: 0 });
  expect(sends).toBe(1);
  expect(loadPlan(outbox, eventId)?.actions[0]?.taskId).toBe(created);
  const again = await runWatchCycle({
    mailbox,
    state: loadState(stateFile, 'executor-0123456789abcdef'),
    stateFile,
    outboxFile: outbox,
    argv: [process.execPath, '-e', 'process.stdout.write("model")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T14:01:00.000Z'),
    log: () => undefined,
  });
  expect(again.ran).toBe(0);
  expect(sends).toBe(1);
});

test('several saved sends keep distinct keys and are restored without a new plan', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bslmesh-outbox-many-'));
  const outbox = path.join(dir, 'outbox.json');
  const stateFile = path.join(dir, 'state.json');
  const drafts = [
    { recipientAgentId: '018f1000-0000-7000-8000-000000000061', text: 'Разработчику.' },
    { recipientAgentId: '018f1000-0000-7000-8000-000000000062', text: 'Тестировщику.' },
  ];
  const plan = commitPlan(outbox, eventId, eventKey, drafts);
  expect(plan.actions.map((item) => item.idempotencyKey)).toEqual([
    actionIdempotencyKey(eventKey, 0),
    actionIdempotencyKey(eventKey, 1),
  ]);
  const sent: string[] = [];
  const mailbox: MailboxClient = {
    listSubmitted: () => Promise.resolve([]),
    listRequester: () => Promise.resolve([]),
    read: () => Promise.resolve({ text: '', state: '', claimToken: null }),
    readOutcome: (id) => Promise.resolve(id === sourceId
      ? { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-28T14:00:00.000Z', artifact: 'done' }
      : { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-10-28T14:00:02.000Z', artifact: '' }),
    claim: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    sendPrepared: (key) => {
      sent.push(key);
      return Promise.resolve(key.endsWith('-0')
        ? '018f1000-0000-7000-8000-000000000091'
        : '018f1000-0000-7000-8000-000000000092');
    },
  };
  const state: ExecutorState = {
    executorId: 'executor-0123456789abcdef',
    tasks: {},
    outgoing: {
      [sourceId]: {
        phase: 'running',
        state: 'TASK_STATE_COMPLETED',
        handledEvent: eventId,
        idempotencyKey: eventKey,
        reason: null,
        updatedAt: '2026-10-28T14:00:01.000Z',
      },
    },
  };
  await runWatchCycle({
    mailbox,
    state,
    stateFile,
    outboxFile: outbox,
    argv: [process.execPath, '-e', 'process.stdout.write("model")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T14:02:00.000Z'),
    log: () => undefined,
  });
  expect(sent).toEqual([actionIdempotencyKey(eventKey, 0), actionIdempotencyKey(eventKey, 1)]);
  await runWatchCycle({
    mailbox,
    state: loadState(stateFile, 'executor-0123456789abcdef'),
    stateFile,
    outboxFile: outbox,
    argv: [process.execPath, '-e', 'process.stdout.write("model")'],
    contextId: undefined,
    timeoutMs: 5000,
    now: () => new Date('2026-10-28T14:03:00.000Z'),
    log: () => undefined,
  });
  expect(sent).toHaveLength(2);
  expect(loadPlan(outbox, eventId)?.actions.map((item) => item.taskId)).toEqual([
    '018f1000-0000-7000-8000-000000000091',
    '018f1000-0000-7000-8000-000000000092',
  ]);
});
