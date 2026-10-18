const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
  nodeEnv: NodeEnv;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: requiredText(env, 'HOST'),
    port: requiredPort(env),
    databaseUrl: requiredDatabaseUrl(env),
    logLevel: requiredEnum(env, 'LOG_LEVEL', LOG_LEVELS),
    nodeEnv: requiredEnum(env, 'NODE_ENV', NODE_ENVS),
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
  const value = requiredText(env, 'DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//.test(value)) {
    throw new ConfigError('DATABASE_URL must be a postgres URL.');
  }
  return value;
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
