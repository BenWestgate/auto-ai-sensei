import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPlannedSmallBoards,
  reconcileOgsImportState,
  summarizeOgsImportState,
  unresolvedOgsImportRows,
  verifyOgsImportPlanState,
  verifyOgsImportState,
} from '../src/ogs/checkpoint.mjs';

test('reconciliation restores only live verified AI mappings and permanent unsupported evidence', () => {
  const current = {
    version: 1,
    games: {
      '1': { status: 'UPLOAD_FAILED', error: 'transient' },
      '2': { status: 'UPLOAD_FAILED', error: 'transient' },
      '3': { status: 'UPLOAD_FAILED', error: 'transient' },
      '4': { status: 'ALREADY_ANALYZED', aiGameId: 'current-good' },
    },
  };
  const evidence = {
    games: {
      '1': { status: 'UPLOADED_NEW', aiGameId: 'live-1' },
      '2': { status: 'ALREADY_ANALYZED', aiGameId: 'gone-2' },
      '3': { status: 'SKIP_UNSUPPORTED_GAME', error: 'Move 10 is illegal.' },
      '4': { status: 'UPLOAD_FAILED', error: 'old failure' },
    },
  };

  const result = reconcileOgsImportState(current, evidence, new Set(['live-1', 'current-good']), new Date('2026-09-17T20:00:00Z'));
  assert.equal(result.state.games['1'].status, 'UPLOADED_NEW');
  assert.equal(result.state.games['1'].aiGameId, 'live-1');
  assert.equal(result.state.games['2'].status, 'UPLOAD_FAILED');
  assert.equal(result.state.games['3'].status, 'SKIP_UNSUPPORTED_GAME');
  assert.equal(result.state.games['4'].status, 'ALREADY_ANALYZED');
  assert.deepEqual(result.changes.map(x => x.ogsGameId), ['1', '3']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'AI_GAME_ID_NOT_IN_LIVE_UPLOAD_INDEX');
});

test('verification detects unresolved rows and stale terminal AI mappings', () => {
  const state = {
    games: {
      a: { status: 'LOCAL_DUPLICATE', aiGameId: 'live' },
      b: { status: 'UPLOADED_NEW', aiGameId: 'missing' },
      c: { status: 'SKIP_SMALL_BOARD' },
      d: { status: 'UPLOAD_FAILED' },
    },
  };
  assert.deepEqual(summarizeOgsImportState(state), {
    LOCAL_DUPLICATE: 1,
    UPLOADED_NEW: 1,
    SKIP_SMALL_BOARD: 1,
    UPLOAD_FAILED: 1,
  });
  assert.deepEqual(unresolvedOgsImportRows(state).map(x => x.ogsGameId), ['d']);
  const verified = verifyOgsImportState(state, new Set(['live']));
  assert.deepEqual(verified.unresolved.map(x => x.ogsGameId), ['d']);
  assert.deepEqual(verified.missingAiIds, [{ ogsGameId: 'b', status: 'UPLOADED_NEW', aiGameId: 'missing' }]);
});

test('current plan coverage classifies known small boards and detects missing games', () => {
  const state = { games: { '1': { status: 'ALREADY_ANALYZED', aiGameId: 'live-1' } } };
  const plan = [
    { id: 1, boardWidth: 19, boardHeight: 19 },
    { id: 2, boardWidth: 5, boardHeight: 5, ended: 'now', accounts: ['me'] },
    { id: 3, boardWidth: 19, boardHeight: 19 },
  ];
  const classified = classifyPlannedSmallBoards(state, plan, 7, new Date('2026-09-17T20:00:00Z'));
  assert.equal(classified.state.games['2'].status, 'SKIP_SMALL_BOARD');
  assert.deepEqual(classified.changes.map(x => x.ogsGameId), ['2']);
  const verified = verifyOgsImportPlanState(classified.state, plan, new Set(['live-1']));
  assert.deepEqual(verified.missingPlanRows, ['3']);
  assert.deepEqual(verified.unresolved, []);
  assert.deepEqual(verified.missingAiIds, []);
});
