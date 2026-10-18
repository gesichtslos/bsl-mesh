import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const HOOK_MARKER = '# bsl-mesh-publication-hook';

export function installGitHooks({
  root = process.cwd(),
  gitDir = path.join(root, '.git'),
  hookSourceDir = path.join(root, 'scripts/hooks'),
} = {}) {
  if (!existsSync(gitDir)) {
    return { installed: [], skipped: [] };
  }
  const hooksDir = path.join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const name of ['pre-commit', 'pre-push']) {
    const destination = path.join(hooksDir, name);
    if (existsSync(destination)) {
      const current = readFileSync(destination, 'utf8');
      if (!current.includes(HOOK_MARKER)) {
        skipped.push(name);
        process.stderr.write(
          `warning: .git/hooks/${name} already exists and was not installed by BSL Mesh. It was left unchanged.\n`,
        );
        continue;
      }
    }
    copyFileSync(path.join(hookSourceDir, name), destination);
    chmodSync(destination, 0o755);
    installed.push(name);
  }
  return { installed, skipped };
}

if (process.argv[1]?.endsWith('install-git-hooks.mjs') === true) {
  installGitHooks();
}
