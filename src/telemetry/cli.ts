import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LocalTelemetry, type Verification } from './store.js';
import type { FormKind, Outcome, SourceKind } from './types.js';

const FORMS = new Set(['ordinary', 'managed', 'unknown']);
const OUTCOME_SET = new Set(['success_verified', 'success_unverified', 'partial', 'failed', 'abandoned', 'unknown']);

function home(env: NodeJS.ProcessEnv): string {
  if (env['BSLMESH_TELEMETRY_HOME'] !== undefined && env['BSLMESH_TELEMETRY_HOME'] !== '') {
    return env['BSLMESH_TELEMETRY_HOME'];
  }
  const root = env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== ''
    ? env['XDG_DATA_HOME']
    : path.join(env['HOME'] ?? '.', '.local', 'share');
  return path.join(root, 'bsl-mesh', 'telemetry');
}

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function flags(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) {
      values.push(argv[index + 1] ?? '');
    }
  }
  return values;
}

function versionOf(command: string): string | null {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 1500 });
  const line = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').map((item) => item.trim()).find((item) => item !== '');
  return line !== undefined && /^[0-9][A-Za-z0-9._+-]{0,40}$/.test(line) ? line : null;
}

export async function runTelemetryCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
  stdout: (line: string) => void,
): Promise<number> {
  const collector = new LocalTelemetry(home(env), () => new Date(), env['BSLMESH_TELEMETRY_ROOT'] ?? process.cwd());
  const command = argv[0] ?? 'status';
  try {
    if (command === 'hook') {
      const started = Date.now();
      const parsed = stdin.trim() === '' ? {} : JSON.parse(stdin) as unknown;
      collector.ingest(parsed, Date.now() - started);
      stdout('{}\n');
      return 0;
    }
    if (command === 'status') {
      stdout(`${JSON.stringify(collector.status())}\n`);
      return 0;
    }
    if (command === 'enable-local') {
      stdout(`${JSON.stringify(collector.enable())}\n`);
      return 0;
    }
    if (command === 'disable') {
      stdout(`${JSON.stringify(collector.disable())}\n`);
      return 0;
    }
    if (command === 'list') {
      stdout(`${JSON.stringify(collector.list())}\n`);
      return 0;
    }
    if (command === 'task-start') {
      const family = flag(argv, '--family');
      const form = flag(argv, '--form') ?? 'unknown';
      if (family === null || !FORMS.has(form)) {
        throw new Error('task-start requires --family and an optional --form.');
      }
      const task = collector.startTask({
        family,
        form: form as FormKind,
        sourceKind: argv.includes('--organic') ? 'organic' as SourceKind : 'synthetic',
        configurationFamily: flag(argv, '--configuration-family'),
        mcpIds: flags(argv, '--mcp-id'),
        cursorVersion: versionOf('cursor'),
        cliVersion: versionOf('cursor-agent'),
      });
      stdout(`${JSON.stringify({ id: task.id, report_id: task.report_id })}\n`);
      return 0;
    }
    if (command === 'task-attempt') {
      const task = flag(argv, '--task');
      if (task === null) {
        throw new Error('task-attempt requires --task.');
      }
      stdout(`${JSON.stringify(collector.startAttempt(task))}\n`);
      return 0;
    }
    if (command === 'task-finish') {
      const task = flag(argv, '--task');
      const outcome = flag(argv, '--outcome') ?? 'unknown';
      if (task === null || !OUTCOME_SET.has(outcome)) {
        throw new Error('task-finish requires --task and a known --outcome.');
      }
      const method = flag(argv, '--method');
      const origin = flag(argv, '--origin');
      const exitCode = flag(argv, '--exit-code');
      const verification: Verification | null = method === null ? null : {
        method,
        origin: origin === 'instrumented' || origin === 'owner_reported' || origin === 'agent_reported'
          || origin === 'provider_reported' || origin === 'derived' || origin === 'unknown'
          ? origin
          : 'owner_reported',
        observed_exit_code: exitCode === null ? null : Number(exitCode),
      };
      stdout(`${JSON.stringify(collector.finishTask(task, outcome as Outcome, verification))}\n`);
      return 0;
    }
    if (command === 'preview' || command === 'export') {
      const task = flag(argv, '--task');
      if (task === null) {
        throw new Error(`${command} requires --task.`);
      }
      const report = collector.preview(task);
      if (command === 'export') {
        const out = flag(argv, '--out');
        if (out === null) {
          throw new Error('export requires --out.');
        }
        writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      }
      stdout(`${JSON.stringify(report)}\n`);
      return 0;
    }
    if (command === 'submit') {
      const task = flag(argv, '--task');
      const server = flag(argv, '--server');
      const token = env['BSLMESH_TELEMETRY_TOKEN'];
      if (task === null || server === null || token === undefined || token === '') {
        throw new Error('submit requires --task, --server, and BSLMESH_TELEMETRY_TOKEN.');
      }
      const report = collector.preview(task);
      const response = await fetch(new URL('/api/v1/telemetry/reports', server), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': String(report['report_id']),
        },
        body: JSON.stringify(report),
      });
      stdout(`${await response.text()}\n`);
      return response.ok ? 0 : 1;
    }
    if (command === 'import-sdk') {
      const task = flag(argv, '--task');
      const file = flag(argv, '--file');
      if (task === null || file === null) {
        throw new Error('import-sdk requires --task and --file.');
      }
      stdout(`${JSON.stringify(collector.importSdk(task, JSON.parse(readFileSync(file, 'utf8')) as unknown))}\n`);
      return 0;
    }
    if (command === 'delete-local') {
      if (!argv.includes('--confirm')) {
        throw new Error('delete-local requires --confirm.');
      }
      stdout(`${JSON.stringify(collector.deleteLocal())}\n`);
      return 0;
    }
    throw new Error('Unknown telemetry command.');
  } catch (error) {
    if (command === 'hook') {
      stdout('{}\n');
      return 0;
    }
    stdout(`${error instanceof Error ? error.message : 'Telemetry command failed.'}\n`);
    return 1;
  }
}
