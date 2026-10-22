import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

test('the production migration entrypoint calls the compiled privilege module', () => {
  const script = readFileSync('docker/production-migrate.sh', 'utf8');
  expect(script).toContain('node dist/db/production-privileges.js');
  expect(script).not.toContain('node dist/production-privileges.js');
});

test('production compose keeps its database volume separate from staging', () => {
  const compose = readFileSync('compose.production.yaml', 'utf8');
  expect(compose).toContain('name: bsl-mesh-production_pgdata');
  expect(compose).toContain('external: true');
  expect(compose).not.toContain('bsl-mesh-staging_pgdata');
});

test('the volume guard reports a running user and accepts an unused volume', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bslmesh-volume-'));
  const occupied = path.join(directory, 'occupied.txt');
  const empty = path.join(directory, 'empty.txt');
  await writeFile(occupied, 'bsl-mesh-production-db-1\n');
  await writeFile(empty, '');
  const busy = spawnSync('bash', ['scripts/check-production-volume.sh'], {
    env: { ...process.env, VOLUME_USERS_FILE: occupied },
    encoding: 'utf8',
  });
  const free = spawnSync('bash', ['scripts/check-production-volume.sh'], {
    env: { ...process.env, VOLUME_USERS_FILE: empty },
    encoding: 'utf8',
  });
  expect(busy.status).toBe(3);
  expect(busy.stderr).toContain('bsl-mesh-production_pgdata');
  expect(busy.stderr).toContain('bsl-mesh-production-db-1');
  expect(busy.stderr).not.toContain('bsl-mesh-staging_pgdata');
  expect(busy.stderr).toContain('does not stop');
  expect(free.status).toBe(0);
});
