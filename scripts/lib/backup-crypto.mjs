import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const MAGIC = Buffer.from('BSM1');
const VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
export const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + IV_LENGTH;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class BackupError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'BackupError';
    this.exitCode = exitCode;
  }
}

export function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new BackupError('BACKUP_PASSPHRASE must contain at least 16 characters.');
  }
}

export async function encryptReadable(source, passphrase) {
  assertPassphrase(passphrase);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt, 32, SCRYPT_OPTIONS);
  const header = encodeHeader(salt, iv);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const body = await readableToBuffer(Readable.from(source).pipe(cipher));
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export async function encryptToFile(source, filePath, passphrase) {
  const plaintext = await collect(source);
  const encrypted = await encryptReadable(Readable.from(plaintext), passphrase);
  await writeFile(filePath, encrypted, { flag: 'wx', mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function decryptFile(encryptedPath, plainPath, passphrase) {
  assertPassphrase(passphrase);
  const size = (await stat(encryptedPath)).size;
  if (size < HEADER_LENGTH + TAG_LENGTH) {
    throw new BackupError('Backup decryption failed.');
  }
  const handle = await open(encryptedPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_LENGTH);
    const tag = Buffer.alloc(TAG_LENGTH);
    await readExact(handle, header, 0);
    await readExact(handle, tag, size - TAG_LENGTH);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) {
      throw new BackupError('Backup decryption failed.');
    }
    const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LENGTH);
    const iv = header.subarray(HEADER_LENGTH - IV_LENGTH);
    const key = await deriveKey(passphrase, salt, 32, SCRYPT_OPTIONS);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const output = createWriteStream(plainPath, { flags: 'wx', mode: 0o600 });
    try {
      await pipeline(
        createReadStream(encryptedPath, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }),
        decipher,
        output,
      );
    } catch {
      throw new BackupError('Backup decryption failed.');
    }
  } finally {
    await handle.close();
  }
  await chmod(plainPath, 0o600);
}

export async function decryptBuffer(payload, passphrase) {
  assertPassphrase(passphrase);
  if (payload.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new BackupError('Backup decryption failed.');
  }
  const header = payload.subarray(0, HEADER_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const body = payload.subarray(HEADER_LENGTH, payload.length - TAG_LENGTH);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) {
    throw new BackupError('Backup decryption failed.');
  }
  const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LENGTH);
  const iv = header.subarray(HEADER_LENGTH - IV_LENGTH);
  try {
    const key = await deriveKey(passphrase, salt, 32, SCRYPT_OPTIONS);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError('Backup decryption failed.');
  }
}

function encodeHeader(salt, iv) {
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
}

async function readExact(handle, target, position) {
  const result = await handle.read(target, 0, target.length, position);
  if (result.bytesRead !== target.length) {
    throw new BackupError('Backup decryption failed.');
  }
}

function collect(source) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    source.on('data', (chunk) => chunks.push(chunk));
    source.on('end', () => resolve(Buffer.concat(chunks)));
    source.on('error', () => reject(new BackupError('Backup encryption failed.')));
  });
}

function readableToBuffer(source) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    source.on('data', (chunk) => chunks.push(chunk));
    source.on('end', () => resolve(Buffer.concat(chunks)));
    source.on('error', reject);
  });
}
