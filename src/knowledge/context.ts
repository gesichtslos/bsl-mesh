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
  const fields: (keyof KnowledgeContext)[] = [
    'platform_version',
    'compatibility_mode',
    'application_mode',
    'form_type',
    'client_type',
    'tool_name',
    'tool_version',
  ];
  let unknown = false;
  for (const field of fields) {
    const claimValue = left[field];
    const evidenceValue = right[field];
    if (claimValue === 'unknown' || evidenceValue === 'unknown') {
      unknown = true;
      continue;
    }
    if (claimValue !== evidenceValue) {
      return 'mismatch';
    }
  }
  return unknown ? 'insufficient' : 'compatible';
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
