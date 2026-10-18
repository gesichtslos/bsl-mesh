import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

test('pull request CI stays read-only and does not receive repository secrets', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  expect(workflow).toContain('pull_request:');
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).toMatch(/permissions:\s+contents:\s+read/);
  expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
});
