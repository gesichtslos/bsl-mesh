#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const failures = [];

function fail(message) {
  failures.push(message);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const typescript = require('typescript');
const typescriptPackage = require('typescript/package.json');
const typescriptEslint = require('typescript-eslint/package.json');

if (nvmrc !== '24.22.0') {
  fail(`.nvmrc must be 24.22.0, found ${nvmrc}`);
}
if (process.versions.node !== '24.22.0') {
  fail(`Node must be 24.22.0, found ${process.versions.node}`);
}
if (pkg.packageManager !== 'pnpm@12.14.0') {
  fail(`packageManager must be pnpm@12.14.0, found ${pkg.packageManager}`);
}
if (pkg.engines?.node !== '24.22.0') {
  fail(`engines.node must be 24.22.0, found ${pkg.engines?.node}`);
}

const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
if (pnpmVersion !== '12.14.0') {
  fail(`pnpm must be 12.14.0, found ${pnpmVersion}`);
}

const requiredLockPins = [
  'specifier: 12.14.0',
  'version: 12.14.0',
  'version: typescript@7.0.2',
  "'@typescript/typescript6@6.0.2'",
  'fastify@5.12.7:',
  'typescript-eslint@8.71.2:',
];
for (const pin of requiredLockPins) {
  if (!lockfile.includes(pin)) {
    fail(`pnpm-lock.yaml is missing ${pin}`);
  }
}

if (typescriptPackage.version !== '6.0.2') {
  fail(`typescript package pin must stay 6.0.2, found ${typescriptPackage.version}`);
}
if (!/^6\.0\.\d+$/.test(typescript.version)) {
  fail(`typescript API must stay on 6.0 for typescript-eslint, found ${typescript.version}`);
}
if (typescriptEslint.peerDependencies?.typescript !== '>=4.8.4 <6.1.0') {
  fail(`typescript-eslint peer range changed: ${typescriptEslint.peerDependencies?.typescript}`);
}
if (!peerAccepts(typescript.version, typescriptEslint.peerDependencies.typescript)) {
  fail(`typescript ${typescript.version} does not satisfy ${typescriptEslint.peerDependencies.typescript}`);
}

const tscVersion = execFileSync('pnpm', ['exec', 'tsc', '--version'], { encoding: 'utf8' }).trim();
const tsc6Version = execFileSync('pnpm', ['exec', 'tsc6', '--version'], { encoding: 'utf8' }).trim();
if (tscVersion !== 'Version 7.0.2') {
  fail(`tsc must be TypeScript 7.0.2, found ${tscVersion}`);
}
if (tsc6Version !== `Version ${typescript.version}`) {
  fail(`tsc6 must report the TypeScript 6 API version, found ${tsc6Version}`);
}
if (majorOf(tscVersion) === majorOf(typescript.version)) {
  fail('TypeScript 7 compiler and TypeScript 6 API resolved to the same major');
}

if (failures.length > 0) {
  for (const message of failures) {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
}
process.stdout.write(`toolchain ok: node ${process.versions.node}, pnpm ${pnpmVersion}, tsc ${tscVersion}, typescript package ${typescriptPackage.version}, typescript API ${typescript.version}\n`);

function majorOf(version) {
  const match = /(\d+)\./.exec(version);
  return match?.[1] ?? '';
}

function peerAccepts(version, range) {
  if (range !== '>=4.8.4 <6.1.0') {
    return false;
  }
  const [major, minor, patch] = version.split('.').map((part) => Number(part));
  const atLeast484 = major > 4 || (major === 4 && (minor > 8 || (minor === 8 && patch >= 4)));
  const below61 = major < 6 || (major === 6 && minor < 1);
  return atLeast484 && below61;
}
