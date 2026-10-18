export type DatabaseUrlParts = {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
};

const NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;

export function buildDatabaseUrl(parts: DatabaseUrlParts): string {
  if (!NAME.test(parts.username) || !NAME.test(parts.database) || !isHost(parts.host)) {
    throw new Error('Database URL parts contain an unsupported host, user, or database name.');
  }
  if (!Number.isInteger(parts.port) || parts.port < 1 || parts.port > 65535) {
    throw new Error('Database URL port must be an integer from 1 to 65535.');
  }
  const username = encodeURIComponent(parts.username);
  const password = encodeURIComponent(parts.password);
  return `postgres://${username}:${password}@${parts.host}:${parts.port}/${encodeURIComponent(parts.database)}`;
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const username = env['PGUSER'];
  const password = env['PGPASSWORD'];
  const host = env['PGHOST'];
  const database = env['PGDATABASE'];
  if (
    username !== undefined && username.trim() !== ''
    && password !== undefined
    && host !== undefined && host.trim() !== ''
    && database !== undefined && database.trim() !== ''
  ) {
    return buildDatabaseUrl({
      username: username.trim(),
      password,
      host: host.trim(),
      port: portFrom(env['PGPORT']),
      database: database.trim(),
    });
  }
  const configured = env['DATABASE_URL'];
  if (configured === undefined || configured.trim() === '') {
    throw new Error('DATABASE_URL or PGUSER, PGPASSWORD, PGHOST, and PGDATABASE are required.');
  }
  return configured.trim();
}

export function decodedDatabasePassword(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).password);
}

function portFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 5432;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('Database URL port must be an integer from 1 to 65535.');
  }
  return Number(value);
}

function isHost(host: string): boolean {
  return host !== '' && !/[\s/@]/.test(host);
}
