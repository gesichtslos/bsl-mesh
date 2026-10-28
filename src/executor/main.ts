import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseCommand } from './command.js';
import { runCycle } from './cycle.js';
import { acquireLock, loadState } from './journal.js';
import { Mailbox, MailboxError } from './mailbox.js';
import { runWatchCycle } from './watch.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function executorId(directory: string): string {
  const file = path.join(directory, 'executor-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^executor-[a-f0-9]{16}$/.test(existing)) {
      return existing;
    }
  } catch {
    // A new executor id is created below.
  }
  const created = `executor-${randomBytes(8).toString('hex')}`;
  writeFileSync(file, `${created}\n`, { mode: 0o600 });
  return created;
}

function credential(file: string): string {
  const value = readFileSync(file, 'utf8').trim();
  if (!value.startsWith('bslm_agt_') || value.length < 40 || value.length > 200) {
    throw new Error('The credential file does not contain an agent credential.');
  }
  return value;
}

async function main(): Promise<void> {
  const stateDirectory = path.resolve(required('BSL_MESH_STATE_DIR'));
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lock = acquireLock(path.join(stateDirectory, 'executor.lock'));
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  try {
    const state = loadState(path.join(stateDirectory, 'state.json'), executorId(stateDirectory));
    const workspaceId = process.env['BSL_MESH_WORKSPACE_ID']?.trim() ?? '';
    const contextId = workspaceId === '' ? undefined : workspaceId;
    if (contextId !== undefined && !UUID.test(contextId)) {
      throw new Error('BSL_MESH_WORKSPACE_ID must be a UUID.');
    }
    const incoming = process.env['BSL_MESH_EXECUTOR_COMMAND']?.trim() ?? '';
    const watching = process.env['BSL_MESH_EXECUTOR_RESULT_COMMAND']?.trim() ?? '';
    if (incoming === '' && watching === '') {
      throw new Error('BSL_MESH_EXECUTOR_COMMAND or BSL_MESH_EXECUTOR_RESULT_COMMAND is required.');
    }
    const argv = incoming === '' ? undefined : parseCommand(incoming);
    const resultArgv = watching === '' ? undefined : parseCommand(watching);
    const mailbox = new Mailbox(required('BSL_MESH_BASE_URL').replace(/\/$/, ''), credential(required('BSL_MESH_CREDENTIAL_FILE')));
    const interval = Math.max(200, Number(process.env['BSL_MESH_EXECUTOR_INTERVAL_MS'] ?? '5000'));
    const timeoutMs = Math.max(1000, Number(process.env['BSL_MESH_EXECUTOR_COMMAND_TIMEOUT_MS'] ?? '120000'));
    const once = process.env['BSL_MESH_EXECUTOR_ONCE'] === 'true';
    const stateFile = path.join(stateDirectory, 'state.json');
    const outboxFile = process.env['BSL_MESH_EXECUTOR_OUTBOX']?.trim() || path.join(stateDirectory, 'outbox.json');
    writeFileSync(path.join(stateDirectory, 'started-at'), `${new Date().toISOString()}\n`, { mode: 0o600 });
    do {
      if (stopped) {
        break;
      }
      try {
        const now = () => new Date();
        const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 120_000;
        if (argv !== undefined) {
          const result = await runCycle({
            mailbox,
            state,
            stateFile,
            argv,
            contextId,
            timeoutMs: timeout,
            now,
            log,
          });
          log(`cycle published=${result.published} uncertain=${result.uncertain} ran=${result.ran}`);
          if (result.stopped) {
            process.exitCode = 1;
            break;
          }
        }
        if (resultArgv !== undefined) {
          const watched = await runWatchCycle({
            mailbox,
            state,
            stateFile,
            outboxFile,
            argv: resultArgv,
            contextId,
            timeoutMs: timeout,
            now,
            log,
          });
          log(`results noticed=${watched.noticed} uncertain=${watched.uncertain} ran=${watched.ran}`);
          if (watched.stopped) {
            process.exitCode = 1;
            break;
          }
        }
      } catch (error) {
        if (error instanceof MailboxError && error.retryable) {
          log('mailbox unavailable; retrying');
        } else {
          throw error;
        }
      }
      if (once || stopped) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(interval) ? interval : 5000));
    } while (!stopped);
  } finally {
    lock();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'executor failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
