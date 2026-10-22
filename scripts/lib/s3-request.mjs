import { createHash, createHmac } from 'node:crypto';

import { BackupError } from './backup-crypto.mjs';

const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function assertS3Config(config) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new BackupError('S3 endpoint must not contain credentials.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
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

export function objectUrl(config, key) {
  assertObjectKey(key);
  const endpoint = new URL(config.endpoint);
  const path = `/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return new URL(`${endpoint.origin}${path}`);
}

export async function putObject(config, { key, body, payloadHash }) {
  const url = objectUrl(config, key);
  const headers = sign(config, {
    method: 'PUT',
    url,
    payloadHash,
    extra: {
      'content-type': 'application/octet-stream',
      'x-amz-meta-ciphertext-sha256': payloadHash,
    },
  });
  headers['content-length'] = String(body.length);
  const response = await fetch(url, { method: 'PUT', headers, body });
  await finish(response);
}

export async function getObject(config, key) {
  const url = objectUrl(config, key);
  const headers = sign(config, { method: 'GET', url, payloadHash: EMPTY_PAYLOAD_HASH, extra: {} });
  const response = await fetch(url, { method: 'GET', headers });
  const metadata = (response.headers.get('x-amz-meta-ciphertext-sha256') ?? '').trim();
  const body = await finish(response);
  return { body, metadata };
}

export async function createBucket(config) {
  const endpoint = new URL(config.endpoint);
  const url = new URL(`${endpoint.origin}/${config.bucket}`);
  const headers = sign(config, { method: 'PUT', url, payloadHash: EMPTY_PAYLOAD_HASH, extra: {} });
  headers['content-length'] = '0';
  const response = await fetch(url, { method: 'PUT', headers });
  await finish(response);
}

export function sign(config, { method, url, payloadHash, extra, now = new Date() }) {
  assertS3Config(config);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extra,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const canonical = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region))
    .update(stringToSign)
    .digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

function signingKey(secret, dateStamp, region) {
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  return createHmac('sha256', serviceKey).update('aws4_request').digest();
}

function assertObjectKey(key) {
  if (!/^bslmesh\/bslmesh_dev-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.bsm1$/.test(key)) {
    throw new BackupError('Backup object name is not accepted.');
  }
}

async function finish(response) {
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new BackupError(`S3 request failed (${response.status}).`);
  }
  return body;
}
