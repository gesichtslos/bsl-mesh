import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { decryptBuffer } from '../scripts/lib/backup-crypto.mjs';
import {
  assertRestoreTarget,
  createBackup,
  redact,
  requireConfig,
  restoreBackup,
  selfTest,
} from '../scripts/production-backup.mjs';

const PASSPHRASE = 'ci-disposable-passphrase';
const MARKER = 'synthetic-backup-marker';

test('self-test encrypts with authenticated encryption and rejects tampering', async () => {
  await selfTest();
});

test('refuses an incomplete backup configuration', () => {
  expect(() => requireConfig({})).toThrow(/BACKUP_S3_ENDPOINT/);
  try {
    requireConfig({});
  } catch (error) {
    expect(error.exitCode).toBe(2);
    expect(error.message).not.toContain(PASSPHRASE);
  }
});

test('uploads ciphertext and removes the temporary file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  let stored;
  try {
    const result = await createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      objectKey: 'bslmesh/bslmesh_dev-20261022T000000Z-abcdef12.bsm1',
      spawnDump: () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(MARKER)})`]),
      putObject: async (upload) => {
        stored = upload;
      },
    });
    expect(result.bytes).toBeGreaterThan(MARKER.length);
    expect(stored.body.includes(Buffer.from(MARKER))).toBe(false);
    expect(stored.payloadHash).toBe(createHash('sha256').update(stored.body).digest('hex'));
    expect((await decryptBuffer(stored.body, PASSPHRASE)).toString('utf8')).toBe(MARKER);
    await expect(decryptBuffer(stored.body, 'wrong-passphrase-value')).rejects.toThrow('Backup decryption failed.');
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed database dump is not uploaded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  let uploaded = false;
  try {
    await expect(createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      spawnDump: () => spawn(process.execPath, ['-e', 'process.exit(1)']),
      putObject: async () => {
        uploaded = true;
      },
    })).rejects.toThrow('Database dump failed.');
    expect(uploaded).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed upload removes the temporary ciphertext and reports failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  try {
    await expect(createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      spawnDump: () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(MARKER)})`]),
      putObject: async (upload) => {
        expect(upload.body.includes(Buffer.from(MARKER))).toBe(false);
        throw new Error(`S3 request failed (500). ${PASSPHRASE}`);
      },
    })).rejects.toThrow('S3 request failed (500).');
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to restore into the running database before downloading', async () => {
  const calls = [];
  await expect(restoreBackup({
    env: {},
    target: 'bslmesh_dev',
    key: 'bslmesh/bslmesh_dev-20261022T000000Z-abcdef12.bsm1',
    passphrase: PASSPHRASE,
    getObject: async () => {
      calls.push('get');
      return { body: Buffer.alloc(0), metadata: '' };
    },
    databaseExists: async () => false,
    createDatabase: async () => undefined,
    dropDatabase: async () => undefined,
    restorePlain: async () => undefined,
    serviceName: async () => 'bsl-mesh',
  })).rejects.toThrow('Refusing to restore into bslmesh_dev');
  expect(calls).toEqual([]);
  expect(() => assertRestoreTarget('template0', { CONFIRM_RESTORE_APP_DATABASE: 'yes' })).toThrow('template0');
});

test('redacts configured secrets from failure text', () => {
  const secret = 'ci-disposable-secret';
  expect(redact(`failed ${secret} ${PASSPHRASE}`, {
    BACKUP_S3_SECRET_ACCESS_KEY: secret,
    BACKUP_PASSPHRASE: PASSPHRASE,
  })).toBe('failed [redacted] [redacted]');
});
