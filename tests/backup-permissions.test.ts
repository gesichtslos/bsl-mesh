import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

test('backup files are created without access for other users', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bsl-mesh-backup-'));
  const dumpPath = path.join(directory, 'nested', 'bslmesh_dev-test.dump');
  execFileSync('bash', ['-lc', `
    source scripts/lib/private-file.sh
    umask 022
    printf 'dump' | write_private_dump ${JSON.stringify(dumpPath)}
  `], { cwd: process.cwd() });
  expect(statSync(path.dirname(dumpPath)).mode & 0o777).toBe(0o700);
  expect(statSync(dumpPath).mode & 0o777).toBe(0o600);
});
