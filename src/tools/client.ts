import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  LINUX_PATH,
  MANIFEST_PATH,
  TOOL_PUBLIC_KEY_PATH,
  WINDOWS_PATH,
  assertPackagePolicy,
  fingerprintPublicKey,
  manifestBody,
  packageBytes,
  parseManifest,
  unzipStore,
  verifyManifest,
  type SignedToolManifest,
} from './release.js';

export type PreflightState = 'present' | 'missing' | 'logged-in' | 'not-logged-in' | 'unknown';

export type RemoteReleaseCheck = {
  authentic: boolean;
  executed_adapter: false;
  os: 'linux' | 'windows';
  directory: string | null;
  preflight: { node: PreflightState; cursor_cli: PreflightState };
  manifest: SignedToolManifest;
};

export async function verifyRemoteRelease(input: {
  baseUrl: string;
  pinnedPublicKey: string;
  osName: 'linux' | 'windows';
  prepareDirectory?: string;
  preflight?: boolean;
}): Promise<RemoteReleaseCheck> {
  const manifestUrl = new URL(MANIFEST_PATH, input.baseUrl);
  assertPublicOrigin(manifestUrl);
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`Manifest download failed with ${manifestResponse.status}.`);
  }
  const manifest = parseManifest(await manifestResponse.text());
  const body = manifestBody(manifest);
  assertPackagePolicy(manifest);
  if (body.public_key_path !== TOOL_PUBLIC_KEY_PATH || body.key_fingerprint !== fingerprintPublicKey(input.pinnedPublicKey)) {
    throw new Error('The release key does not match the pinned trust anchor.');
  }
  if (!verifyManifest(body, manifest.signature, input.pinnedPublicKey)) {
    throw new Error('The release signature does not match the pinned trust anchor.');
  }
  const selected = body.packages.find((item) => item.os === input.osName);
  if (selected === undefined || (selected.path !== LINUX_PATH && selected.path !== WINDOWS_PATH)) {
    throw new Error('The release does not name the expected package.');
  }
  const packageUrl = new URL(selected.path, manifestUrl);
  assertSameOrigin(manifestUrl, packageUrl);
  const packageResponse = await fetch(packageUrl);
  if (!packageResponse.ok) {
    throw new Error(`Package download failed with ${packageResponse.status}.`);
  }
  const bytes = Buffer.from(await packageResponse.arrayBuffer());
  packageBytes(manifest, input.osName, bytes);
  const files = unzipStore(bytes);
  const readme = files.get('README.md')?.toString('utf8') ?? '';
  if (!readme.includes('CURSOR_ADAPTER_CONSENT=reply-only') || readme.includes('bslm_') || readme.includes('PRIVATE KEY')) {
    throw new Error('The package text is not the published adapter readme.');
  }
  let directory: string | null = null;
  if (input.prepareDirectory !== undefined) {
    directory = path.resolve(input.prepareDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [name, data] of files) {
      await writeFile(path.join(directory, name), data, { mode: 0o644 });
    }
    await writeFile(path.join(directory, 'NEXT.txt'), 'Do not run node main.js until the owner sets CURSOR_ADAPTER_CONSENT=reply-only.\n', { mode: 0o644 });
  }
  return {
    authentic: true,
    executed_adapter: false,
    os: input.osName,
    directory,
    preflight: input.preflight === true ? inspectLocalTools() : { node: nodeState(), cursor_cli: 'unknown' },
    manifest,
  };
}

function inspectLocalTools(): { node: PreflightState; cursor_cli: PreflightState } {
  return { node: nodeState(), cursor_cli: cursorCliState() };
}

function nodeState(): PreflightState {
  return process.version.startsWith('v24.') ? 'present' : 'missing';
}

function cursorCliState(): PreflightState {
  const result = spawnSync('agent', ['status'], { encoding: 'utf8', timeout: 15_000 });
  if (result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT') {
    return 'missing';
  }
  if (result.error !== undefined) {
    return 'unknown';
  }
  const text = `${result.stdout}\n${result.stderr}`;
  if (/not logged in/i.test(text)) {
    return 'not-logged-in';
  }
  if (/logged in/i.test(text)) {
    return 'logged-in';
  }
  return 'unknown';
}

function assertPublicOrigin(url: URL): void {
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return;
  }
  throw new Error('The release URL must use HTTPS.');
}

function assertSameOrigin(manifest: URL, packageUrl: URL): void {
  if (packageUrl.origin !== manifest.origin) {
    throw new Error('The package URL does not match the manifest origin.');
  }
  assertPublicOrigin(packageUrl);
}
