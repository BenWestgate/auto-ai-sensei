import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_SENSEI_STUDENT_LEVELS,
  analysisTransitionForMove,
  chooseCanonicalFromQuiz,
  chooseWorstOwnMove,
  directProblemColorAtMove,
  isBadQuizLabel,
  isWinrateVetoLabel,
  lossTeachingSolutions,
  mergeRankGoodMoveSets,
  normalizeStudentRank,
  selectTopDistinctByFirstSolutionMove,
  strongerStudentRank,
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

test('student ranks normalize and increase one level at a time', () => {
  assert.equal(normalizeStudentRank('7Q'), '7k');
  assert.equal(normalizeStudentRank('1DM'), '1d');
  assert.equal(strongerStudentRank('7k'), '6k');
  assert.equal(strongerStudentRank('1k'), '1d');
  assert.equal(strongerStudentRank(AI_SENSEI_STUDENT_LEVELS.at(-1)), null);
  assert.equal(isBadQuizLabel('Inaccuracy'), true);
  assert.equal(isBadQuizLabel('Good move'), false);
  assert.equal(isWinrateVetoLabel('Inaccuracy'), false);
  assert.equal(isWinrateVetoLabel('Mistake'), true);
  assert.equal(isWinrateVetoLabel('Blunder'), true);
});

test('canonical quiz choice is win-rate drop, then point loss, then move number', () => {
  const chosen = chooseCanonicalFromQuiz([
    { moveNumber: 30, pointLoss: 9, winrateDrop: 0.04, normalBadByPoint: true },
    { moveNumber: 40, pointLoss: 5, winrateDrop: 0.06, normalBadByPoint: true },
    { moveNumber: 20, pointLoss: 6, winrateDrop: 0.06, normalBadByPoint: true },
  ], { resultClass: 'win' });
  assert.equal(chosen.keeper.moveNumber, 20);

  const tie = chooseCanonicalFromQuiz([
    { moveNumber: 12, pointLoss: 4, winrateDrop: 0.05, normalBadByWinrate: true },
    { moveNumber: 8, pointLoss: 4, winrateDrop: 0.05, normalBadByWinrate: true },
  ], { resultClass: 'draw' });
  assert.equal(tie.keeper.moveNumber, 8);
});

test('wins/draws/unknown require normal-rank bad by either metric; losses do not', () => {
  const candidates = [
    { moveNumber: 10, pointLoss: 8, winrateDrop: 0.20, normalBadByPoint: false, normalBadByWinrate: false },
    { moveNumber: 20, pointLoss: 5, winrateDrop: 0.10, normalBadByPoint: true, normalBadByWinrate: false },
  ];
  assert.equal(chooseCanonicalFromQuiz(candidates, { resultClass: 'win' }).keeper.moveNumber, 20);
  assert.equal(chooseCanonicalFromQuiz(candidates, { resultClass: 'unknown' }).keeper.moveNumber, 20);
  assert.equal(chooseCanonicalFromQuiz(candidates, { resultClass: 'loss' }).keeper.moveNumber, 10);
});

test('positive measured win-rate dominates; point loss is fallback only when all win-rate impacts are zero/unavailable', () => {
  const measured = chooseWorstOwnMove([
    { moveNumber: 10, pointLoss: 20, winrateDrop: null },
    { moveNumber: 20, pointLoss: 3, winrateDrop: 0.01 },
  ]);
  assert.equal(measured.keeper.moveNumber, 20);
  const fallback = chooseWorstOwnMove([
    { moveNumber: 10, pointLoss: 20, winrateDrop: null },
    { moveNumber: 20, pointLoss: 3, winrateDrop: 0 },
  ]);
  assert.equal(fallback.keeper.moveNumber, 10);
});

test('accepted solutions keep point-good moves unless win-rate marks mistake/blunder, plus the best move', () => {
  assert.deepEqual(mergeRankGoodMoveSets({
    pointGoodMoves: ['aa', 'bb', 'cc'],
    winrateBadMoves: ['bb'],
    bestMove: 'dd',
  }), ['aa', 'cc', 'dd']);
});

test('loss teaching excludes a played good move and only allows played-best as final fallback', () => {
  assert.deepEqual(lossTeachingSolutions(['aa', 'bb'], { playedMove: 'aa', bestMove: 'bb' }).solutionMoves, ['bb']);
  assert.equal(lossTeachingSolutions(['aa'], { playedMove: 'aa', bestMove: 'aa' }).solutionMoves.length, 0);
  const fallback = lossTeachingSolutions(['aa'], { playedMove: 'aa', bestMove: 'aa', allowPlayedBestFallback: true });
  assert.deepEqual(fallback.solutionMoves, ['aa']);
  assert.equal(fallback.fallbackPlayedBest, true);
});
