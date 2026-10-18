import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { redactDatabaseUrl } from './db/redact.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const result = await migrate(pool);
    process.stdout.write(`${JSON.stringify({ applied: result.applied, skipped: result.skipped })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = redactDatabaseUrl(error instanceof Error ? error.message : 'migration failed');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
