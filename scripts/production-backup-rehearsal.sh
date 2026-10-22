#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pg_name=bslmesh-backup-pg
s3_name=bslmesh-backup-minio
port=19090
cleanup() {
  docker rm -f "${pg_name}" "${s3_name}" >/dev/null 2>&1 || true
  rm -f /tmp/bslmesh-backup-rehearsal.err
}
cleanup
trap cleanup EXIT

docker run -d --name "${s3_name}" \
  -p "127.0.0.1:${port}:8000" \
  -e REMOTE_MANAGEMENT_DISABLE=1 \
  -e S3BACKEND=mem \
  -e SCALITY_ACCESS_KEY_ID=ci-disposable-access \
  -e SCALITY_SECRET_ACCESS_KEY=ci-disposable-secret \
  zenko/cloudserver:latest-7.70.10 >/dev/null
docker run -d --name "${pg_name}" \
  -e POSTGRES_PASSWORD=ci-disposable \
  -e POSTGRES_USER=bslmesh_admin \
  -e POSTGRES_DB=bslmesh_dev \
  postgres:18.6 >/dev/null

for _ in $(seq 1 40); do
  s3_ready=0
  pg_ready=0
  s3_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/" || true)"
  if [ "${s3_code}" = "403" ]; then
    s3_ready=1
  fi
  docker exec "${pg_name}" pg_isready -U bslmesh_admin -d bslmesh_dev >/dev/null 2>&1 && pg_ready=1
  if [ "${s3_ready}" = 1 ] && [ "${pg_ready}" = 1 ]; then
    break
  fi
  sleep 1
done
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/")" = "403"
bad_auth="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:${port}/bslmesh-backup-ci" -H 'authorization: AWS4-HMAC-SHA256 Credential=bad/20261022/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=deadbeef')"
test "${bad_auth}" != "200"
docker exec "${pg_name}" pg_isready -U bslmesh_admin -d bslmesh_dev >/dev/null

