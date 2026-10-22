import { resolveDatabaseUrl } from './db/database-url.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];

export type OidcConfig = {
  issuer: string;
  clientId: string;
};

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  nodeEnv: NodeEnv;
  authPublicRegistration: false;
  authTestAdapter: boolean;
  oidc: OidcConfig | null;
  rateLimitAgentPerMinute: number;
  rateLimitOwnerPerMinute: number;
  rateLimitPublicPerMinute: number;
  knowledgeSourceKind: 'organic' | 'synthetic' | 'import';
  registryDemonstration: boolean;
  publicHostname: string | null;
  trustProxyHops: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = requiredEnum(env, 'NODE_ENV', NODE_ENVS);
  return {
    host: requiredText(env, 'HOST'),
    port: requiredPort(env),
    databaseUrl: requiredDatabaseUrl(env),
    logLevel: requiredEnum(env, 'LOG_LEVEL', LOG_LEVELS),
    nodeEnv,
    authPublicRegistration: closedPublicRegistration(env),
    authTestAdapter: readTestAdapter(env, nodeEnv),
    oidc: readOidc(env),
    rateLimitAgentPerMinute: readLimit(env, 'RATE_LIMIT_AGENT_PER_MINUTE', 60),
    rateLimitOwnerPerMinute: readLimit(env, 'RATE_LIMIT_OWNER_PER_MINUTE', 120),
    rateLimitPublicPerMinute: readLimit(env, 'RATE_LIMIT_PUBLIC_PER_MINUTE', 120),
    knowledgeSourceKind: readSourceKind(env, nodeEnv),
    registryDemonstration: env['REGISTRY_DEMONSTRATION']?.trim() === 'enabled',
    publicHostname: readPublicHostname(env),
    trustProxyHops: readProxyHops(env),
  };
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${name} is required.`);
  }
  return value.trim();
}

function requiredPort(env: NodeJS.ProcessEnv): number {
  const raw = requiredText(env, 'PORT');
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError('PORT must be an integer from 1 to 65535.');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  try {
    const value = resolveDatabaseUrl(env);
    if (!/^postgres(?:ql)?:\/\//.test(value)) {
      throw new ConfigError('DATABASE_URL must be a postgres URL.');
    }
    return value;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(error instanceof Error ? error.message : 'DATABASE_URL is required.');
  }
}

function closedPublicRegistration(env: NodeJS.ProcessEnv): false {
  const value = env['AUTH_PUBLIC_REGISTRATION']?.trim() ?? '';
  if (value === '' || value === 'false') {
    return false;
  }
  throw new ConfigError(
    'Public registration cannot be enabled until a reviewed identity provider is configured.',
  );
}

function readTestAdapter(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): boolean {
  const value = env['AUTH_TEST_ADAPTER']?.trim() ?? '';
  if (value === '' || value === 'disabled') {
    return false;
  }
  if (value !== 'enabled') {
    throw new ConfigError('AUTH_TEST_ADAPTER must be enabled or disabled.');
  }
  if (nodeEnv === 'production') {
    throw new ConfigError('AUTH_TEST_ADAPTER cannot be enabled when NODE_ENV is production.');
  }
  return true;
}

function readLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer from 1 to 100000.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new ConfigError(`${name} must be an integer from 1 to 100000.`);
  }
  return value;
}

function readSourceKind(
  env: NodeJS.ProcessEnv,
  nodeEnv: NodeEnv,
): 'organic' | 'synthetic' | 'import' {
  const value = env['KNOWLEDGE_SOURCE_KIND']?.trim() ?? '';
  if (value === '') {
    return nodeEnv === 'production' ? 'organic' : 'synthetic';
  }
  if (value === 'organic' || value === 'synthetic' || value === 'import') {
    return value;
  }
  throw new ConfigError('KNOWLEDGE_SOURCE_KIND must be organic, synthetic, or import.');
}

function readPublicHostname(env: NodeJS.ProcessEnv): string | null {
  const value = env['PUBLIC_HOSTNAME']?.trim() ?? '';
  if (value === '') {
    return null;
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(value)) {
    throw new ConfigError('PUBLIC_HOSTNAME must be a DNS name without a scheme, port, or path.');
  }
  return value;
}

function readProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env['TRUST_PROXY_HOPS']?.trim() ?? '';
  if (raw === '') {
    return 0;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError('TRUST_PROXY_HOPS must be an integer from 0 to 2.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new ConfigError('TRUST_PROXY_HOPS must be an integer from 0 to 2.');
  }
  return value;
}

function readOidc(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuerRaw = env['AUTH_OIDC_ISSUER']?.trim() ?? '';
  const clientRaw = env['AUTH_OIDC_CLIENT_ID']?.trim() ?? '';
  if (issuerRaw === '' && clientRaw === '') {
    return null;
  }
  if (issuerRaw === '' || clientRaw === '') {
    throw new ConfigError('AUTH_OIDC_ISSUER and AUTH_OIDC_CLIENT_ID must be set together.');
  }
  let issuer: URL;
  try {
    issuer = new URL(issuerRaw);
  } catch {
    throw new ConfigError('AUTH_OIDC_ISSUER must be an https URL.');
  }
  if (
    issuer.protocol !== 'https:'
    || issuer.username !== ''
    || issuer.password !== ''
    || issuer.search !== ''
    || issuer.hash !== ''
  ) {
    throw new ConfigError('AUTH_OIDC_ISSUER must be an https URL without credentials, query, or fragment.');
  }
  if (!/^[A-Za-z0-9._~-]{1,200}$/.test(clientRaw)) {
    throw new ConfigError('AUTH_OIDC_CLIENT_ID contains unsupported characters.');
  }
  const pathname = issuer.pathname.replace(/\/$/, '');
  return { issuer: `${issuer.origin}${pathname}`, clientId: clientRaw };
}

function requiredEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T {
  const value = requiredText(env, name);
  const match = allowed.find((item) => item === value);
  if (!match) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return match;
}
