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

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function gitBuffer(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

function trackedFiles(cwd = process.cwd()) {
  return git(['ls-files', '-z'], cwd).split('\0').filter((file) => file !== '');
}

function stagedFiles(cwd = process.cwd()) {
  return git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], cwd)
    .split('\0')
    .filter((file) => file !== '');
}

function commitsInRange(remoteSha, localSha, cwd) {
  if (remoteSha === undefined || remoteSha === '' || /^0+$/.test(remoteSha)) {
    return git(['rev-list', localSha, '--not', '--remotes'], cwd).split('\n').filter((sha) => sha !== '');
  }
  return git(['rev-list', `${remoteSha}..${localSha}`], cwd).split('\n').filter((sha) => sha !== '');
}

function blobsAddedInCommit(sha, cwd) {
  const diff = git(['diff-tree', '-r', '--root', '--no-commit-id', '--diff-filter=AM', sha], cwd);
  const blobs = [];
  for (const line of diff.split('\n')) {
    if (line === '') {
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const meta = line.slice(0, tab).split(/\s+/);
    const blob = meta[3];
    const filePath = line.slice(tab + 1);
    if (blob === undefined || /^0+$/.test(blob)) {
      continue;
    }
    blobs.push({ blob, filePath });
  }
  return blobs;
}

export function scanStaged(cwd = process.cwd()) {
  const files = stagedFiles(cwd);
  const findings = [];
  for (const filePath of files) {
    let buffer;
    try {
      buffer = gitBuffer(['show', `:${filePath}`], cwd);
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      continue;
    }
    findings.push(...scanText(buffer.toString('utf8'), filePath));
  }
  return { findings, count: files.length };
}

export function scanPushRange(remoteSha, localSha, cwd = process.cwd()) {
  const commits = commitsInRange(remoteSha, localSha, cwd);
  const findings = [];
  const seenBlobs = new Set();
  for (const sha of commits) {
    const message = git(['log', '-1', '--format=%B', sha], cwd);
    findings.push(...scanText(message, `commit ${sha} message`));
    for (const entry of blobsAddedInCommit(sha, cwd)) {
      if (seenBlobs.has(entry.blob)) {
        continue;
      }
      seenBlobs.add(entry.blob);
      let buffer;
      try {
        buffer = gitBuffer(['cat-file', 'blob', entry.blob], cwd);
      } catch {
        continue;
      }
      if (buffer.includes(0)) {
        continue;
      }
      findings.push(...scanText(buffer.toString('utf8'), `${entry.filePath} at ${sha.slice(0, 12)}`));
    }
  }
  return { findings, count: commits.length };
}

function report(result) {
  if (result.findings.length > 0) {
    process.stderr.write(`${formatFindings(result.findings).join('\n')}\n`);
    process.stderr.write('High-confidence secret patterns were found. Remove them before publishing. A later deletion does not erase Git history.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${cleanScanMessage(result.count)}\n`);
}

function main() {
  const rangeFlag = process.argv.indexOf('--push-range');
  if (process.argv.includes('--staged')) {
    report(scanStaged());
    return;
  }
  if (rangeFlag !== -1) {
    const remoteSha = process.argv[rangeFlag + 1];
    const localSha = process.argv[rangeFlag + 2];
    if (remoteSha === undefined || localSha === undefined) {
      process.stderr.write('usage: node scripts/scan-secrets.mjs --push-range <remote-sha> <local-sha>\n');
      process.exitCode = 2;
      return;
    }
    report(scanPushRange(remoteSha, localSha));
    return;
  }
  const files = trackedFiles();
  report({ findings: scanFiles(files), count: files.length });
}

const executedDirectly = process.argv[1]?.endsWith('scan-secrets.mjs') === true;
if (executedDirectly) {
  main();
}
