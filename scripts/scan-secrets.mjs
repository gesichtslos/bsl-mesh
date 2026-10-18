#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLACEHOLDER_PASSWORDS = new Set([
  'ci-disposable',
  'ci-disposable-app',
  'ci-disposable-test',
  'change-me-admin-only',
  'change-me-app-only',
  'change-me-local-only',
  'change-me-test-only',
  'application-secret',
  'test-secret',
  'local',
  'a@b:c/d#e%f g',
  'super-secret-db-pass',
  'super-secret-token',
]);

const PATTERNS = [
  { id: 'private-key', expression: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { id: 'github-pat', expression: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'aws-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', expression: /\bsk_live_[A-Za-z0-9]{10,}\b/ },
];

const POSTGRES_URL = /postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@/g;

export function scanText(text, filePath = 'input') {
  const findings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of PATTERNS) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(line)) {
        findings.push({ path: filePath, line: index + 1, rule: pattern.id });
      }
    }
    POSTGRES_URL.lastIndex = 0;
    for (const match of line.matchAll(POSTGRES_URL)) {
      const password = decodeURIComponent(match[2] ?? '');
      if (!isIgnorablePassword(password)) {
        findings.push({ path: filePath, line: index + 1, rule: 'postgres-password' });
      }
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line}: ${finding.rule}`);
}

export function cleanScanMessage(fileCount) {
  return `secret scan: no high-confidence patterns in ${fileCount} file(s). This is not proof the change is safe to publish.`;
}

export function scanFiles(files) {
  const findings = [];
  for (const filePath of files) {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) {
      continue;
    }
    findings.push(...scanText(text, filePath));
  }
  return findings;
}

function isIgnorablePassword(password) {
  if (password.length < 8) {
    return true;
  }
  if (password.includes('$') || password.includes('{') || password.includes('}')) {
    return true;
  }
  return PLACEHOLDER_PASSWORDS.has(password) || password.startsWith('change-me-');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter((file) => file !== '');
}

function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter((file) => file !== '');
}

function main() {
  const mode = process.argv.includes('--staged') ? 'staged' : 'tracked';
  const files = mode === 'staged' ? stagedFiles() : trackedFiles();
  const findings = scanFiles(files);
  if (findings.length > 0) {
    process.stderr.write(`${formatFindings(findings).join('\n')}\n`);
    process.stderr.write('High-confidence secret patterns were found. Remove them before publishing. A later deletion does not erase Git history.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${cleanScanMessage(files.length)}\n`);
}

const executedDirectly = process.argv[1]?.endsWith('scan-secrets.mjs') === true;
if (executedDirectly) {
  main();
}
