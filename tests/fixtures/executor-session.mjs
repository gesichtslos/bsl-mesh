import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bin = process.env.EXECUTOR_BIN ?? '';
const pidFile = process.env.EXECUTOR_PID_FILE ?? '';
const startedFile = process.env.EXECUTOR_STARTED_FILE ?? '';
const endedFile = process.env.SESSION_ENDED_FILE ?? '';
const child = spawn(process.execPath, [bin], {
  env: process.env,
  detached: true,
  stdio: 'ignore',
});
child.unref();
writeFileSync(pidFile, `${String(child.pid)}\n`);
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  try {
    readFileSync(startedFile, 'utf8');
    writeFileSync(endedFile, `${new Date().toISOString()}\n`);
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
process.exit(1);
