import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

export type TaskPhase = 'claimed' | 'session-open' | 'answered' | 'published' | 'uncertain';

export type TaskRecord = {
  phase: TaskPhase;
  sessionId: string | null;
  answer: string | null;
  updatedAt: string;
};

export type AdapterState = {
  adapterId: string;
  tasks: Record<string, TaskRecord>;
};

export function loadState(file: string, adapterId: string): AdapterState {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as AdapterState;
    if (parsed.adapterId !== adapterId || parsed.tasks === undefined) {
      throw new Error('state mismatch');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { adapterId, tasks: {} };
    }
    if (error instanceof Error && error.message === 'state mismatch') {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new Error('The adapter state file is unreadable.');
    }
    throw error;
  }
}

export function saveState(file: string, state: AdapterState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
        throw new Error('Another adapter instance holds the lock.');
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

export function statePaths(directory: string): { stateFile: string; lockFile: string } {
  statSync(directory);
  return {
    stateFile: path.join(directory, 'state.json'),
    lockFile: path.join(directory, 'adapter.lock'),
  };
}
