import type { FastifyInstance } from 'fastify';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';

import type { AppConfig } from '../config.js';
import { IdentityError } from '../identity/errors.js';
import type { IdentityService } from '../identity/service.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { anonymousRateKey } from '../knowledge/rate-key.js';
import { buildMcpServer } from './tools.js';

export function registerMcpRoute(
  app: FastifyInstance,
  input: {
    knowledge: KnowledgeService;
    identity: IdentityService;
    pool: import('pg').Pool;
    config: AppConfig;
    now: () => Date;
  },
): void {
  const handler = createMcpHandler((ctx) => buildMcpServer({
    authInfo: ctx.authInfo,
    knowledge: input.knowledge,
    pool: input.pool,
    config: input.config,
    now: input.now,
  }), { legacy: 'reject' });
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] !== '/mcp') {
      return;
    }
    await validateHost(request, reply);
    if (reply.sent) {
      return;
    }
    await validateOrigin(request, reply);
  });
  app.addHook('onClose', async () => {
    await handler.close();
  });
  app.all('/mcp', async (request, reply) => {
    reply.hijack();
    const header = request.headers.authorization;
    let authInfo: AuthInfo;
    if (header === undefined) {
      authInfo = {
        token: '',
        clientId: 'anonymous',
        scopes: [],
        extra: { anonymous: true, clientKey: anonymousRateKey(request.ip) },
      };
    } else if (!header.startsWith('Bearer ')) {
      writeJsonRpcError(reply.raw, 'Credentials are not valid.');
      return;
    } else {
      try {
        const principal = await input.identity.authenticateAgent(header.slice('Bearer '.length), { rateLimit: false });
        authInfo = {
          token: header.slice('Bearer '.length),
          clientId: principal.agentId,
          scopes: [...principal.scopes],
          expiresAt: Math.floor(principal.expiresAt.getTime() / 1000),
          extra: {
            anonymous: false,
            clientKey: anonymousRateKey(request.ip),
            ownerId: principal.ownerId,
          },
        };
      } catch (error) {
        if (error instanceof IdentityError) {
          writeJsonRpcError(reply.raw, error.detail);
          return;
        }
        writeJsonRpcError(reply.raw, 'Unexpected error.');
        return;
      }
    }
    const raw = Object.assign(request.raw, { auth: authInfo });
    await nodeHandler(raw as Parameters<typeof nodeHandler>[0], reply.raw, request.body);
  });
}

function writeJsonRpcError(raw: NodeJS.WritableStream & { writeHead?: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, detail: string): void {
  raw.writeHead?.(401, { 'content-type': 'application/json' });
  raw.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: detail },
    id: null,
  }));
}
