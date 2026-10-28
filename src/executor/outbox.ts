import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

export type OutgoingDraft = {
  recipientAgentId: string;
  text: string;
  contextId?: string;
  visibleAt?: string;
};

export type PlannedSend = {
  index: number;
  idempotencyKey: string;
  body: Record<string, unknown>;
  taskId: string | null;
};

export type SendPlan = {
  eventId: string;
  eventKey: string;
  actions: PlannedSend[];
};

type OutboxFile = {
  plans: Record<string, SendPlan>;
};

export function eventIdentity(taskId: string, state: string, statusTimestamp: string): string {
  return `${taskId}|${state}|${statusTimestamp}`;
}

export function resultIdempotencyKey(taskId: string, state: string, statusTimestamp: string): string {
  const digest = createHash('sha256').update(eventIdentity(taskId, state, statusTimestamp)).digest('hex').slice(0, 32);
  return `watch-${digest}`;
}

export function actionIdempotencyKey(eventKey: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99) {
    throw new Error('An outgoing action index must be from 0 to 99.');
  }
  const key = `${eventKey}-${index}`;
  if (!KEY.test(key)) {
    throw new Error('The outgoing idempotency key is not usable.');
  }
  return key;
}

export function buildSendBody(idempotencyKey: string, draft: OutgoingDraft): Record<string, unknown> {
  return {
    message: {
      messageId: idempotencyKey,
      role: 'ROLE_USER',
      ...(draft.contextId === undefined ? {} : { contextId: draft.contextId }),
      parts: [{ text: draft.text }],
    },
    configuration: { returnImmediately: true },
    metadata: {
      [EXTENSION]: {
        recipientAgentId: draft.recipientAgentId,
        ...(draft.visibleAt === undefined ? {} : { visibleAt: draft.visibleAt }),
      },
    },
  };
}

export function commitPlan(file: string, eventId: string, eventKey: string, drafts: readonly OutgoingDraft[]): SendPlan {
  const stored = readOutbox(file);
  const existing = stored.plans[eventId];
  if (existing !== undefined) {
    return existing;
  }
  const actions = drafts.map((draft, index) => {
    const idempotencyKey = actionIdempotencyKey(eventKey, index);
    return {
      index,
      idempotencyKey,
      body: buildSendBody(idempotencyKey, draft),
      taskId: null,
    };
  });
  const plan: SendPlan = { eventId, eventKey, actions };
  stored.plans[eventId] = plan;
  writeOutbox(file, stored);
  return plan;
}

export function loadPlan(file: string, eventId: string): SendPlan | null {
  return readOutbox(file).plans[eventId] ?? null;
}

export function recordTaskId(file: string, eventId: string, index: number, taskId: string): void {
  const stored = readOutbox(file);
  const plan = stored.plans[eventId];
  const action = plan?.actions.find((item) => item.index === index);
  if (plan === undefined || action === undefined) {
    throw new Error('The saved send plan does not contain that action.');
  }
  if (action.taskId !== null && action.taskId !== taskId) {
    throw new Error('The saved send already has a different task id.');
  }
  action.taskId = taskId;
  writeOutbox(file, stored);
}

function readOutbox(file: string): OutboxFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OutboxFile;
    if (parsed.plans === undefined || parsed.plans === null || typeof parsed.plans !== 'object' || Array.isArray(parsed.plans)) {
      throw new Error('The outbox file is unreadable.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { plans: {} };
    }
    throw error;
  }
}

function writeOutbox(file: string, stored: OutboxFile): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}
