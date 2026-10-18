import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { redactDatabaseUrl } from './db/redact.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  const message = redactDatabaseUrl(error instanceof Error ? error.message : 'startup failed');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
