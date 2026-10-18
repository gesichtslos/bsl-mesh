export const HOOK_MARKER: string;

export function installGitHooks(options?: {
  root?: string;
  gitDir?: string;
  hookSourceDir?: string;
}): { installed: string[]; skipped: string[] };
