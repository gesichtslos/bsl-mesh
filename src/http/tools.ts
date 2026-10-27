import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { IdentityError } from '../identity/errors.js';
import { anonymousRateKey } from '../knowledge/rate-key.js';
import { LINUX_PACKAGE, MANIFEST_PATH, ToolReleaseError, WINDOWS_PACKAGE, loadToolRelease } from '../tools/release.js';
import { problem, problemSchema } from './problem.js';

const problems = { 404: problemSchema, 429: problemSchema, 503: problemSchema } as const;

function bearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,200})$/.exec(header);
  return match?.[1] ?? null;
}

export const toolReleaseRoutes: FastifyPluginAsync<{
  directory: string;
  guard: (request: FastifyRequest) => Promise<void>;
}> = async (app, options) => {
  app.get(MANIFEST_PATH, { schema: { response: { 404: problems[404], 429: problems[429], 503: problems[503] } } }, async (request, reply) => {
    await options.guard(request);
    const release = await loadToolRelease(options.directory);
    return reply
      .type('application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=60')
      .header('etag', `"${release.manifest.packages.map((item) => item.sha256).join('')}"`)
      .send(release.manifest);
  });

  for (const [packageName, osName] of [[LINUX_PACKAGE, 'linux'], [WINDOWS_PACKAGE, 'windows']] as const) {
    app.get(`/agent/tools/${packageName}`, { schema: { response: { 404: problems[404], 429: problems[429], 503: problems[503] } } }, async (request, reply) => {
      await options.guard(request);
      const release = await loadToolRelease(options.directory);
      const bytes = release.packages[osName];
      const record = release.manifest.packages.find((item) => item.os === osName);
      return reply
        .type('application/zip')
        .header('cache-control', 'public, max-age=3600')
        .header('etag', `"${record?.sha256 ?? ''}"`)
        .header('content-disposition', `attachment; filename="${packageName}"`)
        .send(bytes);
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ToolReleaseError || error instanceof IdentityError) {
      for (const [name, value] of Object.entries(error instanceof IdentityError ? error.headers : {})) {
        reply.header(name, value);
      }
      const status = error instanceof ToolReleaseError ? error.statusCode : error.statusCode;
      const title = status === 429 ? 'Too Many Requests' : status === 404 ? 'Not Found' : 'Service Unavailable';
      return reply.code(status).type('application/problem+json').send(problem(status, title, error.message, request.id));
    }
    throw error;
  });
};

export function anonymousToolGuard(input: {
  limit: (clientKey: string) => Promise<void>;
  authenticate: (accessToken: string) => Promise<void>;
}): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const accessToken = bearer(request.headers.authorization);
    if (accessToken === null) {
      await input.limit(anonymousRateKey(request.ip));
      return;
    }
    await input.authenticate(accessToken);
  };
}
