const base = process.env['HANDOFF_BASE'];
const token = process.env['HANDOFF_TOKEN'];
const command = process.argv[2];
const extension = 'https://bslmesh.ru/a2a/extensions/handoff/v1';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

async function request(path, options = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = required('HANDOFF_MESSAGE_ID');
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
  const text = await response.text();
  const body = text === '' ? {} : JSON.parse(text);
  return { status: response.status, body };
}

if (base === undefined || token === undefined || command === undefined) {
  throw new Error('HANDOFF_BASE, HANDOFF_TOKEN, and a command are required.');
}

if (command === 'send') {
  const sent = await request('/api/v1/handoff/messages', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        messageId: required('HANDOFF_MESSAGE_ID'),
        role: 'ROLE_USER',
        parts: [{ text: required('HANDOFF_TEXT') }],
      },
      configuration: { returnImmediately: true },
      metadata: { [extension]: { recipientAgentId: required('HANDOFF_RECIPIENT') } },
    }),
  });
  process.stdout.write(JSON.stringify({ status: sent.status, id: sent.body.id, state: sent.body.status?.state }));
  process.exit(sent.status === 201 ? 0 : 1);
}

if (command === 'reply') {
  const taskId = required('HANDOFF_TASK_ID');
  const current = await request(`/api/v1/handoff/tasks/${taskId}`);
  if (current.status !== 200 || current.body.status?.state !== 'TASK_STATE_SUBMITTED') {
    process.stdout.write(JSON.stringify({ status: current.status, state: current.body.status?.state }));
    process.exit(1);
  }
  const replied = await request('/api/v1/handoff/messages', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        messageId: required('HANDOFF_MESSAGE_ID'),
        taskId,
        role: 'ROLE_AGENT',
        parts: [{ text: required('HANDOFF_TEXT') }],
      },
      configuration: { returnImmediately: true },
      metadata: { [extension]: { state: 'TASK_STATE_COMPLETED', humanParticipated: false } },
    }),
  });
  const artifact = replied.body.artifacts?.[0]?.parts?.[0]?.text;
  process.stdout.write(JSON.stringify({ status: replied.status, state: replied.body.status?.state, artifact }));
  process.exit(replied.status === 200 && replied.body.status?.state === 'TASK_STATE_COMPLETED' ? 0 : 1);
}

if (command === 'read') {
  const current = await request(`/api/v1/handoff/tasks/${required('HANDOFF_TASK_ID')}`);
  const artifact = current.body.artifacts?.[0]?.parts?.[0]?.text;
  process.stdout.write(JSON.stringify({
    status: current.status,
    state: current.body.status?.state,
    artifact,
    receivedAt: current.body.metadata?.[extension]?.receivedAt ?? null,
  }));
  process.exit(current.status === 200 ? 0 : 1);
}

throw new Error('Unknown command.');
