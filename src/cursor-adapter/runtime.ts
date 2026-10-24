import { execFile } from 'node:child_process';

export class CursorRunError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'CursorRunError';
  }
}

export type CursorAnswer = {
  text: string;
  modelCalls: number | null;
  usageNote: string | null;
};

export type CursorRuntime = {
  createChat(workspace: string): Promise<string>;
  answer(workspace: string, sessionId: string, prompt: string): Promise<CursorAnswer>;
};

export function cliRuntime(bin: string, timeoutMs: number): CursorRuntime {
  return {
    async createChat(workspace) {
      const output = await run(bin, ['create-chat'], workspace, timeoutMs);
      const sessionId = output.stdout.trim().split('\n').at(-1)?.trim() ?? '';
      if (sessionId === '' || sessionId.includes(' ')) {
        throw new CursorRunError('Cursor did not return a session id.', true);
      }
      return sessionId;
    },
    async answer(workspace, sessionId, prompt) {
      const output = await run(bin, [
        '--print',
        '--mode',
        'ask',
        '--sandbox',
        'enabled',
        '--output-format',
        'json',
        '--workspace',
        workspace,
        '--resume',
        sessionId,
        prompt,
      ], workspace, timeoutMs);
      return readAnswer(output.stdout);
    },
  };
}

function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      const out = String(stdout);
      const err = String(stderr);
      if (error !== null) {
        const timedOut = 'killed' in error && error.killed === true;
        const fatal = /not logged in|authentication|api key|unauthorized|401/i.test(`${err}\n${out}\n${error.message}`);
        const message = timedOut
          ? 'Cursor timed out.'
          : fatal
            ? 'Cursor authentication failed.'
            : 'Cursor runtime failed.';
        reject(new CursorRunError(message, fatal));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

export function readAnswer(stdout: string): CursorAnswer {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text = firstText(parsed);
      return {
        text,
        modelCalls: numberField(parsed, ['modelCalls', 'model_calls']),
        usageNote: usageNote(parsed),
      };
    } catch {
      return { text: trimmed, modelCalls: null, usageNote: null };
    }
  }
  return { text: trimmed, modelCalls: null, usageNote: null };
}

function firstText(value: Record<string, unknown>): string {
  for (const key of ['result', 'text', 'answer']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim() !== '') {
      return item.trim();
    }
  }
  return '';
}

function numberField(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) {
      return item;
    }
  }
  return null;
}

function usageNote(value: Record<string, unknown>): string | null {
  const usage = value['usage'];
  if (usage === undefined) {
    return null;
  }
  const encoded = JSON.stringify(usage);
  return encoded.length > 500 ? null : encoded;
}
