import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

test('the volume guard reports a running user and accepts an unused volume', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bslmesh-volume-'));
  const occupied = path.join(directory, 'occupied.txt');
  const empty = path.join(directory, 'empty.txt');
  await writeFile(occupied, 'bsl-mesh-staging-db-1\n');
  await writeFile(empty, '');
  const busy = spawnSync('bash', ['scripts/check-production-volume.sh', 'bsl-mesh-staging_pgdata'], {
    env: { ...process.env, VOLUME_USERS_FILE: occupied },
    encoding: 'utf8',
  });
  const free = spawnSync('bash', ['scripts/check-production-volume.sh', 'bsl-mesh-staging_pgdata'], {
    env: { ...process.env, VOLUME_USERS_FILE: empty },
    encoding: 'utf8',
  });
  expect(busy.status).toBe(3);
  expect(busy.stderr).toContain('bsl-mesh-staging-db-1');
  expect(busy.stderr).toContain('does not stop');
  expect(free.status).toBe(0);
});
