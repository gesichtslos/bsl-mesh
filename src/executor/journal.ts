import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type TaskPhase = 'claimed' | 'answered' | 'published' | 'uncertain';

export type TaskRecord = {
  phase: TaskPhase;
  answer: string | null;
  updatedAt: string;
};

export type OutgoingPhase = 'seen' | 'running' | 'processed' | 'uncertain';

export type OutgoingRecord = {
  phase: OutgoingPhase;
  state: string;
  handledEvent: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  updatedAt: string;
};

export type ExecutorState = {
  executorId: string;
  tasks: Record<string, TaskRecord>;
  outgoing?: Record<string, OutgoingRecord>;
};

export function loadState(file: string, executorId: string): ExecutorState {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ExecutorState;
    if (parsed.executorId !== executorId || parsed.tasks === undefined || parsed.tasks === null || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)) {
      throw new Error('state mismatch');
    }
    if (parsed.outgoing !== undefined && (parsed.outgoing === null || typeof parsed.outgoing !== 'object' || Array.isArray(parsed.outgoing))) {
      throw new Error('state mismatch');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { executorId, tasks: {} };
    }
    if (error instanceof Error && error.message === 'state mismatch') {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new Error('The executor state file is unreadable.');
    }
    throw error;
  }
}

export function saveState(file: string, state: ExecutorState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function mark(file: string, state: ExecutorState, taskId: string, record: TaskRecord): void {
  state.tasks[taskId] = record;
  saveState(file, state);
}

export function outgoingMap(state: ExecutorState): Record<string, OutgoingRecord> {
  state.outgoing ??= {};
  return state.outgoing;
}

export function markOutgoing(file: string, state: ExecutorState, taskId: string, record: OutgoingRecord): void {
  outgoingMap(state)[taskId] = record;
  saveState(file, state);
}

export function acquireLock(lockFile: string): () => void {
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const owner = readFileSync(lockFile, 'utf8').trim();
      const pid = Number(owner);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new Error('Another executor holds the lock.');
      }
      unlinkSync(lockFile);
      fd = openSync(lockFile, 'wx', 0o600);
    } else {
      throw error;
    }
  }
  writeFileSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    try {
      unlinkSync(lockFile);
    } catch {
      // The lock is already gone.
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
