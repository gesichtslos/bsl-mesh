export type ToolchainCompatibility = {
  compilerVersion: string;
  apiVersion: string;
  peerRange: string;
};

export function satisfiesPeerRange(version: string, range: string): boolean {
  const alternatives = range.split('||').map((clause) => clause.trim()).filter((clause) => clause !== '');
  if (alternatives.length === 0) {
    return false;
  }
  return alternatives.some((clause) => satisfiesClause(version, clause));
}

export function assessToolchainCompatibility(input: ToolchainCompatibility): string | undefined {
  if (!satisfiesPeerRange(input.apiVersion, input.peerRange)) {
    return `typescript API ${input.apiVersion} does not satisfy ${input.peerRange}`;
  }
  return undefined;
}

function satisfiesClause(version: string, clause: string): boolean {
  const comparators = clause.split(/\s+/).filter((part) => part !== '');
  if (comparators.length === 0) {
    return false;
  }
  return comparators.every((comparator) => satisfiesComparator(version, comparator));
}

function satisfiesComparator(version: string, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator);
  if (!match) {
    return false;
  }
  const operator = match[1] ?? '=';
  const expected = match[2];
  if (expected === undefined) {
    return false;
  }
  const comparison = compareVersions(version, expected);
  if (operator === '>=') {
    return comparison >= 0;
  }
  if (operator === '<=') {
    return comparison <= 0;
  }
  if (operator === '>') {
    return comparison > 0;
  }
  if (operator === '<') {
    return comparison < 0;
  }
  return comparison === 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function numericParts(version: string): number[] {
  const core = /^(\d+(?:\.\d+){0,2})/.exec(version)?.[1] ?? '';
  return core.split('.').filter((part) => part !== '').map((part) => Number(part));
}
