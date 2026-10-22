import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { expect, test } from 'vitest';

import { decryptBuffer, decryptFile, encryptPrepared, prepareEncryption } from '../scripts/lib/backup-crypto.mjs';
import { assertS3Config } from '../scripts/lib/s3-request.mjs';
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
        const info = await stat(upload.filePath);
        expect(info.mode & 0o777).toBe(0o600);
        stored = {
          body: await readFile(upload.filePath),
          payloadHash: upload.payloadHash,
        };
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
        const body = await readFile(upload.filePath);
        expect(body.includes(Buffer.from(MARKER))).toBe(false);
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

test('reads a backup sealed before streaming uploads', async () => {
  const legacy = Buffer.from('42534d3101806fa52a44c34d7203213daa29d18e73079826cdd363e85026ac764ea37f177ab44fc80ccd819476dacf96bed554ca48a99c2dee58a82174cbd72a41d7f430', 'hex');
  expect((await decryptBuffer(legacy, PASSPHRASE)).toString('utf8')).toBe('bslmesh-legacy-bsm1');
});

test('rejects a damaged header, ciphertext, or authentication tag', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  const encryptedPath = path.join(root, 'backup.bsm1');
  try {
    const prepared = await prepareEncryption(PASSPHRASE);
    const source = new PassThrough();
    const pending = encryptPrepared(source, encryptedPath, prepared);
    source.end(Buffer.alloc(64 * 1024, 5));
    await pending;
    const original = await readFile(encryptedPath);
    for (const offset of [0, 40, original.length - 1]) {
      const damaged = Buffer.from(original);
      damaged[offset] ^= 0x01;
      const damagedPath = path.join(root, `damaged-${offset}.bsm1`);
      const plainPath = path.join(root, `plain-${offset}.dump`);
      await writeFile(damagedPath, damaged, { mode: 0o600 });
      await expect(decryptFile(damagedPath, plainPath, PASSPHRASE)).rejects.toThrow('Backup decryption failed.');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses HTTP except for a loopback test server', () => {
  const config = {
    bucket: 'bslmesh-backup-ci',
    region: 'us-east-1',
    accessKeyId: 'ci-disposable-access',
    secretAccessKey: 'ci-disposable-secret',
  };
  expect(() => assertS3Config({ ...config, endpoint: 'http://203.0.113.10' })).toThrow('Remote S3 endpoints must use HTTPS.');
  expect(() => assertS3Config({ ...config, endpoint: 'http://s3.example.com' })).toThrow('Remote S3 endpoints must use HTTPS.');
  expect(() => assertS3Config({ ...config, endpoint: 'http://127.0.0.1:19090' })).not.toThrow();
  expect(() => assertS3Config({ ...config, endpoint: 'http://[::1]:19090' })).not.toThrow();
  expect(() => assertS3Config({ ...config, endpoint: 'https://s3.example.com' })).not.toThrow();
});

test('an interrupted upload or broken dump stream does not report success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  try {
    let uploaded = false;
    await expect(createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      spawnDump: () => patternProcess(1024 * 1024),
      putObject: async (upload) => {
        const stream = createReadStream(upload.filePath, { highWaterMark: 16 * 1024 });
        let received = 0;
        for await (const chunk of stream) {
          received += chunk.length;
          if (received > 64 * 1024) {
            stream.destroy();
            throw new Error('S3 request failed (500).');
          }
        }
        uploaded = true;
      },
    })).rejects.toThrow('S3 request failed (500).');
    expect(uploaded).toBe(false);

    await expect(createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      spawnDump: () => spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1024 * 1024, 3)); process.exit(1);']),
      putObject: async () => {
        uploaded = true;
      },
    })).rejects.toThrow('Database dump failed.');

    await expect(createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      spawnDump: failingStream,
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

test('restores a streamed upload without holding the dump', async () => {
  const size = 8 * 1024 * 1024;
  const expected = patternHash(size);
  const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-test-'));
  const stored = path.join(root, 'object.bsm1');
  let metadata = '';
  try {
    await createBackup({
      tempRoot: root,
      passphrase: PASSPHRASE,
      objectKey: 'bslmesh/bslmesh_dev-20261022T000000Z-abcdef12.bsm1',
      spawnDump: () => patternProcess(size),
      putObject: async (upload) => {
        await pipeline(createReadStream(upload.filePath), createWriteStream(stored, { mode: 0o600 }));
        metadata = upload.payloadHash;
      },
    });
    let restoredHash = '';
    await restoreBackup({
      env: {},
      target: 'bslmesh_backup_check',
      key: 'bslmesh/bslmesh_dev-20261022T000000Z-abcdef12.bsm1',
      passphrase: PASSPHRASE,
      tempRoot: root,
      getObject: async ({ filePath }) => {
        await pipeline(createReadStream(stored), createWriteStream(filePath, { mode: 0o600 }));
        return { sha256: metadata, metadata, bytes: (await stat(stored)).size };
      },
      databaseExists: async () => false,
      createDatabase: async () => undefined,
      dropDatabase: async () => undefined,
      restorePlain: async (plainPath) => {
        restoredHash = await hashFile(plainPath);
      },
      serviceName: async () => 'bsl-mesh',
    });
    expect(restoredHash).toBe(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps memory bounded while encrypting a large dump', async () => {
  const measured = await measureInFreshProcess();
  expect(measured.largestChunk).toBeLessThan(1024 * 1024);
  expect(measured.largeGrowth - measured.smallGrowth).toBeLessThan(20 * 1024 * 1024);
  expect(measured.largePeak).toBeLessThan(80 * 1024 * 1024);
  process.stdout.write(`backup-memory smallGrowth=${measured.smallGrowth} largeGrowth=${measured.largeGrowth} largePeak=${measured.largePeak}\n`);
}, 30000);

function measureInFreshProcess() {
  const backupModule = path.join(process.cwd(), 'scripts/lib/backup-crypto.mjs');
  const script = `
    import { spawn } from 'node:child_process';
    import { createReadStream } from 'node:fs';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { encryptPrepared, prepareEncryption } from ${JSON.stringify(backupModule)};
    const prepared = await prepareEncryption('ci-disposable-passphrase');
    const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-backup-memory-'));
    async function once(size) {
      global.gc();
      const before = process.memoryUsage();
      const base = before.heapUsed + before.external;
      let peak = base;
      const timer = setInterval(() => {
        const usage = process.memoryUsage();
        peak = Math.max(peak, usage.heapUsed + usage.external);
      }, 5);
      let largestChunk = 0;
      try {
        const child = spawn(process.execPath, ['-e', \`
          const size = \${size};
          const chunk = Buffer.alloc(65536);
          for (let i = 0; i < chunk.length; i += 1) chunk[i] = i % 251;
          let remaining = size;
          function write() {
            if (remaining === 0) { process.exit(0); return; }
            const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
            remaining -= slice.length;
            if (!process.stdout.write(slice)) process.stdout.once('drain', write);
            else setImmediate(write);
          }
          write();
        \`]);
        child.stderr.on('data', () => undefined);
        const closed = new Promise((resolve) => child.on('close', resolve));
        const filePath = path.join(root, String(size) + '.bsm1');
        await encryptPrepared(child.stdout, filePath, prepared);
        if (await closed !== 0) throw new Error('dump failed');
        for await (const chunk of createReadStream(filePath)) {
          largestChunk = Math.max(largestChunk, chunk.length);
        }
      } finally {
        clearInterval(timer);
      }
      return { growth: peak - base, peak, largestChunk };
    }
    const small = await once(8 * 1024 * 1024);
    const large = await once(64 * 1024 * 1024);
    await rm(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({
      smallGrowth: small.growth,
      largeGrowth: large.growth,
      largePeak: large.peak,
      largestChunk: large.largestChunk,
    }));
  `;
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', () => undefined);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`memory measurement failed (${code})`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function patternProcess(size) {
  return spawn(process.execPath, ['-e', `
    const size = ${size};
    const chunk = Buffer.alloc(65536);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = i % 251;
    let remaining = size;
    function write() {
      if (remaining === 0) {
        process.exit(0);
        return;
      }
      const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      remaining -= slice.length;
      if (!process.stdout.write(slice)) process.stdout.once('drain', write);
      else setImmediate(write);
    }
    write();
  `]);
}

function patternHash(size) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(65536);
  for (let index = 0; index < chunk.length; index += 1) {
    chunk[index] = index % 251;
  }
  let remaining = size;
  while (remaining > 0) {
    const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
    hash.update(slice);
    remaining -= slice.length;
  }
  return hash.digest('hex');
}

function hashFile(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function failingStream() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeHandler = () => undefined;
  const child = {
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      this.signalCode = signal;
      stdout.destroy();
      stderr.destroy();
      this.exitCode = 1;
      closeHandler(1);
    },
    on(event, handler) {
      if (event === 'close') {
        closeHandler = handler;
      }
      return this;
    },
  };
  setImmediate(() => {
    stdout.write(Buffer.alloc(4096, 9));
    stdout.destroy(new Error('dump stream failed'));
  });
  return child;
}

test('redacts configured secrets from failure text', () => {
  const secret = 'ci-disposable-secret';
  expect(redact(`failed ${secret} ${PASSPHRASE}`, {
    BACKUP_S3_SECRET_ACCESS_KEY: secret,
    BACKUP_PASSPHRASE: PASSPHRASE,
  })).toBe('failed [redacted] [redacted]');
});
