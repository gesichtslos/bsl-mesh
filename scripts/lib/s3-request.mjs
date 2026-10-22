import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BackupError } from './backup-crypto.mjs';

export function assertS3Config(config) {
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new BackupError('S3 endpoint must be an http(s) URL.');
  }
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new BackupError('S3 endpoint must not contain credentials.');
  }
  if (endpoint.protocol === 'http:') {
    if (!isLoopback(endpoint.hostname)) {
      throw new BackupError('Remote S3 endpoints must use HTTPS.');
    }
  } else if (endpoint.protocol !== 'https:') {
    throw new BackupError('S3 endpoint must be an http(s) URL.');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw new BackupError('S3 bucket name is not accepted.');
  }
  if (!/^[a-z0-9-]+$/.test(config.region)) {
    throw new BackupError('S3 region is not accepted.');
  }
  if (config.accessKeyId === '' || config.secretAccessKey === '') {
    throw new BackupError('S3 credentials are incomplete.');
  }
}

export async function putObject(config, { key, filePath, contentLength, payloadHash }) {
  assertObjectKey(key);
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
    throw new BackupError('Backup integrity check failed.');
  }
  const client = openClient(config);
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: contentLength,
      ContentType: 'application/octet-stream',
      Metadata: { 'ciphertext-sha256': payloadHash },
    }));
  } catch (error) {
    throw asS3Error(error);
  } finally {
    client.destroy();
  }
}

export async function getObject(config, { key, filePath }) {
  assertObjectKey(key);
  const client = openClient(config);
  const hash = createHash('sha256');
  const output = createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));
    if (response.Body?.pipe === undefined) {
      throw new BackupError('S3 request failed.');
    }
    const metadata = (response.Metadata?.['ciphertext-sha256'] ?? '').trim();
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response.Body, hasher, output);
    return {
      sha256: hash.digest('hex'),
      metadata,
      bytes: (await stat(filePath)).size,
    };
  } catch (error) {
    throw asS3Error(error);
  } finally {
    client.destroy();
    await chmod(filePath, 0o600).catch(() => undefined);
  }
}

export async function createBucket(config) {
  const client = openClient(config);
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    throw asS3Error(error);
  } finally {
    client.destroy();
  }
}

function openClient(config) {
  assertS3Config(config);
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function assertObjectKey(key) {
  if (!/^bslmesh\/bslmesh_dev-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.bsm1$/.test(key)) {
    throw new BackupError('Backup object name is not accepted.');
  }
}

function asS3Error(error) {
  if (error instanceof BackupError) {
    return error;
  }
  const status = error?.$metadata?.httpStatusCode;
  if (typeof status === 'number') {
    return new BackupError(`S3 request failed (${status}).`);
  }
  return new BackupError('S3 request failed.');
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost') {
    return true;
  }
  const family = isIP(host);
  if (family === 0) {
    return false;
  }
  return LOOPBACK.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
