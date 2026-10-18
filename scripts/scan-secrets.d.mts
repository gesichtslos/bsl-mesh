export type SecretFinding = {
  path: string;
  line: number;
  rule: string;
};

export function scanText(text: string, filePath?: string): SecretFinding[];
export function formatFindings(findings: SecretFinding[]): string[];
export function cleanScanMessage(fileCount: number): string;
export function scanFiles(files: string[]): SecretFinding[];
export function scanStaged(cwd?: string): { findings: SecretFinding[]; count: number };
export function scanPushRange(
  remoteSha: string,
  localSha: string,
  cwd?: string,
): { findings: SecretFinding[]; count: number };
