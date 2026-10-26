import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = (process.env.BSL_MESH_BASE_URL ?? 'http://127.0.0.1:3017').replace(/\/$/, '');
const hostname = new URL(base).hostname;
if (hostname === 'bslmesh.ru' || hostname.endsWith('.bslmesh.ru')) {
  process.stderr.write('Refusing to create credentials on bslmesh.ru from this script.\n');
  process.exit(2);
}
const directory = process.env.HANDOFF_CREDENTIAL_DIR
  ?? path.join(os.homedir(), '.local', 'state', 'bsl-mesh-handoff-credentials');

async function json(urlPath, options = {}) {
  const response = await fetch(`${base}${urlPath}`, options);
  const body = await response.json();
  if (response.status >= 400) {
    throw new Error(`${options.method ?? 'GET'} ${urlPath} failed with ${response.status}`);
  }
  return body;
}

async function owner(email) {
  const issued = await json('/api/v1/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, display_name: 'Handoff Owner' }),
  });
  const consumed = await json('/api/v1/auth/magic-link/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: issued.magic_link_token }),
  });
  return consumed.session_token;
}

async function agent(session, name) {
  const key = `prep-${name}-${randomBytes(4).toString('hex')}`;
  const created = await json('/api/v1/owners/me/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', 'idempotency-key': `${key}-agent` },
    body: JSON.stringify({ display_name: name }),
  });
  const credential = await json('/api/v1/owners/me/credentials', {
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', 'idempotency-key': `${key}-credential` },
    body: JSON.stringify({ agent_id: created.id, scopes: ['handoff:read', 'handoff:write'], ttl_seconds: 86400 }),
  });
  return { agentId: created.id, token: credential.token, scopes: ['handoff:read', 'handoff:write'] };
}

const linux = await agent(await owner('handoff-linux@example.test'), 'linux-cursor');
const windows = await agent(await owner('handoff-windows@example.test'), 'windows-cursor');
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
for (const [name, value] of [['linux-agent.json', linux], ['windows-agent.json', windows]]) {
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify({ agentId: value.agentId, scopes: value.scopes, token: value.token })}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
process.stdout.write(`directory ${directory}\nlinux-agent ${linux.agentId}\nwindows-agent ${windows.agentId}\n`);
