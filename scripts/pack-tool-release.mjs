import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(root, 'releases', 'cursor-adapter');
const outputDir = path.join(root, 'build', 'tool-release');
const sourceDir = path.join(root, 'dist', 'cursor-adapter');

const { createSignedRelease, loadToolRelease, manifestBody, packageBytes, parseManifest, publicPemFromPrivate, verifyManifest, zipAdapterSource } = await import('../dist/tools/release.js');

if (process.argv.includes('--sign')) {
  const privateKeyPath = process.env.TOOL_RELEASE_PRIVATE_KEY_FILE ?? '';
  if (privateKeyPath === '') {
    throw new Error('TOOL_RELEASE_PRIVATE_KEY_FILE is required to sign.');
  }
  const privateKey = await readFile(privateKeyPath, 'utf8');
  const signed = await createSignedRelease({
    sourceDir,
    publicKeyPem: publicPemFromPrivate(privateKey),
    privateKeyPem: privateKey,
  });
  await mkdir(releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, 'cursor-adapter.json'), `${JSON.stringify(signed.manifest, null, 2)}\n`);
  await writeOutput(signed.manifest, signed.linux, signed.windows, publicPemFromPrivate(privateKey));
  process.stdout.write('signed cursor-adapter\n');
} else {
  const committed = parseManifest(await readFile(path.join(releaseDir, 'cursor-adapter.json'), 'utf8'));
  const publicKey = await readFile(path.join(releaseDir, 'bslmesh-tool-release.ed25519.pub'), 'utf8');
  const linux = await zipAdapterSource(sourceDir, 'linux');
  const windows = await zipAdapterSource(sourceDir, 'windows');
  if (!verifyManifest(manifestBody(committed), committed.signature, publicKey)) {
    throw new Error('The committed tool release signature does not match the pinned public key.');
  }
  packageBytes(committed, 'linux', linux);
  packageBytes(committed, 'windows', windows);
  await writeOutput(committed, linux, windows, publicKey);
  await loadToolRelease(outputDir);
  process.stdout.write('tool release matches the pinned signature\n');
}

async function writeOutput(manifest, linux, windows, key) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'cursor-adapter.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'cursor-adapter-linux.zip'), linux);
  await writeFile(path.join(outputDir, 'cursor-adapter-windows.zip'), windows);
  await copyFile(path.join(releaseDir, 'bslmesh-tool-release.ed25519.pub'), path.join(outputDir, 'bslmesh-tool-release.ed25519.pub'));
  if (!key.includes('BEGIN PUBLIC KEY')) {
    throw new Error('The tool release public key is missing.');
  }
}
