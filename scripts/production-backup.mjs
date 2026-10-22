import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BackupError, HEADER_LENGTH, decryptBuffer, decryptFile, encryptReadable, encryptToFile } from './lib/backup-crypto.mjs';
import { createBucket, getObject, putObject } from './lib/s3-request.mjs';

const REQUIRED = [
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_REGION',
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY',
  'BACKUP_PASSPHRASE',
];
const PROTECTED = new Set(['bslmesh_dev', 'postgres', 'template0', 'template1']);

export function requireConfig(env) {
  const missing = REQUIRED.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    throw new BackupError(
      [
        'External backup storage is not configured. Refusing to upload.',
        'Required parameters, supplied on the server and not in chat or Git:',
        ...missing.map((name) => `  ${name}`),
        'BACKUP_PASSPHRASE must stay off the VPS after the upload. The S3 secret must not be committed.',
      ].join('\n'),
      2,
    );
  }
  return {
    endpoint: env.BACKUP_S3_ENDPOINT.trim(),
    bucket: env.BACKUP_S3_BUCKET.trim(),
    region: env.BACKUP_S3_REGION.trim(),
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    passphrase: env.BACKUP_PASSPHRASE,
  };
}

export function backupObjectKey(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `bslmesh/bslmesh_dev-${stamp}-${randomBytes(4).toString('hex')}.bsm1`;
}

export function assertRestoreTarget(target, env) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(target)) {
    throw new BackupError('Refusing an unexpected target database name.');
  }
  if (PROTECTED.has(target) && (env.CONFIRM_RESTORE_APP_DATABASE !== 'yes' || target !== 'bslmesh_dev')) {
    throw new BackupError(`Refusing to restore into ${target}. Restore is not an application rollback and does not replace the running database unless CONFIRM_RESTORE_APP_DATABASE=yes and the target is bslmesh_dev.`);
  }
}

export async function createBackup(input) {
  const directory = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), 'bslmesh-backup-'));
  await chmod(directory, 0o700);
  const encryptedPath = path.join(directory, 'backup.bsm1');
  try {
    const dump = input.spawnDump();
    dump.stderr?.on('data', () => undefined);
    const closed = waitForClose(dump);
    let encryptionError = null;
    try {
      await encryptToFile(dump.stdout, encryptedPath, input.passphrase);
    } catch (error) {
      encryptionError = error;
    }
    const code = await closed;
    if (code !== 0) {
      throw new BackupError('Database dump failed.');
    }
    if (encryptionError !== null) {
      throw encryptionError;
    }
    const body = await readFile(encryptedPath);
    if (body.length <= HEADER_LENGTH + 16) {
      throw new BackupError('Database dump failed.');
    }
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const key = input.objectKey ?? backupObjectKey(input.now);
    await input.putObject({ key, body, payloadHash });
    return { key, bytes: body.length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function downloadVerified(input) {
  const downloaded = await input.getObject(input.key);
  const actual = createHash('sha256').update(downloaded.body).digest('hex');
  if (actual !== downloaded.metadata || actual.length !== 64) {
    throw new BackupError('Backup integrity check failed.');
  }
  return downloaded.body;
}

export async function verifyBackup(input) {
  const directory = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), 'bslmesh-restore-'));
  await chmod(directory, 0o700);
  const encryptedPath = path.join(directory, 'backup.bsm1');
  const plainPath = path.join(directory, 'backup.dump');
  try {
    const body = await downloadVerified(input);
    await writeFile(encryptedPath, body, { mode: 0o600 });
    await decryptFile(encryptedPath, plainPath, input.passphrase);
    const listing = await input.listArchive(plainPath);
    if (!listing.includes('TABLE public app_meta')) {
      throw new BackupError('Backup archive is missing the application marker.');
    }
    const entries = listing.split('\n').filter((line) => /^[0-9]+;/.test(line)).length;
    return { entries };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function restoreBackup(input) {
  assertRestoreTarget(input.target, input.env);
  const directory = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), 'bslmesh-restore-'));
  await chmod(directory, 0o700);
  const encryptedPath = path.join(directory, 'backup.bsm1');
  const plainPath = path.join(directory, 'backup.dump');
  let created = false;
  try {
    const body = await downloadVerified(input);
    await writeFile(encryptedPath, body, { mode: 0o600 });
    await decryptFile(encryptedPath, plainPath, input.passphrase);
    await rm(encryptedPath, { force: true });
    if (await input.databaseExists(input.target)) {
      throw new BackupError('Refusing to restore into an existing database.');
    }
    await input.createDatabase(input.target);
    created = true;
    await input.restorePlain(plainPath, input.target);
    const serviceName = await input.serviceName(input.target);
    if (serviceName !== 'bsl-mesh') {
      throw new BackupError('Restored application marker was not found.');
    }
  } catch (error) {
    if (created) {
      await input.dropDatabase(input.target).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function selfTest() {
  const passphrase = `self-test-${randomBytes(16).toString('hex')}`;
  const sample = Buffer.from('bslmesh-backup-self-test');
  const encrypted = await encryptReadable(sample, passphrase);
  const restored = await decryptBuffer(encrypted, passphrase);
  if (!restored.equals(sample)) {
    throw new BackupError('encrypted backup self-test failed');
  }
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 20] ^= 0x01;
  try {
    await decryptBuffer(tampered, passphrase);
    throw new BackupError('encrypted backup self-test failed');
  } catch (error) {
    if (!(error instanceof BackupError) || error.message !== 'Backup decryption failed.') {
      throw new BackupError('encrypted backup self-test failed');
    }
  }
  process.stdout.write('encrypted backup self-test passed\n');
}

export function redact(message, env) {
  let text = message;
  for (const name of ['BACKUP_PASSPHRASE', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_ACCESS_KEY_ID']) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 4) {
      text = text.split(value).join('[redacted]');
    }
  }
  return text;
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function assertContainer(container) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
    throw new BackupError('BACKUP_PG_DOCKER_CONTAINER contains an unexpected name.');
  }
}

