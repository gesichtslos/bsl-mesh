import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, stat } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
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

export async function prepareEncryption(passphrase) {
  assertPassphrase(passphrase);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt, 32, SCRYPT_OPTIONS);
  return { key, iv, header: encodeHeader(salt, iv) };
}

export async function encryptPrepared(source, filePath, prepared) {
  const output = createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  try {
    const sha256 = await writeEncrypted(source, output, prepared);
    const bytes = (await stat(filePath)).size;
    return { bytes, sha256 };
  } catch (error) {
    source.destroy?.();
    throw error instanceof BackupError ? error : new BackupError('Backup encryption failed.');
  } finally {
    await chmod(filePath, 0o600).catch(() => undefined);
  }
}

export async function encryptToFile(source, filePath, passphrase) {
  const prepared = await prepareEncryption(passphrase);
  return encryptPrepared(source, filePath, prepared);
}

export async function encryptReadable(source, passphrase) {
  const prepared = await prepareEncryption(passphrase);
  const chunks = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const readable = Buffer.isBuffer(source) ? Readable.from(source) : source;
  try {
    await writeEncrypted(readable, destination, prepared);
  } catch (error) {
    throw error instanceof BackupError ? error : new BackupError('Backup encryption failed.');
  }
  return Buffer.concat(chunks);
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

export function sha256File(filePath) {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function writeEncrypted(source, destination, prepared) {
  const cipher = createCipheriv('aes-256-gcm', prepared.key, prepared.iv);
  cipher.setAAD(prepared.header);
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return pipeline(source, cipher, frameCiphertext(prepared.header, cipher), hasher, destination)
    .then(() => hash.digest('hex'));
}

function frameCiphertext(header, cipher) {
  let headerSent = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!headerSent) {
        headerSent = true;
        this.push(header);
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!headerSent) {
        this.push(header);
      }
      callback(null, cipher.getAuthTag());
    },
  });
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
