import { describe, expect, test } from 'vitest';

import { assessToolchainCompatibility, satisfiesPeerRange } from '../src/toolchain/peer-range.js';

const currentPeer = '>=4.8.4 <6.1.0';

describe('TypeScript peer compatibility', () => {
  test('accepts the installed TypeScript 6 API', () => {
    expect(satisfiesPeerRange('6.0.3', currentPeer)).toBe(true);
    expect(assessToolchainCompatibility({
      compilerVersion: '7.0.2',
      apiVersion: '6.0.3',
      peerRange: currentPeer,
    })).toBeUndefined();
  });

  test('rejects a TypeScript 7 API while the peer range stops before 6.1', () => {
    expect(satisfiesPeerRange('7.0.2', currentPeer)).toBe(false);
    expect(assessToolchainCompatibility({
      compilerVersion: '7.0.2',
      apiVersion: '7.0.2',
      peerRange: currentPeer,
    })).toMatch(/does not satisfy/);
  });

  test('allows the compiler and API to share a major when the peer range does', () => {
    const futurePeer = '>=4.8.4 <6.1.0 || >=7.0.0 <8.0.0';
    expect(satisfiesPeerRange('7.0.2', futurePeer)).toBe(true);
    expect(assessToolchainCompatibility({
      compilerVersion: '7.0.2',
      apiVersion: '7.0.2',
      peerRange: futurePeer,
    })).toBeUndefined();
    expect(assessToolchainCompatibility({
      compilerVersion: '6.0.3',
      apiVersion: '6.0.3',
      peerRange: currentPeer,
    })).toBeUndefined();
  });
});
