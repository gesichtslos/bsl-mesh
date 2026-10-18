import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';

if (!existsSync('.git')) {
  process.exit(0);
}
mkdirSync('.git/hooks', { recursive: true });
copyFileSync('scripts/hooks/pre-commit', '.git/hooks/pre-commit');
chmodSync('.git/hooks/pre-commit', 0o755);
