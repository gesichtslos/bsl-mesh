import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { capabilitiesRoutes } from '../src/http/capabilities.js';
import { starterRoutes } from '../src/http/starter.js';
import { toolReleaseRoutes } from '../src/http/tools.js';
import type { EnvironmentService } from '../src/environment/service.js';
import { verifyRemoteRelease } from '../src/tools/client.js';
import {
  LINUX_PACKAGE,
  PUBLIC_KEY_FILE,
  WINDOWS_PACKAGE,
  createSignedRelease,
  loadToolRelease,
  publicPemFromPrivate,
  unzipStore,
  zipAdapterSource,
} from '../src/tools/release.js';

const apps: Array<{ close: () => Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) {
      await app.close();
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function keyPair(): { publicKey: string; privateKey: string } {
  const generated = generateKeyPairSync('ed25519');
  const publicKey = generated.publicKey.export({ format: 'pem', type: 'spki' });
  const privateKey = generated.privateKey.export({ format: 'pem', type: 'pkcs8' });
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') {
    throw new Error('key export failed');
  }
  return { publicKey, privateKey };
}

async function sourceDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bslmesh-adapter-src-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'main.js'), 'export const marker = "adapter";\n');
  await writeFile(path.join(directory, 'policy.js'), 'export const mode = "ask";\n');
  return directory;
}

async function publish(source: string, keys: { publicKey: string; privateKey: string }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bslmesh-adapter-release-'));
  directories.push(directory);
  const release = await createSignedRelease({ sourceDir: source, publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey });
  await writeFile(path.join(directory, 'cursor-adapter.json'), `${JSON.stringify(release.manifest, null, 2)}\n`);
  await writeFile(path.join(directory, PUBLIC_KEY_FILE), keys.publicKey);
  await writeFile(path.join(directory, LINUX_PACKAGE), release.linux);
  await writeFile(path.join(directory, WINDOWS_PACKAGE), release.windows);
  return directory;
}

describe('cursor adapter release', () => {
  test('builds the same archive twice and keeps credentials out of it', async () => {
    const source = await sourceDir();
    const first = await zipAdapterSource(source, 'linux');
    const second = await zipAdapterSource(source, 'linux');
    expect(Buffer.compare(first, second)).toBe(0);
    const files = unzipStore(first);
    const text = [...files.values()].map((item) => item.toString('utf8')).join('\n');
    expect(text).not.toContain('bslm_');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('settings.json');
    expect(text).toContain('CURSOR_ADAPTER_CONSENT=reply-only');
    expect(text).toContain('настройки Cursor');
  });

  test('a newcomer discovers, downloads, and verifies the release without running it', async () => {
    const keys = keyPair();
    const directory = await publish(await sourceDir(), keys);
    const app = Fastify();
    apps.push(app);
    await app.register(capabilitiesRoutes, { handoffEnabled: false });
    await app.register(starterRoutes, {
      service: { async catalog() { return { profiles: [] }; } } as unknown as EnvironmentService,
    });
    await app.register(toolReleaseRoutes, { directory, guard: async () => undefined });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const start = await fetch(`${address}/start`);
    const capabilities = await fetch(`${address}/api/v1/capabilities`);
    const quickstart = await fetch(`${address}/agent/quickstart.md`);
    const signatures = await fetch(`${address}/agent/catalog-signatures.json`);
    expect(start.status).toBe(200);
    expect(await start.text()).toContain('/agent/tools/cursor-adapter.json');
    expect(await capabilities.json()).toMatchObject({
      tools: [{ id: 'cursor-adapter', manifest: '/agent/tools/cursor-adapter.json' }],
    });
    const instructions = await quickstart.text();
    expect(instructions).toContain('releases/cursor-adapter/bslmesh-tool-release.ed25519.pub');
    expect(instructions).toContain('не запускать');
    expect(instructions).not.toContain('bslm_');
    expect(await signatures.json()).toMatchObject({
      signed: false,
      tool_releases: [{ id: 'cursor-adapter', manifest: '/agent/tools/cursor-adapter.json' }],
    });
    const anonymous = await fetch(`${address}/agent/tools/cursor-adapter-linux.zip`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('content-type')).toContain('application/zip');
    const prepare = await mkdtemp(path.join(tmpdir(), 'bslmesh-adapter-home-'));
    directories.push(prepare);
    const checked = await verifyRemoteRelease({
      baseUrl: address,
      pinnedPublicKey: keys.publicKey,
      osName: 'linux',
      prepareDirectory: prepare,
      preflight: true,
    });
    expect(checked.authentic).toBe(true);
    expect(checked.executed_adapter).toBe(false);
    expect(checked.preflight.node).toBe('present');
    expect(['logged-in', 'not-logged-in', 'missing', 'unknown']).toContain(checked.preflight.cursor_cli);
    expect(await readFile(path.join(prepare, 'main.js'), 'utf8')).toContain('adapter');
    expect(await readFile(path.join(prepare, 'NEXT.txt'), 'utf8')).toContain('Do not run node main.js');
    const loaded = await loadToolRelease(directory);
    expect(loaded.manifest.install.auto_run).toBe(false);
    expect(loaded.manifest.install.changes_cursor_settings).toBe(false);
  }, 30_000);

  test('rejects a signature made by a key other than the pinned one', async () => {
    const pinned = keyPair();
    const attacker = keyPair();
    const directory = await publish(await sourceDir(), attacker);
    const app = Fastify();
    apps.push(app);
    await app.register(toolReleaseRoutes, { directory, guard: async () => undefined });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(verifyRemoteRelease({
      baseUrl: address,
      pinnedPublicKey: pinned.publicKey,
      osName: 'windows',
    })).rejects.toThrow('pinned trust anchor');
    expect(publicPemFromPrivate(attacker.privateKey)).toBe(attacker.publicKey);
  });

  test('does not serve a package whose bytes no longer match the manifest', async () => {
    const keys = keyPair();
    const directory = await publish(await sourceDir(), keys);
    const zip = await readFile(path.join(directory, LINUX_PACKAGE));
    const index = zip.length - 1;
    const last = zip[index];
    if (last === undefined) {
      throw new Error('empty package');
    }
    zip[index] = last ^ 0x01;
    await writeFile(path.join(directory, LINUX_PACKAGE), zip);
    const app = Fastify();
    apps.push(app);
    await app.register(toolReleaseRoutes, { directory, guard: async () => undefined });
    const response = await app.inject({ method: 'GET', url: '/agent/tools/cursor-adapter-linux.zip' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ detail: 'The tool release bytes do not match the manifest.' });
  });

  test('registers the public route on the application', async () => {
    const app = await buildApp(loadConfig({
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_URL: 'postgres://bslmesh_dev:super-secret-db-pass@127.0.0.1:1/bslmesh_dev',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      TOOL_RELEASE_DIR: await mkdtemp(path.join(tmpdir(), 'bslmesh-missing-release-')),
    }));
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/agent/tools/cursor-adapter.json' });
    expect(response.statusCode).not.toBe(404);
    expect(JSON.stringify(response.json())).not.toContain('No route matches');
  });

  test('refuses a release directory that escapes its root', () => {
    expect(() => loadConfig({
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_URL: 'postgres://bslmesh_dev:super-secret-db-pass@127.0.0.1:1/bslmesh_dev',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      TOOL_RELEASE_DIR: '../outside',
    })).toThrow('TOOL_RELEASE_DIR');
  });
});
