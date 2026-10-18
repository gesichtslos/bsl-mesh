import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';
import type { ContextMatch } from './status.js';

const APPLICATION_MODES = ['ordinary', 'managed', 'unknown'] as const;
const FORM_TYPES = ['ordinary', 'managed', 'unknown'] as const;
const CLIENT_TYPES = ['thick', 'thin', 'web', 'unknown'] as const;
const TOKEN = /^[A-Za-z0-9.*_:+-]{1,40}$/;
const TOOL = /^[A-Za-z0-9._:+-]{1,80}$/;

export type KnowledgeContext = {
  platform_version: string;
  compatibility_mode: string;
  application_mode: (typeof APPLICATION_MODES)[number];
  form_type: (typeof FORM_TYPES)[number];
  client_type: (typeof CLIENT_TYPES)[number];
  os: string;
  dbms: string;
  configuration_family: string;
  tool_name: string;
  tool_version: string;
};

export function parseContext(value: unknown): KnowledgeContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'platform_version',
    'compatibility_mode',
    'application_mode',
    'form_type',
    'client_type',
    'os',
    'dbms',
    'configuration_family',
    'tool_name',
    'tool_version',
  ];
  if (Object.keys(record).some((key) => !expected.includes(key))) {
    throw invalid();
  }
  return {
    platform_version: token(record['platform_version'], TOKEN),
    compatibility_mode: token(record['compatibility_mode'], TOKEN),
    application_mode: choice(record['application_mode'], APPLICATION_MODES),
    form_type: choice(record['form_type'], FORM_TYPES),
    client_type: choice(record['client_type'], CLIENT_TYPES),
    os: token(record['os'], TOKEN),
    dbms: token(record['dbms'], TOKEN),
    configuration_family: token(record['configuration_family'], TOKEN),
    tool_name: token(record['tool_name'], TOOL),
    tool_version: token(record['tool_version'], TOKEN),
  };
}

export function compareContext(left: KnowledgeContext, right: KnowledgeContext): ContextMatch {
  const parts = [
    exactField(left.application_mode, right.application_mode),
    exactField(left.form_type, right.form_type),
    exactField(left.client_type, right.client_type),
    exactField(left.os, right.os),
    exactField(left.dbms, right.dbms),
    exactField(left.configuration_family, right.configuration_family),
    exactField(left.tool_name, right.tool_name),
    versionField(left.platform_version, right.platform_version, 3),
    versionField(left.compatibility_mode, right.compatibility_mode, 3),
    versionField(left.tool_version, right.tool_version, 2),
  ];
  if (parts.includes('mismatch')) {
    return 'mismatch';
  }
  if (parts.includes('insufficient')) {
    return 'insufficient';
  }
  return 'compatible';
}

function exactField(left: string, right: string): ContextMatch {
  if (left === 'unknown' || right === 'unknown') {
    return 'insufficient';
  }
  return left === right ? 'compatible' : 'mismatch';
}

function versionField(left: string, right: string, minimumShared: number): ContextMatch {
  if (left === 'unknown' || right === 'unknown') {
    return 'insufficient';
  }
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts === null || rightParts === null) {
    return left === right ? 'compatible' : 'mismatch';
  }
  const shared = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return 'mismatch';
    }
  }
  if (leftParts.length === rightParts.length || shared >= minimumShared) {
    return 'compatible';
  }
  return 'insufficient';
}

function versionParts(value: string): number[] | null {
  const trimmed = value.endsWith('.x') ? value.slice(0, -2) : value;
  if (trimmed === '' || trimmed.endsWith('.')) {
    return null;
  }
  const parts = trimmed.split('.');
  if (parts.some((part) => !/^[0-9]+$/.test(part))) {
    return null;
  }
  return parts.map((part) => Number(part));
}

function invalid(): IdentityError {
  return new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
}

function token(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || value === 'unknown') {
    if (value === 'unknown') {
      return value;
    }
    throw invalid();
  }
  if (!pattern.test(value)) {
    throw invalid();
  }
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string') {
    throw invalid();
  }
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw invalid();
  }
  return match;
}
