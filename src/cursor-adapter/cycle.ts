import { MeshError, type MeshClient } from './mesh.js';
import { promptFor } from './policy.js';
import { CursorRunError, type CursorRuntime } from './runtime.js';
import { type AdapterState, type TaskRecord, saveState } from './store.js';

export type CycleResult = {
  published: number;
  uncertain: number;
  stopped: boolean;
};

export async function runCycle(input: {
  mesh: MeshClient;
  runtime: CursorRuntime;
  state: AdapterState;
  stateFile: string;
  workspace: string;
  maxParallel: number;
  log: (line: string) => void;
}): Promise<CycleResult> {
  let published = 0;
  let uncertain = 0;
  let owned;
  try {
    owned = await input.mesh.listByState('TASK_STATE_WORKING');
  } catch (error) {
    if (error instanceof MeshError && !error.retryable) {
      input.log(`mailbox rejected the poll: ${error.detail}`);
      return { published, uncertain, stopped: true };
    }
    throw error;
  }
  for (const task of owned) {
    if (input.state.tasks[task.id] !== undefined) {
      continue;
    }
    const body = await input.mesh.readTask(task.id);
    if (body.claimToken === input.state.adapterId) {
      mark(input, task.id, { phase: 'uncertain', sessionId: null, answer: null, updatedAt: new Date().toISOString() });
      uncertain += 1;
      input.log(`task ${task.id} was claimed before a session id was stored and will not be started again`);
    }
  }
  for (const [taskId, record] of Object.entries(input.state.tasks)) {
    if (record.phase === 'published' || record.phase === 'uncertain') {
      continue;
    }
    if (record.phase === 'claimed') {
      mark(input, taskId, { ...record, phase: 'uncertain' });
      uncertain += 1;
      input.log(`task ${taskId} is uncertain after a crash before a session id was stored`);
      continue;
    }
    if (record.phase === 'answered' && record.answer !== null) {
      if (await publish(input, taskId, record.answer)) {
        published += 1;
      } else {
        uncertain += 1;
      }
      continue;
    }
    if (record.phase === 'session-open' && record.sessionId !== null) {
      const answer = await resume(input, record.sessionId);
      if (answer === null) {
        mark(input, taskId, { ...record, phase: 'uncertain' });
        uncertain += 1;
        continue;
      }
      mark(input, taskId, { ...record, phase: 'answered', answer });
      if (await publish(input, taskId, answer)) {
        published += 1;
      } else {
        uncertain += 1;
      }
    }
  }
  const active = Object.values(input.state.tasks).filter((item) => item.phase === 'session-open' || item.phase === 'claimed').length;
  const room = Math.max(0, input.maxParallel - active);
  if (room === 0) {
    return { published, uncertain, stopped: false };
  }
  let waiting;
  try {
    waiting = await input.mesh.listWaiting();
  } catch (error) {
    if (error instanceof MeshError && !error.retryable) {
      input.log(`mailbox rejected the poll: ${error.detail}`);
      return { published, uncertain, stopped: true };
    }
    throw error;
  }
  let started = 0;
  for (const task of waiting) {
    if (started >= room || input.state.tasks[task.id]?.phase !== undefined) {
      continue;
    }
    try {
      await input.mesh.claim(task.id, input.state.adapterId);
    } catch (error) {
      if (error instanceof MeshError && error.status === 409) {
        continue;
      }
      if (error instanceof MeshError && !error.retryable) {
        input.log(`mailbox rejected a claim: ${error.detail}`);
        return { published, uncertain, stopped: true };
      }
      throw error;
    }
    mark(input, task.id, { phase: 'claimed', sessionId: null, answer: null, updatedAt: new Date().toISOString() });
    const body = await input.mesh.readTask(task.id);
    if (body.claimToken !== input.state.adapterId || body.text.trim() === '') {
      mark(input, task.id, { phase: 'uncertain', sessionId: null, answer: null, updatedAt: new Date().toISOString() });
      uncertain += 1;
      continue;
    }
    let sessionId: string;
    try {
      sessionId = await input.runtime.createChat(input.workspace);
    } catch (error) {
      mark(input, task.id, { phase: 'uncertain', sessionId: null, answer: null, updatedAt: new Date().toISOString() });
      if (error instanceof CursorRunError && error.fatal) {
        input.log('Cursor authentication failed. The adapter stopped.');
        return { published, uncertain: uncertain + 1, stopped: true };
      }
      uncertain += 1;
      const reason = error instanceof Error ? error.message : 'Cursor did not open a session.';
      input.log(`Cursor did not open a session for ${task.id}: ${reason}`);
      continue;
    }
    mark(input, task.id, { phase: 'session-open', sessionId, answer: null, updatedAt: new Date().toISOString() });
    const answer = await ask(input, sessionId, promptFor(body.text));
    if (answer === null) {
      mark(input, task.id, { phase: 'uncertain', sessionId, answer: null, updatedAt: new Date().toISOString() });
      uncertain += 1;
      continue;
    }
    mark(input, task.id, { phase: 'answered', sessionId, answer, updatedAt: new Date().toISOString() });
    if (await publish(input, task.id, answer)) {
      published += 1;
    } else {
      uncertain += 1;
    }
    started += 1;
  }
  return { published, uncertain, stopped: false };
}

async function resume(input: { runtime: CursorRuntime; workspace: string; log: (line: string) => void }, sessionId: string): Promise<string | null> {
  return ask(input, sessionId, promptFor('Repeat only the final plain-text answer from this session. Do not use tools.'));
}

async function ask(
  input: { runtime: CursorRuntime; workspace: string; log: (line: string) => void },
  sessionId: string,
  prompt: string,
): Promise<string | null> {
  try {
    const answer = await input.runtime.answer(input.workspace, sessionId, prompt);
    if (answer.usageNote !== null) {
      input.log(`cursor usage ${answer.usageNote}`);
    }
    if (answer.modelCalls !== null) {
      input.log(`cursor model calls ${answer.modelCalls}`);
    }
    const text = answer.text.trim();
    if (text === '' || text.length > 8000) {
      return null;
    }
    return text;
  } catch (error) {
    if (error instanceof CursorRunError && error.fatal) {
      throw error;
    }
    input.log('Cursor did not return an answer. The task was not started again.');
    return null;
  }
}

async function publish(
  input: { mesh: MeshClient; state: AdapterState; stateFile: string; log: (line: string) => void },
  taskId: string,
  answer: string,
): Promise<boolean> {
  try {
    await input.mesh.publish(taskId, answer);
  } catch (error) {
    if (error instanceof MeshError && error.retryable) {
      input.log(`result for ${taskId} was not stored; the same answer will be retried`);
      return false;
    }
    mark(input, taskId, {
      phase: 'uncertain',
      sessionId: input.state.tasks[taskId]?.sessionId ?? null,
      answer,
      updatedAt: new Date().toISOString(),
    });
    input.log(`result for ${taskId} was rejected and will not be rewritten`);
    return false;
  }
  mark(input, taskId, {
    phase: 'published',
    sessionId: input.state.tasks[taskId]?.sessionId ?? null,
    answer,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

function mark(
  input: { state: AdapterState; stateFile: string },
  taskId: string,
  record: TaskRecord,
): void {
  input.state.tasks[taskId] = record;
  saveState(input.stateFile, input.state);
}
