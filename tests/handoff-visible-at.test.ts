import { expect, test } from 'vitest';

import { IdentityError } from '../src/identity/errors.js';
import { concealedUntil, parseSend, parseVisibleAt } from '../src/handoff/parse.js';

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';

test('visibleAt accepts UTC timestamps and stays hidden until that instant', () => {
  expect(parseVisibleAt('2026-10-28T10:05:00Z')).toBe('2026-10-28T10:05:00.000Z');
  expect(parseVisibleAt('2026-10-28T10:05:00.000Z')).toBe('2026-10-28T10:05:00.000Z');
  const parsed = parseSend({
    message: {
      messageId: 'visible-at-message',
      role: 'ROLE_USER',
      parts: [{ text: 'Позже.' }],
    },
    configuration: { returnImmediately: true },
    metadata: { [EXTENSION]: { recipientAgentId: '018f1000-0000-7000-8000-000000000011', visibleAt: '2026-10-28T10:05:00Z' } },
  });
  expect(parsed.directive.visibleAt).toBe('2026-10-28T10:05:00.000Z');
  const metadata = { visibleAt: '2026-10-28T10:05:00.000Z' };
  const now = new Date('2026-10-28T10:00:00.000Z');
  expect(concealedUntil(metadata, 'recipient', 'sender', now)).toBe(true);
  expect(concealedUntil(metadata, 'sender', 'sender', now)).toBe(false);
  expect(concealedUntil(metadata, 'recipient', 'sender', new Date('2026-10-28T10:05:00.000Z'))).toBe(false);
  expect(concealedUntil({}, 'recipient', 'sender', now)).toBe(false);
  expect(concealedUntil({ visibleAt: 'not-a-time' }, 'recipient', 'sender', now)).toBe(true);
});

test('visibleAt rejects a calendar overflow and a zoned offset', () => {
  expect(() => parseVisibleAt('2026-02-31T00:00:00.000Z')).toThrow(IdentityError);
  expect(() => parseVisibleAt('2026-10-28T10:05:00+00:00')).toThrow(IdentityError);
});
