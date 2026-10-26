import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [command, ...rest] = process.argv.slice(2);
const args = new Map();
for (let index = 0; index < rest.length; index += 2) {
  args.set(rest[index], rest[index + 1]);
}

function required(name) {
  const value = args.get(name);
  if (value === undefined || value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const base = required('--base').replace(/\/$/, '');
if (new URL(base).hostname === '127.0.0.1' || new URL(base).hostname === 'localhost') {
  process.stderr.write('This base URL points at the local computer. Another machine cannot use it as the BSL Mesh server.\n');
}

const credential = JSON.parse(await readFile(required('--credential-file'), 'utf8'));
const token = credential.token;
if (typeof token !== 'string' || token === '') {
  throw new Error('The credential file has no token.');
}

async function json(urlPath, options = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (response.status >= 400) {
    throw new Error(`${urlPath} failed with ${response.status}`);
  }
  return body;
}

if (command === 'send') {
  const messageId = `pilot-${randomUUID().replaceAll('-', '')}`;
  const sent = await json('/api/v1/handoff/messages', {
    method: 'POST',
    headers: { 'idempotency-key': messageId },
    body: JSON.stringify({
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ text: required('--text') }],
      },
      configuration: { returnImmediately: true },
      metadata: {
        'https://bslmesh.ru/a2a/extensions/handoff/v1': { recipientAgentId: required('--recipient') },
      },
    }),
  });
  process.stdout.write(`task ${sent.id}\nstate ${sent.status?.state}\n`);
} else if (command === 'wait') {
  const taskId = required('--task');
  const deadline = Date.now() + Number(args.get('--timeout-ms') ?? '180000');
  let last = '';
  while (Date.now() < deadline) {
    const task = await json(`/api/v1/handoff/tasks/${taskId}`);
    last = task.status?.state ?? '';
    const artifact = task.artifacts?.[0]?.parts?.[0]?.text;
    if (last === 'TASK_STATE_COMPLETED' && typeof artifact === 'string') {
      process.stdout.write(`state ${last}\nartifact ${artifact}\n`);
      process.exit(0);
    }
    if (last === 'TASK_STATE_FAILED' || last === 'TASK_STATE_CANCELED' || last === 'TASK_STATE_REJECTED') {
      process.stdout.write(`state ${last}\n`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write(`state ${last || 'timeout'}\n`);
  process.exit(1);
} else {
  process.stderr.write('Use send or wait.\n');
  process.exit(2);
}
