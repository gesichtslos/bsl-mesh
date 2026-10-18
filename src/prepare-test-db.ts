import { prepareTestDatabase, publicPrepareError } from './db/prepare-test-database.js';

prepareTestDatabase(process.env).then(() => {
  process.stdout.write('prepared disposable test database\n');
}).catch((error: unknown) => {
  process.stderr.write(`${publicPrepareError(error)}\n`);
  process.exitCode = 1;
});
