import { ensureApplicationRole, publicRoleError } from './db/ensure-roles.js';

ensureApplicationRole(process.env).then(() => {
  process.stdout.write('ensured application database role\n');
}).catch((error: unknown) => {
  process.stderr.write(`${publicRoleError(error)}\n`);
  process.exitCode = 1;
});
