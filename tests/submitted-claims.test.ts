import { expect, test } from 'vitest';

import type { KnowledgeContext } from '../src/knowledge/context.js';
import { submittedClaimsMatch } from '../src/knowledge/submitted-claims.js';

const context: KnowledgeContext = {
  platform_version: '8.3.27',
  compatibility_mode: '8.3.19',
  application_mode: 'ordinary',
  form_type: 'ordinary',
  client_type: 'thick',
  os: 'Windows',
  dbms: 'unknown',
  configuration_family: 'custom',
  tool_name: 'unknown',
  tool_version: 'unknown',
};

const otherContext: KnowledgeContext = { ...context, form_type: 'managed' };

test('submitted claims match as a multiset, including reversed storage order', () => {
  const first = { text: 'Первое утверждение.', context, evidenceCount: 0 };
  const second = { text: 'Второе утверждение.', context, evidenceCount: 1 };
  const third = { text: 'Третье утверждение.', context, evidenceCount: 0 };
  const expected = [first, second, third];
  expect(submittedClaimsMatch(expected, [third, second, first])).toBe(true);
  expect(submittedClaimsMatch(
    [first, first, second],
    [second, first, first],
  )).toBe(true);
  expect(submittedClaimsMatch([first, first], [first])).toBe(false);
  expect(submittedClaimsMatch([first, first], [first, second])).toBe(false);
  expect(submittedClaimsMatch(expected, [first, { ...second, text: 'Изменённое утверждение.' }, third])).toBe(false);
  expect(submittedClaimsMatch(expected, [first, { ...second, evidenceCount: 2 }, third])).toBe(false);
  expect(submittedClaimsMatch(expected, [{ ...first, context: otherContext }, second, third])).toBe(false);
});
