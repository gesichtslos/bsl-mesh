export type SecretFinding = {
  path: string;
  line: number;
  rule: string;
};

export function scanText(text: string, filePath?: string): SecretFinding[];
export function formatFindings(findings: SecretFinding[]): string[];
export function cleanScanMessage(fileCount: number): string;
export function scanFiles(files: string[]): SecretFinding[];
