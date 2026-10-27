import { readFile } from 'node:fs/promises';

const { verifyRemoteRelease } = await import('../dist/tools/client.js');

const args = new Map();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  args.set(argv[index], argv[index + 1]);
}

function required(name) {
  const value = args.get(name);
  if (value === undefined || value === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const osName = args.get('--os') ?? 'linux';
if (osName !== 'linux' && osName !== 'windows') {
  throw new Error('--os must be linux or windows.');
}
const pinnedPublicKey = await readFile(required('--pin'), 'utf8');
const checked = await verifyRemoteRelease({
  baseUrl: required('--base'),
  pinnedPublicKey,
  osName,
  ...(args.get('--prepare') === undefined ? {} : { prepareDirectory: args.get('--prepare'), preflight: true }),
});
process.stdout.write(`authentic=${checked.authentic} executed_adapter=${checked.executed_adapter} node=${checked.preflight.node} cursor_cli=${checked.preflight.cursor_cli}\n`);
if (checked.executed_adapter !== false) {
  process.exitCode = 1;
}
