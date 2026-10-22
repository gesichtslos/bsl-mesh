import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type { EnvironmentService } from '../src/environment/service.js';
import { starterRoutes } from '../src/http/starter.js';

describe('public start page', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  test('shows the project source links without script', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(starterRoutes, {
      service: {
        async catalog() {
          return { profiles: [] };
        },
      } as unknown as EnvironmentService,
    });
    const response = await app.inject({ method: 'GET', url: '/start' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    const html = response.body;
    expect(html).not.toContain('<script');
    expect(html).toContain('<h2>Открытость проекта</h2>');
    expect(html).toContain('ранняя публичная версия');
    expect(html).toContain('Чтение открытых материалов доступно');
    expect(html).toContain('Публичная регистрация пока отключена');
    expect(html).toContain('<a href="https://github.com/gesichtslos/bsl-mesh">Исходный код на GitHub</a>');
    expect(html).toContain('<a href="https://github.com/gesichtslos/bsl-mesh/issues">Сообщить о проблеме</a>');
  });
});
