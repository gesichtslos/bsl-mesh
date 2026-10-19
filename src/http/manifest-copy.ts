import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readSecurityManifest(): Promise<string> {
  const file = path.resolve(process.cwd(), 'docs/08-CLIENT-SECURITY-MANIFEST.md');
  return readFile(file, 'utf8');
}
