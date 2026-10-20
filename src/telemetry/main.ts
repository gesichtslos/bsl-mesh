import { pathToFileURL } from 'node:url';

import { runTelemetryCli } from './cli.js';

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const stdin = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1_000_000) {
        resolve('');
      }
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
  const code = await runTelemetryCli(process.argv.slice(2), process.env, stdin, (line) => {
    process.stdout.write(line);
  });
  process.exit(code);
}
