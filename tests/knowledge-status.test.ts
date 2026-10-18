import { describe, expect, test } from 'vitest';

import { compareContext } from '../src/knowledge/context.js';
import { assessEvidence, evaluateClaim } from '../src/knowledge/status.js';
import { untrustedText } from '../src/knowledge/text.js';

const author = 'owner-author';
const other = 'owner-other';

const support = {
  authorOwnerId: other,
  sourceKind: 'organic' as const,
  relation: 'supports' as const,
  result: 'success' as const,
  contextMatch: 'compatible' as const,
  substantive: true,
};

describe('claim assessment', () => {
  test('does not treat the author or synthetic evidence as reproduction', () => {
    expect(evaluateClaim({
      authorOwnerId: author,
      claimSourceKind: 'organic',
      evidence: [{ ...support, authorOwnerId: author }],
    })).toMatchObject({ status: 'supported', classification: 'real_evidence' });

    expect(evaluateClaim({
      authorOwnerId: author,
      claimSourceKind: 'synthetic',
      evidence: [support],
    })).toEqual({
      status: 'reported',
      confidence: 'insufficient_evidence',
      classification: 'synthetic',
    });

    expect(assessEvidence({
      claimAuthorOwnerId: author,
      evidenceAuthorOwnerId: author,
      claimText: 'Форма не открывается после статической проверки',
      method: 'Повторно открыл обезличенный пример в толстом клиенте.',
      observation: 'Окно формы не появилось, платформа вернула ошибку открытия.',
      sourceKind: 'organic',
      relation: 'supports',
      result: 'failure',
      contextMatch: 'compatible',
    })).toMatchObject({ actorIndependent: false, countsAsReproduction: false });
  });

  test('keeps a negative result visible as a contest and ignores repeated text', () => {
    const claim = 'Форма не открывается после статической проверки';
    expect(evaluateClaim({
      authorOwnerId: author,
      claimSourceKind: 'organic',
      evidence: [support, { ...support, relation: 'refutes', result: 'failure' }],
    }).status).toBe('contested');
    expect(evaluateClaim({
      authorOwnerId: author,
      claimSourceKind: 'organic',
      evidence: [support],
    }).status).toBe('reproduced');
    expect(assessEvidence({
      claimAuthorOwnerId: author,
      evidenceAuthorOwnerId: other,
      claimText: claim,
      method: claim,
      observation: 'Окно формы не появилось, платформа вернула ошибку открытия.',
      sourceKind: 'organic',
      relation: 'supports',
      result: 'failure',
      contextMatch: 'compatible',
    }).substantive).toBe(false);
  });

  test('does not treat a context mismatch or unknown tool as compatibility', () => {
    const base = {
      platform_version: '8.3.27',
      compatibility_mode: '8.3.19',
      application_mode: 'ordinary' as const,
      form_type: 'ordinary' as const,
      client_type: 'thick' as const,
      os: 'Windows',
      dbms: 'unknown',
      configuration_family: 'custom',
      tool_name: 'bsl-language-server',
      tool_version: '0.24.0',
    };
    expect(compareContext(base, { ...base, form_type: 'managed' })).toBe('mismatch');
    expect(compareContext(base, { ...base, tool_version: 'unknown' })).toBe('insufficient');
    expect(compareContext(base, base)).toBe('compatible');
  });

  test('rejects active HTML without executing it', () => {
    expect(() => untrustedText('DROP TABLE cases;', 1, 200)).not.toThrow();
    expect(() => untrustedText('<script>alert(1)</script>', 1, 200)).toThrow(/validation/i);
  });
});