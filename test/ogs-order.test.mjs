import assert from 'node:assert/strict';
import test from 'node:test';
import { sortOgsGamesOldestFirst } from '../src/ogs/order.mjs';

test('OGS games are globally oldest first with game id as deterministic tie break', () => {
  const sorted = sortOgsGamesOldestFirst([
    { id: 30, ended: '2026-01-02T00:00:00Z', accounts: ['a'] },
    { id: 20, ended: '2026-01-01T00:00:00Z', accounts: ['b'] },
    { id: 10, ended: '2026-01-01T00:00:00Z', accounts: ['a'] },
  ]);
  assert.deepEqual(sorted.map(x => x.id), [10, 20, 30]);
});