function dumpProcess(env) {
  const container = env.BACKUP_PG_DOCKER_CONTAINER?.trim() ?? '';
  if (container !== '') {
    assertContainer(container);
    return spawn('docker', [
      'exec', '-i', container,
      'pg_dump', '-U', 'bslmesh_admin', '-d', 'bslmesh_dev', '--no-owner', '--no-privileges', '-Fc',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn('docker', [
    'compose', '-f', 'compose.production.yaml', 'exec', '-T', 'db',
    'pg_dump', '-U', 'bslmesh_admin', '-d', 'bslmesh_dev', '--no-owner', '--no-privileges', '-Fc',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function docker(args) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => undefined);
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  const code = await waitForClose(child);
  if (code !== 0) {
    throw new BackupError('Database command failed.');
  }
  return Buffer.concat(stdout).toString('utf8');
}

function psqlArgs(env, database, sql) {
  const container = env.BACKUP_PG_DOCKER_CONTAINER?.trim() ?? '';
  if (container !== '') {
    assertContainer(container);
    return ['exec', '-i', container, 'psql', '-U', 'bslmesh_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql];
  }
  return ['compose', '-f', 'compose.production.yaml', 'exec', '-T', 'db', 'psql', '-U', 'bslmesh_admin', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql];
}

function databaseApi(env) {
  return {
    async databaseExists(target) {
      const result = await docker(psqlArgs(env, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${target}'`));
      return result.trim() === '1';
    },
    async createDatabase(target) {
      await docker(psqlArgs(env, 'postgres', `CREATE DATABASE ${target} OWNER bslmesh_admin`));
    },
    async dropDatabase(target) {
      await docker(psqlArgs(env, 'postgres', `DROP DATABASE ${target} WITH (FORCE)`));
    },
    async serviceName(target) {
      const result = await docker(psqlArgs(env, target, 'SELECT service_name FROM app_meta WHERE id = 1'));
      return result.trim();
    },
    async restorePlain(plainPath, target) {
      const container = env.BACKUP_PG_DOCKER_CONTAINER?.trim() ?? '';
      const remote = '/tmp/bslmesh-restore.dump';
      if (container !== '') {
        assertContainer(container);
        await docker(['cp', plainPath, `${container}:${remote}`]);
        try {
          await docker(['exec', '-i', container, 'pg_restore', '-U', 'bslmesh_admin', '-d', target, '--no-owner', '--exit-on-error', remote]);
        } finally {
          await docker(['exec', '-i', container, 'rm', '-f', remote]).catch(() => undefined);
        }
        return;
      }
      await docker(['compose', '-f', 'compose.production.yaml', 'cp', plainPath, `db:${remote}`]);
      try {
        await docker(['compose', '-f', 'compose.production.yaml', 'exec', '-T', 'db', 'pg_restore', '-U', 'bslmesh_admin', '-d', target, '--no-owner', '--exit-on-error', remote]);
      } finally {
        await docker(['compose', '-f', 'compose.production.yaml', 'exec', '-T', 'db', 'rm', '-f', remote]).catch(() => undefined);
      }
    },
    async listArchive(plainPath) {
      return docker([
        'run', '--rm',
        '-v', `${plainPath}:/restore/backup.dump:ro`,
        'postgres:18.6',
        'pg_restore', '-l', '/restore/backup.dump',
      ]);
    },
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--self-test') {
    await selfTest();
    return;
  }
  if (command === 'create-bucket') {
    await createBucket(requireConfig(process.env));
    process.stdout.write('bucket ready\n');
    return;
  }
  const config = requireConfig(process.env);
  if (command === undefined || command === 'backup') {
    const result = await createBackup({
      passphrase: config.passphrase,
      spawnDump: () => dumpProcess(process.env),
      putObject: (upload) => putObject(config, upload),
    });
    process.stdout.write(`uploaded ${result.key} bytes=${result.bytes}\n`);
    return;
  }
  const key = args[0] ?? '';
  if (command === 'verify') {
    const result = await verifyBackup({
      ...databaseApi(process.env),
      key,
      passphrase: config.passphrase,
      getObject: (objectKey) => getObject(config, objectKey),
    });
    process.stdout.write(`verified ${key} entries=${result.entries}\n`);
    return;
  }
  if (command === 'restore') {
    const target = args[1] ?? '';
    await restoreBackup({
      ...databaseApi(process.env),
      env: process.env,
      key,
      target,
      passphrase: config.passphrase,
      getObject: (objectKey) => getObject(config, objectKey),
    });
    process.stdout.write(`restored ${target}\n`);
    return;
  }
  throw new BackupError('usage: scripts/production-backup.sh [backup|verify <object>|restore <object> <database>|--self-test]');
}

if (process.argv[1]?.endsWith('production-backup.mjs') === true) {
  main().catch((error) => {
    const message = redact(error instanceof Error ? error.message : 'Backup failed.', process.env);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof BackupError ? error.exitCode : 1;
  });
}
