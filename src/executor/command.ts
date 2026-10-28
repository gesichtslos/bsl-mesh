import { spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export function parseCommand(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CommandError('BSL_MESH_EXECUTOR_COMMAND must be a JSON array of strings.');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) {
    throw new CommandError('BSL_MESH_EXECUTOR_COMMAND must contain from 1 to 16 strings.');
  }
  const argv: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length < 1 || item.length > 200) {
      throw new CommandError('BSL_MESH_EXECUTOR_COMMAND must contain from 1 to 16 strings.');
    }
    argv.push(item);
  }
  return argv;
}

export function runCommand(input: {
  argv: readonly string[];
  stdin: string;
  timeoutMs: number;
}): Promise<string> {
  const [bin, ...args] = input.argv;
  if (bin === undefined) {
    return Promise.reject(new CommandError('The executor command is empty.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (error: Error | undefined, value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new CommandError('The executor command timed out.'), '');
    }, input.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 20_000) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', () => {
      // stderr is intentionally discarded so a command cannot echo a credential into the executor log.
    });
    child.on('error', (error) => {
      finish(new CommandError(error.message), '');
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new CommandError(`The executor command exited ${String(code)}.`), '');
        return;
      }
      const text = stdout.trim();
      if (text === '' || text.length > 8000) {
        finish(new CommandError('The executor command returned an empty or oversized result.'), '');
        return;
      }
      finish(undefined, text);
    });
    child.stdin.end(input.stdin);
  });
}
