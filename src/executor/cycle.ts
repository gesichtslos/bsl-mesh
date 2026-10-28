import { CommandError, runCommand } from './command.js';
import { mark, type ExecutorState } from './journal.js';
import { MailboxError, type MailboxClient } from './mailbox.js';

export type CycleResult = {
  published: number;
  uncertain: number;
  ran: number;
  stopped: boolean;
};

export async function runCycle(input: {
  mailbox: MailboxClient;
  state: ExecutorState;
  stateFile: string;
  argv: readonly string[];
  contextId: string | undefined;
  timeoutMs: number;
  now: () => Date;
  log: (line: string) => void;
}): Promise<CycleResult> {
  let published = 0;
  let uncertain = 0;
  let ran = 0;
  let waiting;
  try {
    waiting = await input.mailbox.listSubmitted(input.contextId);
  } catch (error) {
    if (error instanceof MailboxError && !error.retryable) {
      input.log('mailbox rejected the poll');
      return { published, uncertain, ran, stopped: true };
    }
    throw error;
  }
  for (const [taskId, record] of Object.entries(input.state.tasks)) {
    if (record.phase === 'published' || record.phase === 'uncertain') {
      continue;
    }
    if (record.phase === 'claimed') {
      mark(input.stateFile, input.state, taskId, { phase: 'uncertain', answer: null, updatedAt: input.now().toISOString() });
      uncertain += 1;
      input.log(`task ${taskId} is uncertain after a stop before the result was stored`);
      continue;
    }
    if (record.phase === 'answered' && record.answer !== null) {
      if (await publish(input, taskId, record.answer)) {
        published += 1;
      } else {
        uncertain += 1;
      }
    }
  }
  for (const task of waiting) {
    if (input.state.tasks[task.id] !== undefined) {
      continue;
    }
    try {
      await input.mailbox.claim(task.id, input.state.executorId);
    } catch (error) {
      if (error instanceof MailboxError && error.status === 409) {
        mark(input.stateFile, input.state, task.id, { phase: 'uncertain', answer: null, updatedAt: input.now().toISOString() });
        uncertain += 1;
        input.log(`task ${task.id} was already claimed`);
        continue;
      }
      if (error instanceof MailboxError && !error.retryable) {
        input.log('mailbox rejected a claim');
        return { published, uncertain, ran, stopped: true };
      }
      throw error;
    }
    mark(input.stateFile, input.state, task.id, { phase: 'claimed', answer: null, updatedAt: input.now().toISOString() });
    const body = await input.mailbox.read(task.id);
    if (body.claimToken !== input.state.executorId || body.text.trim() === '') {
      mark(input.stateFile, input.state, task.id, { phase: 'uncertain', answer: null, updatedAt: input.now().toISOString() });
      uncertain += 1;
      continue;
    }
    let answer: string;
    try {
      answer = await runCommand({ argv: input.argv, stdin: body.text, timeoutMs: input.timeoutMs });
      ran += 1;
    } catch (error) {
      mark(input.stateFile, input.state, task.id, { phase: 'uncertain', answer: null, updatedAt: input.now().toISOString() });
      uncertain += 1;
      const reason = error instanceof CommandError ? error.message : 'The command failed.';
      input.log(`task ${task.id} did not finish: ${reason}`);
      continue;
    }
    mark(input.stateFile, input.state, task.id, { phase: 'answered', answer, updatedAt: input.now().toISOString() });
    if (await publish(input, task.id, answer)) {
      published += 1;
    } else {
      uncertain += 1;
    }
  }
  return { published, uncertain, ran, stopped: false };
}

async function publish(
  input: { mailbox: MailboxClient; state: ExecutorState; stateFile: string; now: () => Date; log: (line: string) => void },
  taskId: string,
  answer: string,
): Promise<boolean> {
  try {
    await input.mailbox.publish(taskId, answer);
  } catch (error) {
    if (error instanceof MailboxError && error.retryable) {
      input.log(`result for ${taskId} was not stored; the same answer will be retried`);
      return false;
    }
    mark(input.stateFile, input.state, taskId, { phase: 'uncertain', answer, updatedAt: input.now().toISOString() });
    input.log(`result for ${taskId} was rejected`);
    return false;
  }
  mark(input.stateFile, input.state, taskId, { phase: 'published', answer, updatedAt: input.now().toISOString() });
  return true;
}
