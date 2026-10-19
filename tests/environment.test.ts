import { expect, test } from 'vitest';

import { matchProfile } from '../src/environment/match.js';
import { assertSafeHttpsUrl } from '../src/environment/urls.js';
import { escapeHtml } from '../src/http/html.js';
import { IdentityError } from '../src/identity/errors.js';

const ordinary = {
  task_families: ['ordinary-forms'],
  form_types: ['ordinary'],
  client_types: ['thick'],
  ides: null,
  os_families: null,
  verified_client_versions: [] as string[],
};

test('ordinary-form profile is not confirmed for managed forms or an unknown version', () => {
  const managed = matchProfile(ordinary, { form_type: 'managed', client_type: 'thick', client_version: '8.3.27' });
  expect(managed.applicability).toBe('inapplicable');
  expect(managed.confirmed).toBe(false);
  const unknown = matchProfile(ordinary, { form_type: 'ordinary', client_type: 'thick', client_version: 'unknown' });
  expect(unknown.applicability).not.toBe('applicable');
  expect(unknown.confirmed).toBe(false);
  expect(unknown.unknowns).toContain('client_version');
});

test('public https upstreams are accepted and local targets are rejected', () => {
  expect(() => assertSafeHttpsUrl('https://github.com/gesichtslos/bsl-mesh')).not.toThrow();
  for (const value of [
    'http://github.com/gesichtslos/bsl-mesh',
    'https://127.0.0.1/mcp',
    'https://localhost/mcp',
    'https://169.254.169.254/latest',
    'https://10.0.0.5/mcp',
    'https://192.168.0.5/mcp',
    'file:///tmp/catalog.json',
  ]) {
    expect(() => assertSafeHttpsUrl(value)).toThrow(IdentityError);
  }
});

test('catalog html escapes embedded markup', () => {
  expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
});
