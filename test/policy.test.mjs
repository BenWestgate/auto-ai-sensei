import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisTransitionForMove,
  chooseCanonicalFromTop3,
  directProblemColorAtMove,
  qualifiesPracticeFloor,
  selectTopDistinctByFirstSolutionMove,
} from '../src/cleanup/policy.mjs';

test('move N uses analysis transition N-1 -> N', () => {
  assert.deepEqual(analysisTransitionForMove(1), { ok: true, actualMove: 1, beforePosition: 0 });
  assert.deepEqual(analysisTransitionForMove(27), { ok: true, actualMove: 27, beforePosition: 26 });
  assert.equal(analysisTransitionForMove(0).ok, false);
});

test('problem color comes from move N, not an adjacent move', () => {
  const nodes = new Map([
    [9, { ':color': 'black' }],
    [10, { ':color': 'white' }],
    [11, { ':color': 'black' }],
  ]);
  assert.equal(directProblemColorAtMove(10, nodes), 'white');
});

test('top three candidates de-duplicate by first solution move', () => {
  const { top, error } = selectTopDistinctByFirstSolutionMove([
    { moveNumber: 10, pointLoss: 8, solutionMove: 'dd' },
    { moveNumber: 20, pointLoss: 7, solutionMove: 'dd' },
    { moveNumber: 30, pointLoss: 6, solutionMove: 'pq' },
    { moveNumber: 40, pointLoss: 5, solutionMove: 'cc' },
    { moveNumber: 50, pointLoss: 4, solutionMove: 'jj' },
  ]);
  assert.equal(error, null);
  assert.deepEqual(top.map(x => x.moveNumber), [10, 30, 40]);
  assert.deepEqual(top.map(x => x.solutionKey), ['first=dd', 'first=pq', 'first=cc']);
});

test('practice floor is one point OR two percentage points', () => {
  assert.equal(qualifiesPracticeFloor({ pointLoss: 1, winrateDrop: 0 }), true);
  assert.equal(qualifiesPracticeFloor({ pointLoss: 0, winrateDrop: 0.02 }), true);
  assert.equal(qualifiesPracticeFloor({ pointLoss: 0.99, winrateDrop: 0.0199 }), false);
});

test('canonical choice is win-rate drop, then point loss, then move number', () => {
  const chosen = chooseCanonicalFromTop3([
    { moveNumber: 30, pointLoss: 9, winrateDrop: 0.04 },
    { moveNumber: 40, pointLoss: 5, winrateDrop: 0.06 },
    { moveNumber: 20, pointLoss: 6, winrateDrop: 0.06 },
  ]);
  assert.equal(chosen.keeper.moveNumber, 20);

  const tie = chooseCanonicalFromTop3([
    { moveNumber: 12, pointLoss: 4, winrateDrop: 0.05 },
    { moveNumber: 8, pointLoss: 4, winrateDrop: 0.05 },
  ]);
  assert.equal(tie.keeper.moveNumber, 8);
});
