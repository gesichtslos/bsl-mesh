import { expect, test } from 'vitest';
import { cleanScanMessage, formatFindings, scanText } from '../scripts/scan-secrets.mjs';

const safePublication = [
  'export const host = "127.0.0.1";',
  'postgres://bslmesh_app:change-me-app-only@127.0.0.1:5432/bslmesh_dev',
  'postgres://bslmesh_admin:ci-disposable@127.0.0.1:5432/postgres',
  'source_kind: synthetic',
].join('\n');

test('a safe synthetic publication has no high-confidence findings', () => {
  expect(scanText(safePublication, 'safe.ts')).toEqual([]);
  expect(cleanScanMessage(1)).toContain('not proof');
});

test('synthetic credentials are reported without echoing the secret', () => {
  const token = ['ghp', 'SYNTHETICNOTAREALTOKEN000000'].join('_');
  const key = [
    '-----BEGIN ',
    'OPENSSH PRIVATE KEY-----',
    'SYNTHETIC-KEY-MATERIAL',
    '-----END ',
    'OPENSSH PRIVATE KEY-----',
  ].join('');
  const text = `const leaked = "${token}";\n${key}\n`;
  const findings = scanText(text, 'leak.ts');
  expect(findings.map((finding: { rule: string }) => finding.rule).sort()).toEqual(['github-token', 'private-key']);
  const report = formatFindings(findings).join('\n');
  expect(report).toContain('leak.ts:1: github-token');
  expect(report).not.toContain(token);
  expect(report).not.toContain('SYNTHETIC-KEY-MATERIAL');
  const databasePassword = 'synthetic-db-password';
  const scheme = 'postgres://bslmesh_app:';
  const host = '@127.0.0.1:5432/bslmesh_dev';
  const databaseUrl = scheme + databasePassword + host;
  const databaseFindings = scanText(databaseUrl, 'db.ts');
  expect(databaseFindings.map((finding: { rule: string }) => finding.rule)).toEqual(['postgres-password']);
  expect(formatFindings(databaseFindings).join('\n')).not.toContain(databasePassword);
});
