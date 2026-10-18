#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { assessToolchainCompatibility } from '../src/toolchain/peer-range.ts';

const require = createRequire(import.meta.url);
const failures = [];

function fail(message) {
  failures.push(message);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const typescript = require('typescript');
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

const compilerSpec = String(pkg.devDependencies?.['@typescript/native'] ?? '');
const apiSpec = String(pkg.devDependencies?.typescript ?? '');
const compilerVersion = compilerSpec.replace(/^npm:typescript@/, '');
const apiPackage = apiSpec.replace(/^npm:/, '');
for (const pin of ['specifier: 12.14.0', 'version: 12.14.0', compilerVersion, apiPackage, 'fastify@5.12.7:', 'typescript-eslint@8.71.2:']) {
  if (pin === '' || !lockfile.includes(pin)) {
    fail(`pnpm-lock.yaml is missing ${pin || 'a TypeScript pin'}`);
  }
}

const peerRange = typescriptEslint.peerDependencies?.typescript;
const compatibility = assessToolchainCompatibility({
  compilerVersion,
  apiVersion: typescript.version,
  peerRange: typeof peerRange === 'string' ? peerRange : '',
});
if (compatibility !== undefined) {
  fail(compatibility);
}

const tscVersion = execFileSync('pnpm', ['exec', 'tsc', '--version'], { encoding: 'utf8' }).trim();
if (tscVersion !== `Version ${compilerVersion}`) {
  fail(`tsc must match @typescript/native (${compilerVersion}), found ${tscVersion}`);
}
if (major(compilerVersion) !== major(typescript.version)) {
  const tsc6Version = execFileSync('pnpm', ['exec', 'tsc6', '--version'], { encoding: 'utf8' }).trim();
  if (tsc6Version !== `Version ${typescript.version}`) {
    fail(`tsc6 must report the TypeScript API version, found ${tsc6Version}`);
  }
}

if (failures.length > 0) {
  for (const message of failures) {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
}
process.stdout.write(`toolchain ok: node ${process.versions.node}, pnpm ${pnpmVersion}, tsc ${tscVersion}, typescript API ${typescript.version}, peer ${peerRange}\n`);

function major(version) {
  return version.split('.')[0] ?? '';
}
