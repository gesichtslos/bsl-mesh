import { createHash } from 'node:crypto';

import type { FastifyPluginAsync } from 'fastify';

import type { EnvironmentService } from '../environment/service.js';
import { QUICKSTART_MARKDOWN } from '../environment/quickstart.js';
import { anonymousRateKey } from '../knowledge/rate-key.js';
import { escapeHtml } from './html.js';
import { readSecurityManifest } from './manifest-copy.js';
import { problemSchema } from './problem.js';

const problems = { 404: problemSchema, 422: problemSchema, 429: problemSchema } as const;

function token(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,200})$/.exec(header);
  return match?.[1] ?? null;
}

function cache(body: unknown): { etag: string; payload: string } {
  const payload = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(payload, 'utf8').digest('hex')}"`;
  return { etag, payload };
}

export const starterRoutes: FastifyPluginAsync<{ service: EnvironmentService }> = async (app, options) => {
  const { service } = options;

  app.get('/start', async (request, reply) => {
    const catalog = await service.catalog({
      accessToken: token(request.headers.authorization),
      clientKey: anonymousRateKey(request.ip),
    });
    const profiles = Array.isArray(catalog['profiles']) ? catalog['profiles'] : [];
    const items = profiles.map((profile) => {
      const record = profile as { id?: unknown; summary?: unknown; status?: unknown; source_kind?: unknown };
      const id = typeof record.id === 'string' ? record.id : '';
      const summary = typeof record.summary === 'string' ? record.summary : '';
      const status = typeof record.status === 'string' ? record.status : '';
      const source = typeof record.source_kind === 'string' ? record.source_kind : '';
      return `<li><code>${escapeHtml(id)}</code> (${escapeHtml(status)}, ${escapeHtml(source)}): ${escapeHtml(summary)}</li>`;
    }).join('');
    const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>BSL Mesh</title></head>
<body>
<main>
<h1>BSL Mesh</h1>
<p>Попросите агента прочитать публичный каталог и сравнить профили локально. Не отправляйте проект, секреты или промпты.</p>
<h2>Открытость проекта</h2>
<p>Это ранняя публичная версия. Чтение открытых материалов доступно. Публичная регистрация пока отключена.</p>
<ul>
<li><a href="https://github.com/gesichtslos/bsl-mesh">Исходный код на GitHub</a></li>
<li><a href="https://github.com/gesichtslos/bsl-mesh/issues">Сообщить о проблеме</a></li>
</ul>
<h2>Куда читать дальше</h2>
<p>Эти адреса заданы явно. Их не нужно угадывать. Сервер ничего не устанавливает и не выдаёт права.</p>
<ul>
<li>MCP для публичного чтения: https://bslmesh.ru/mcp. Учётная запись для чтения не нужна. <a href="/agent/quickstart.md">Подключить MCP</a> — инструкция для Cursor. Сервер ничего не устанавливает.</li>
<li><a href="/api/v1/capabilities">Возможности API</a>: https://bslmesh.ru/api/v1/capabilities</li>
<li><a href="/api/v1/search">Поиск опубликованных кейсов</a>: https://bslmesh.ru/api/v1/search</li>
<li><a href="/agent/quickstart.md">Инструкция для агента</a></li>
<li><a href="/agent/security-manifest.md">Публичная копия манифеста безопасности</a></li>
<li><a href="/agent/starter-catalog.json">Каталог окружений</a></li>
<li><a href="/agent/catalog-signatures.json">Статус подписи каталога</a></li>
</ul>
<p>Объективно выбрать наиболее эффективное окружение пока нельзя: независимых измерений нет.</p>
<ul>${items}</ul>
</main>
</body>
</html>`;
    return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60').send(html);
  });

  app.get('/agent/quickstart.md', async (_request, reply) => {
    return reply.type('text/markdown; charset=utf-8').header('cache-control', 'public, max-age=60').send(QUICKSTART_MARKDOWN);
  });

  app.get('/agent/security-manifest.md', async (_request, reply) => {
    const text = await readSecurityManifest();
    return reply.type('text/markdown; charset=utf-8').header('cache-control', 'public, max-age=60').send(text);
  });

  app.get('/agent/catalog-signatures.json', async (_request, reply) => {
    const body = {
      schema_version: '0.2.0',
      signed: false,
      status: 'unsupported',
      detail: 'Catalog releases are not cryptographically signed. Do not invent a trust anchor from this response.',
    };
    const cached = cache(body);
    return reply
      .type('application/json; charset=utf-8')
      .header('etag', cached.etag)
      .header('cache-control', 'public, max-age=60')
      .send(body);
  });

  app.get('/agent/starter-catalog.json', async (request, reply) => {
    const body = await service.catalog({
      accessToken: token(request.headers.authorization),
      clientKey: anonymousRateKey(request.ip),
    });
    const digest = typeof body['content_sha256'] === 'string' ? body['content_sha256'] : '';
    const cached = { etag: `"${digest}"`, payload: '' };
    if (request.headers['if-none-match'] === cached.etag) {
      return reply.code(304).header('etag', cached.etag).header('cache-control', 'public, max-age=60').send();
    }
    return reply
      .type('application/json; charset=utf-8')
      .header('etag', cached.etag)
      .header('cache-control', 'public, max-age=60')
      .send(body);
  });

  app.get<{ Querystring: { limit?: string; include_withdrawn?: string } }>(
    '/api/v1/starter-profiles',
    { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => service.listProfiles({
      accessToken: token(request.headers.authorization),
      clientKey: anonymousRateKey(request.ip),
      limit: request.query.limit === undefined ? 20 : Number(request.query.limit),
      includeWithdrawn: request.query.include_withdrawn === 'true',
    }),
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/starter-profiles/:id/versions/:version',
    { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => service.getProfile({
      accessToken: token(request.headers.authorization),
      clientKey: anonymousRateKey(request.ip),
      profileId: request.params.id,
      version: request.params.version,
    }),
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/tool-versions/:id/versions/:version',
    { schema: { response: { 200: { type: 'object', additionalProperties: true }, ...problems } } },
    async (request) => service.getComponentVersion({
      accessToken: token(request.headers.authorization),
      clientKey: anonymousRateKey(request.ip),
      componentId: request.params.id,
      version: request.params.version,
    }),
  );
};
