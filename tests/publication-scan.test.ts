import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vitest';

import { installGitHooks } from '../scripts/install-git-hooks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(projectRoot, 'scripts/scan-secrets.mjs');
const hookSource = path.join(projectRoot, 'scripts/hooks');
const repositories: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync('git', [
    '-C', repo,
    '-c', 'user.name=Synthetic Tester',
    '-c', 'user.email=synthetic@example.com',
    ...args,
  ], { encoding: 'utf8' });
}

function createRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'bsl-mesh-scan-'));
  repositories.push(repo);
  git(repo, ['init', '-b', 'main']);
  return repo;
}

function syntheticToken(): string {
  return ['ghp', 'INDEXONLYTOKEN0000000000'].join('_');
}

afterEach(() => {
  while (repositories.length > 0) {
    const repo = repositories.pop();
    if (repo !== undefined) {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('staged scan reads the index when the worktree no longer has the secret', () => {
  const repo = createRepo();
  const token = syntheticToken();
  writeFileSync(path.join(repo, 'notes.txt'), `token=${token}\n`);
  git(repo, ['add', 'notes.txt']);
  writeFileSync(path.join(repo, 'notes.txt'), 'token=removed-from-worktree\n');

  const result = spawnSync(process.execPath, [scanner, '--staged'], { cwd: repo, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('notes.txt:1: github-token');
  expect(output).not.toContain(token);
});

test('unpublished history still fails when a later commit deletes the secret', () => {
  const repo = createRepo();
  const token = syntheticToken();
  writeFileSync(path.join(repo, 'notes.txt'), `token=${token}\n`);
  git(repo, ['add', 'notes.txt']);
  git(repo, ['commit', '-m', 'add synthetic secret']);
  git(repo, ['rm', 'notes.txt']);
  git(repo, ['commit', '-m', 'remove synthetic secret']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  const result = spawnSync(process.execPath, [
    scanner,
    '--push-range',
    '0000000000000000000000000000000000000000',
    head,
  ], { cwd: repo, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('github-token');
  expect(output).not.toContain(token);
  expect(git(repo, ['ls-files'])).not.toContain('notes.txt');
});

test('an existing user hook is left unchanged', () => {
  const repo = createRepo();
  const hooks = path.join(repo, '.git/hooks');
  mkdirSync(hooks, { recursive: true });
  const destination = path.join(hooks, 'pre-commit');
  const custom = '#!/bin/sh\necho user-hook\n';
  writeFileSync(destination, custom);
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = installGitHooks({ root: projectRoot, gitDir: path.join(repo, '.git'), hookSourceDir: hookSource });
    expect(result.skipped).toContain('pre-commit');
    expect(result.installed).toContain('pre-push');
  } finally {
    process.stderr.write = write;
  }
  expect(readFileSync(destination, 'utf8')).toBe(custom);
  expect(warnings.join('')).toContain('left unchanged');
});
