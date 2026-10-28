import { appendFileSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const countFile = process.env.EXECUTOR_COUNT_FILE;
  if (countFile !== undefined && countFile !== '') {
    appendFileSync(countFile, '1\n');
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > 20_000) {
      clearInterval(timer);
      process.exit(2);
    }
  }, 100);
});
