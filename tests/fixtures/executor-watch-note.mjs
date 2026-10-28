import { appendFileSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const file = process.env.EXECUTOR_NOTE_FILE ?? '';
  appendFileSync(file, `${Buffer.concat(chunks).toString('utf8')}\n`);
  process.stdout.write('noted\n');
});