docker exec -i "${pg_name}" psql -U bslmesh_admin -d bslmesh_dev -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE app_meta (
  id smallint PRIMARY KEY CHECK (id = 1),
  service_name text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_meta (id, service_name) VALUES (1, 'bsl-mesh');
CREATE TABLE backup_marker (
  id integer PRIMARY KEY,
  label text NOT NULL
);
INSERT INTO backup_marker (id, label) VALUES (1, 'synthetic-backup-marker');
SQL

export BACKUP_S3_ENDPOINT="http://127.0.0.1:${port}"
export BACKUP_S3_BUCKET=bslmesh-backup-ci
export BACKUP_S3_REGION=us-east-1
export BACKUP_S3_ACCESS_KEY_ID=ci-disposable-access
export BACKUP_S3_SECRET_ACCESS_KEY=ci-disposable-secret
export BACKUP_PASSPHRASE=ci-disposable-passphrase
export BACKUP_PG_DOCKER_CONTAINER="${pg_name}"

node scripts/production-backup.mjs create-bucket
uploaded="$(node scripts/production-backup.mjs backup)"
key="$(printf '%s\n' "${uploaded}" | awk '{print $2}')"
node scripts/production-backup.mjs verify "${key}"
BACKUP_OBJECT_KEY="${key}" node --input-type=module <<'EOF'
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getObject } from './scripts/lib/s3-request.mjs';
const config = {
  endpoint: process.env.BACKUP_S3_ENDPOINT,
  bucket: process.env.BACKUP_S3_BUCKET,
  region: process.env.BACKUP_S3_REGION,
  accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
};
const directory = await mkdtemp(path.join(tmpdir(), 'bslmesh-cipher-'));
const filePath = path.join(directory, 'backup.bsm1');
try {
  const downloaded = await getObject(config, { key: process.env.BACKUP_OBJECT_KEY, filePath });
  const marker = Buffer.from('synthetic-backup-marker');
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const window = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (window.includes(marker)) {
      process.stderr.write('ciphertext contains the plaintext marker\n');
      process.exit(1);
    }
    pending = window.subarray(Math.max(0, window.length - marker.length + 1));
  }
  if (downloaded.sha256 !== downloaded.metadata) {
    process.stderr.write('stored checksum does not match the ciphertext\n');
    process.exit(1);
  }
  process.stdout.write('ciphertext-checked\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
EOF

node scripts/production-backup.mjs restore "${key}" bslmesh_backup_check
label="$(docker exec "${pg_name}" psql -U bslmesh_admin -d bslmesh_backup_check -tAc "SELECT label FROM backup_marker WHERE id = 1;")"
label="$(printf '%s' "${label}" | tr -d '[:space:]')"
test "${label}" = "synthetic-backup-marker"

node --expose-gc --input-type=module <<'EOF'
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encryptPrepared, prepareEncryption } from './scripts/lib/backup-crypto.mjs';
import { getObject, putObject } from './scripts/lib/s3-request.mjs';
const size = 64 * 1024 * 1024;
const config = {
  endpoint: process.env.BACKUP_S3_ENDPOINT,
  bucket: process.env.BACKUP_S3_BUCKET,
  region: process.env.BACKUP_S3_REGION,
  accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
};
const prepared = await prepareEncryption(process.env.BACKUP_PASSPHRASE);
global.gc();
const before = process.memoryUsage();
const base = before.heapUsed + before.external;
let peak = base;
const timer = setInterval(() => {
  const usage = process.memoryUsage();
  peak = Math.max(peak, usage.heapUsed + usage.external);
}, 5);
const root = await mkdtemp(path.join(tmpdir(), 'bslmesh-s3-memory-'));
try {
  const child = spawn(process.execPath, ['-e', `
    const size = ${size};
    const chunk = Buffer.alloc(65536, 7);
    let remaining = size;
    function write() {
      if (remaining === 0) { process.exit(0); return; }
      const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      remaining -= slice.length;
      if (!process.stdout.write(slice)) process.stdout.once('drain', write);
      else setImmediate(write);
    }
    write();
  `]);
  child.stderr.on('data', () => undefined);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const encryptedPath = path.join(root, 'backup.bsm1');
  const encrypted = await encryptPrepared(child.stdout, encryptedPath, prepared);
  if (await closed !== 0) throw new Error('large dump failed');
  const key = 'bslmesh/bslmesh_dev-20261022T010000Z-a1b2c3d4.bsm1';
  await putObject(config, {
    key,
    filePath: encryptedPath,
    contentLength: encrypted.bytes,
    payloadHash: encrypted.sha256,
  });
  const downloadedPath = path.join(root, 'downloaded.bsm1');
  const downloaded = await getObject(config, { key, filePath: downloadedPath });
  if (downloaded.sha256 !== encrypted.sha256 || downloaded.metadata !== encrypted.sha256) {
    throw new Error('large object checksum mismatch');
  }
} finally {
  clearInterval(timer);
  await rm(root, { recursive: true, force: true });
}
const growth = peak - base;
process.stdout.write(`s3-memory bytes=${size} peakGrowth=${growth}\n`);
if (growth > 80 * 1024 * 1024) {
  throw new Error('S3 transfer retained too much memory');
}
EOF

set +e
BACKUP_PASSPHRASE=wrong-passphrase-value node scripts/production-backup.mjs verify "${key}" >/tmp/bslmesh-backup-rehearsal.err 2>&1
status=$?
set -e
test "${status}" -ne 0
if grep -F -e 'ci-disposable-secret' -e 'ci-disposable-passphrase' -e 'synthetic-backup-marker' /tmp/bslmesh-backup-rehearsal.err >/dev/null; then
  echo "backup failure text included a secret or plaintext marker" >&2
  exit 1
fi
echo "rehearsal-ok"
