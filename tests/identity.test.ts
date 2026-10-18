import { Writable } from 'node:stream';

import type { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { auditDetail } from '../src/identity/audit.js';
import { uuidV7 } from '../src/identity/ids.js';
import { createOneTimeCodeDelivery, describeIdentity, magicLinkRoute } from '../src/identity/provider.js';
import { retryAfterSeconds } from '../src/identity/rate-limit.js';
import { resolveScopes } from '../src/identity/scopes.js';
import { IdentityService } from '../src/identity/service.js';
import { hashToken } from '../src/identity/tokens.js';

const baseEnv = {
  HOST: '127.0.0.1',
  PORT: '3000',
  DATABASE_URL: 'postgres://bslmesh_dev:local@127.0.0.1:1/bslmesh_dev',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
};

function config(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...baseEnv, ...overrides });
}

describe('identity primitives', () => {
  test('issues time-ordered UUID v7 values', () => {
    const earlier = uuidV7(new Date('2026-10-18T00:00:00.000Z'));
    const later = uuidV7(new Date('2026-10-18T00:00:01.000Z'));
    expect(earlier[14]).toBe('7');
    expect('89ab').toContain(earlier[19]);
    expect(earlier < later).toBe(true);
  });

  test('hashes tokens without keeping the original value', () => {
    const token = 'bslm_agt_example-token-value';
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  test('defaults to read scopes and keeps write scopes independent', () => {
    expect(resolveScopes(undefined)).toEqual([
      'profile:read',
      'knowledge:read',
      'meetups:read',
      'tools:read',
    ]);
    expect(resolveScopes(['cases:write'])).toEqual(['cases:write']);
    expect(() => resolveScopes(['cases:write', 'cases:write'])).toThrow(/validation/i);
    expect(() => resolveScopes(['owner:write'])).toThrow(/validation/i);
  });

  test('drops secret-shaped fields from audit details', () => {
    expect(auditDetail({
      token: 'bslm_agt_example-token-value',
      magic_link_token: 'bslm_ml_example-token-value',
      scopes: ['cases:write'],
      reason: 'scope',
    })).toEqual({
      scopes: ['cases:write'],
      reason: 'scope',
    });
  });

  test('hides the test adapter in production', () => {
    const enabled = config({ AUTH_TEST_ADAPTER: 'enabled' });
    const production: AppConfig = { ...enabled, nodeEnv: 'production', authTestAdapter: true };
    expect(magicLinkRoute(production)).toBe('hidden');
    expect(createOneTimeCodeDelivery(production).mode).toBe('disabled');
    expect(describeIdentity(enabled)).toMatchObject({
      publicRegistration: 'disabled',
      magicLink: 'test',
      oidc: 'not_configured',
    });
    const configured = config({
      AUTH_OIDC_ISSUER: 'https://idp.example.test/realms/synthetic',
      AUTH_OIDC_CLIENT_ID: 'synthetic-client',
    });
    expect(describeIdentity(configured).oidc).toBe('not_implemented');
    expect(describeIdentity(configured).publicRegistration).toBe('disabled');
    expect(retryAfterSeconds(new Date('2026-10-18T00:00:30.000Z'))).toBe(30);
  });

  test('does not touch the database when the test adapter is unavailable', async () => {
    const calls: string[] = [];
    const pool = {
      connect() {
        calls.push('connect');
        throw new Error('database used');
      },
    } as unknown as Pool;
    const service = new IdentityService(pool, { ...config(), nodeEnv: 'production', authTestAdapter: true });
    await expect(service.issueTestMagicLink({
      email: 'owner-a@example.test',
      displayName: 'Synthetic Owner',
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.consumeMagicLink({
      token: 'bslm_ml_example-token-value-not-a-real-secret',
      requestId: 'req-synthetic',
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toEqual([]);
  });
});

describe('identity http guards', () => {
  test('does not register magic-link routes in production', async () => {
    const app = await buildApp({ ...config({ AUTH_TEST_ADAPTER: 'enabled' }), nodeEnv: 'production', authTestAdapter: true });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: { email: 'owner-a@example.test', display_name: 'Synthetic Owner' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ status: 404 });
      expect(JSON.stringify(response.json())).not.toContain('magic_link_token');
    } finally {
      await app.close();
    }
  });

  test('keeps registration closed without the test adapter and rejects a password field', async () => {
    const password = 'synthetic-password-value';
    const app = await buildApp(config({ AUTH_TEST_ADAPTER: 'disabled' }));
    try {
      const closed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: { email: 'owner-a@example.test', display_name: 'Synthetic Owner' },
      });
      expect(closed.statusCode).toBe(403);
      expect(closed.json()).toMatchObject({ detail: 'Public registration is disabled.' });

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link',
        payload: {
          email: 'owner-a@example.test',
          display_name: 'Synthetic Owner',
          password,
        },
      });
      expect(rejected.statusCode).toBe(400);
      const body = JSON.stringify(rejected.json());
      expect(body).not.toContain(password);
      expect(body).not.toContain('node:internal');
    } finally {
      await app.close();
    }
  });

  test('redacts token fields in structured logs', async () => {
    const secret = 'bslm_agt_example-token-value';
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = await buildApp(config(), { logStream });
    try {
      app.log.info({
        token: secret,
        magic_link_token: secret,
        session_token: secret,
        req: { body: { token: secret } },
      }, 'identity log');
      const logged = lines.join('\n');
      expect(logged).not.toContain(secret);
      expect(logged).toContain('[Redacted]');
    } finally {
      await app.close();
    }
  });
});
