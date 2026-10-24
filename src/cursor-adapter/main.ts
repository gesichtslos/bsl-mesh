import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runCycle } from './cycle.js';
import { MeshClient, MeshError } from './mesh.js';
import { assertConsent, assertWorkspace, splitAllowlist } from './policy.js';
import { CursorRunError, cliRuntime } from './runtime.js';
import { acquireLock, loadState, statePaths } from './store.js';

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function adapterId(directory: string): string {
  const file = path.join(directory, 'adapter-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^adapter-[a-f0-9]{16}$/.test(existing)) {
      return existing;
    }
  } catch {
    // A new adapter id is created below.
  }
  const created = `adapter-${randomBytes(8).toString('hex')}`;
  writeFileSync(file, `${created}\n`, { mode: 0o600 });
  return created;
}

async function main(): Promise<void> {
  assertConsent(process.env['CURSOR_ADAPTER_CONSENT']);
  const workspace = assertWorkspace(required('CURSOR_ADAPTER_WORKSPACE'), splitAllowlist(process.env['CURSOR_ADAPTER_ALLOW_WORKSPACES']));
  const stateDirectory = path.resolve(required('CURSOR_ADAPTER_STATE_DIR'));
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const paths = statePaths(stateDirectory);
  const release = acquireLock(paths.lockFile);
  const state = loadState(paths.stateFile, adapterId(stateDirectory));
  const mesh = new MeshClient(required('BSL_MESH_BASE_URL').replace(/\/$/, ''), required('BSL_MESH_CREDENTIAL'));
  const runtime = cliRuntime(process.env['CURSOR_ADAPTER_AGENT_BIN']?.trim() || 'agent', 120_000);
  const interval = Math.max(1000, Number(process.env['CURSOR_ADAPTER_INTERVAL_MS'] ?? '5000'));
  const maxParallel = Math.min(4, Math.max(1, Number(process.env['CURSOR_ADAPTER_MAX_PARALLEL'] ?? '1')));
  const once = process.env['CURSOR_ADAPTER_ONCE'] === 'true';
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
    do {
      if (stopped) {
        break;
      }
      try {
        const result = await runCycle({
          mesh,
          runtime,
          state,
          stateFile: paths.stateFile,
          workspace,
          maxParallel,
          log,
        });
        log(`cycle published=${result.published} uncertain=${result.uncertain}`);
        if (result.stopped) {
          process.exitCode = 1;
          break;
        }
      } catch (error) {
        if (error instanceof CursorRunError && error.fatal) {
          log(error.message);
          process.exitCode = 1;
          break;
        }
        if (error instanceof MeshError && error.retryable) {
          log(`mailbox unavailable (${error.status}); retrying`);
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
    release();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'adapter failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
