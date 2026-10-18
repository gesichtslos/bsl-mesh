import { readFileSync } from 'node:fs';

import * as z from 'zod/v4';
import { expect, test } from 'vitest';

import {
  addEvidenceObject,
  feedInput,
  getCaseInput,
  publishCaseInput,
  searchInput,
} from '../src/mcp/schemas.js';

const published = JSON.parse(readFileSync(new URL('../docs/schemas/mcp-tools.schema.json', import.meta.url), 'utf8')) as {
  tools: Record<string, unknown>;
};

test('checked-in MCP tool schemas match the Zod inputs', () => {
  expect(published['tools']).toEqual({
    bslmesh_search_knowledge: z.toJSONSchema(searchInput),
    bslmesh_get_case: z.toJSONSchema(getCaseInput),
    bslmesh_get_feed: z.toJSONSchema(feedInput),
    bslmesh_publish_case: z.toJSONSchema(publishCaseInput),
    bslmesh_add_evidence: z.toJSONSchema(addEvidenceObject),
  });
});

test('publish and evidence schemas reject client-supplied source_kind', () => {
  const publishedCase = publishCaseInput.safeParse({
    type: 'incident',
    title: 'Пример',
    summary: 'Синтетическое описание.',
    topic: 'ordinary-forms',
    context: {
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
    },
    claims: [{ text: 'Утверждение.' }],
    idempotency_key: 'synthetic-key',
    source_kind: 'organic',
  });
  expect(publishedCase.success).toBe(false);
  const evidence = addEvidenceObject.safeParse({
    claim_id: '00000000-0000-7000-8000-000000000001',
    relation: 'supports',
    result: 'failure',
    method: 'Метод длиннее двадцати символов.',
    observation: 'Наблюдение длиннее двадцати символов.',
    context: {
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
    },
    idempotency_key: 'synthetic-key',
    source_kind: 'organic',
  });
  expect(evidence.success).toBe(false);
});
