import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'dist', 'cursor-adapter');
const out = path.join(root, 'build', 'bsl-mesh-cursor-adapter');

const readme = `# BSL Mesh Cursor Adapter

This folder is the adapter only. It does not include the BSL Mesh source tree or database.

Requirements: Node.js 24.22.0 and the Cursor CLI command \`agent\`.

On another computer, \`127.0.0.1\` is that computer, not the BSL Mesh server. Set \`BSL_MESH_BASE_URL\` to the host name the owner gives you.

Before the first claim, \`agent status\` must show a login, and this command must print \`pong\` with exit code 0:

\`\`\`
agent --print --mode ask --sandbox enabled --output-format text --workspace <allowlisted-directory> "Reply with exactly the word pong. Do not use tools."
\`\`\`

If the CLI asks for workspace trust, trust only that directory once. Do not use \`--force\` or \`--yolo\`. The adapter does not add those flags. If this check fails, do not start \`node main.js\`: waiting tasks must stay waiting.

Check the archive before use:

\`\`\`
node verify.mjs
\`\`\`

Then set \`BSL_MESH_CREDENTIAL\`, \`CURSOR_ADAPTER_CONSENT=reply-only\`, \`CURSOR_ADAPTER_STATE_DIR\`, \`CURSOR_ADAPTER_WORKSPACE\`, and \`CURSOR_ADAPTER_ALLOW_WORKSPACES\`, and run \`node main.js\`.
The value \`bslm_agt_example\` is not a working credential.
`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const files = (await readdir(source)).filter((name) => name.endsWith('.js'));
for (const name of files) {
  await cp(path.join(source, name), path.join(out, name));
}
await writeFile(path.join(out, 'package.json'), `${JSON.stringify({ name: 'bsl-mesh-cursor-adapter', private: true, type: 'module' }, null, 2)}\n`);
await writeFile(path.join(out, 'README.md'), readme);
await writeFile(path.join(out, 'verify.mjs'), `import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const lines = (await readFile(new URL('./SHA256SUMS', import.meta.url), 'utf8')).trim().split('\\n');
let failed = 0;
for (const line of lines) {
  const [expected, name] = line.split(/\\s+/);
  const actual = createHash('sha256').update(await readFile(new URL('./' + name, import.meta.url))).digest('hex');
  if (actual !== expected) {
    process.stderr.write('mismatch ' + name + '\\n');
    failed += 1;
  }
}
if (failed > 0) process.exit(1);
process.stdout.write('checksums ok\\n');
`);
const packed = (await readdir(out)).filter((name) => name !== 'SHA256SUMS').sort();
const sums = [];
for (const name of packed) {
  const bytes = await readFile(path.join(out, name));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
const zip = path.join(root, 'build', 'bsl-mesh-cursor-adapter.zip');
await new Promise((resolve, reject) => {
  const child = spawn('zip', ['-r', '-q', zip, 'bsl-mesh-cursor-adapter'], { cwd: path.join(root, 'build') });
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error('zip failed')));
});
const zipBytes = await readFile(zip);
const zipHash = createHash('sha256').update(zipBytes).digest('hex');
await writeFile(path.join(root, 'build', 'bsl-mesh-cursor-adapter.zip.sha256'), `${zipHash}  bsl-mesh-cursor-adapter.zip\n`);
process.stdout.write(`package ${zip}\nsha256 ${zipHash}\n`);
