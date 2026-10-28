import { appendFileSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8').trim();
  const countFile = process.env.EXECUTOR_COUNT_FILE;
  if (countFile !== undefined && countFile !== '') {
    appendFileSync(countFile, '1\n');
  }
  process.stdout.write(`done:${text}\n`);
});
