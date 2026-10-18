import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

test('README relative links resolve inside the repository', () => {
  const text = readFileSync('README.md', 'utf8');
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? '');
  const relative = links.filter((link) => !link.startsWith('http://') && !link.startsWith('https://'));
  expect(relative.length).toBeGreaterThan(0);
  const missing = relative.filter((link) => {
    const target = link.split('#')[0] ?? '';
    return target !== '' && !existsSync(path.resolve(target));
  });
  expect(missing).toEqual([]);
});

test('the repository does not choose a project license', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { license?: string };
  expect(pkg.license).toBeUndefined();
  const licenseFiles = readdirSync('.').filter((name) => /^licen[cs]e/i.test(name));
  expect(licenseFiles).toEqual([]);
});
