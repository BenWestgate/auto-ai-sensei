import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_SENSEI_STUDENT_LEVELS,
  aiSenseiGoodMoveSets,
  aiSenseiMistakeThreshold,
  aiSenseiPointCategory,
  aiSenseiStrictnessThreshold,
  aiSenseiWinrateCategory,
  analysisTransitionForMove,
  chooseCanonicalFromQuiz,
  chooseWorstOwnMove,
  directProblemColorAtMove,
  isBadQuizLabel,
  isWinrateVetoLabel,
  lossTeachingSolutions,
  mergeRankGoodMoveSets,
  normalizeStudentRank,
  rankAdjustedTopPointLoss,
  selectTopDistinctByFirstSolutionMove,
  sgfCoordFromBoardLabelClass,
  shouldForceZeroProblemsForFatal,
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

test('ambiguous and unsupported ownership always force zero saved problems', () => {
  for (const reason of [
    'PLAYER_NAME_AMBIGUOUS_OR_NOT_FOUND',
    'UPLOAD_SGF_INFO_MISSING_PLAYERS',
    'NO_USER_SIDE_AI_VS_AI',
    'REMOVABLE_FOREIGN_PLAYER',
  ]) {
    assert.equal(shouldForceZeroProblemsForFatal(reason), true, reason);
  }
  assert.equal(shouldForceZeroProblemsForFatal('NO_USABLE_ANALYSIS'), false);
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

test('AI Sensei SVG board labels map one-based intersections to SGF coordinates', () => {
  assert.equal(sgfCoordFromBoardLabelClass('ai-move with-category label-10-2-A', 13), 'jb');
  assert.equal(sgfCoordFromBoardLabelClass('good-move label-7-6-B', 13), 'gf');
  assert.equal(sgfCoordFromBoardLabelClass('blunder label-19-19-45', 19), 'ss');
  assert.equal(sgfCoordFromBoardLabelClass('good-move label-14-2-X', 13), null);
  assert.equal(sgfCoordFromBoardLabelClass('stone-10-2', 13), null);
});

test('student ranks normalize and increase one level at a time', () => {
  assert.equal(normalizeStudentRank('7Q'), '7k');
  assert.equal(normalizeStudentRank('1DM'), '1d');
  assert.equal(strongerStudentRank('7k'), '6k');
  assert.equal(strongerStudentRank('1k'), '1d');
  assert.equal(strongerStudentRank('8d'), '1p');
  assert.equal(strongerStudentRank('9d'), '2p');
  assert.equal(strongerStudentRank(AI_SENSEI_STUDENT_LEVELS.at(-1)), null);
  assert.equal(isBadQuizLabel('Inaccuracy'), true);
  assert.equal(isBadQuizLabel('Good move'), false);
  assert.equal(isWinrateVetoLabel('Inaccuracy'), false);
  assert.equal(isWinrateVetoLabel('Mistake'), true);
  assert.equal(isWinrateVetoLabel('Blunder'), true);
});

test('AI Sensei rank thresholds match the current frontend interpolation', () => {
  assert.equal(aiSenseiStrictnessThreshold('30k'), 15);
  assert.ok(Math.abs(aiSenseiStrictnessThreshold('8d') - 1.8) < 1e-12);
  assert.equal(aiSenseiStrictnessThreshold('9p'), 1);
  assert.equal(aiSenseiStrictnessThreshold('9d'), aiSenseiStrictnessThreshold('1p'));
  assert.ok(Math.abs(aiSenseiMistakeThreshold('8d', 'points') - 1.8) < 1e-12);
  assert.ok(Math.abs(aiSenseiMistakeThreshold('8d', 'winrate') - 0.072) < 1e-12);
});

test('AI Sensei point and win-rate labels use the frontend category thresholds', () => {
  const pointThreshold = aiSenseiMistakeThreshold('8d', 'points');
  assert.equal(aiSenseiPointCategory(pointThreshold * 2.5, '8d'), 'blunder');
  assert.equal(aiSenseiPointCategory(pointThreshold, '8d'), 'mistake');
  assert.equal(aiSenseiPointCategory(pointThreshold * 0.3, '8d'), 'inaccuracy');
  assert.equal(aiSenseiPointCategory(pointThreshold * 0.29, '8d'), 'good move');

  const winThreshold = aiSenseiMistakeThreshold('8d', 'winrate');
  assert.equal(aiSenseiWinrateCategory(winThreshold * 2.5, '8d'), 'blunder');
  assert.equal(aiSenseiWinrateCategory(winThreshold, '8d'), 'mistake');
  assert.equal(aiSenseiWinrateCategory(winThreshold * 0.3, '8d'), 'inaccuracy');
  assert.equal(aiSenseiWinrateCategory(winThreshold * 0.29, '8d'), 'good move');
  assert.equal(aiSenseiWinrateCategory(0.99, '8d', { aiMove: true }), 'good move');
});

test('AI Sensei good-move filtering matches frontend playout and category semantics', () => {
  const result = aiSenseiGoodMoveSets([
    { move: 'aa', playouts: 600, symmetry: false, scoreMean: 10, winrate: 60 },
    { move: 'bb', playouts: 250, symmetry: false, scoreMean: 8.5, winrate: 56 },
    { move: 'cc', playouts: 100, symmetry: false, scoreMean: 6.0, winrate: 40 },
    { move: 'dd', playouts: 50, symmetry: false, scoreMean: 9.5, winrate: 58 },
    { move: 'ee', playouts: 20, symmetry: false, scoreMean: 10, winrate: 60 },
    { move: '<pass>', playouts: 200, symmetry: true, scoreMean: 10, winrate: 60 },
  ], {
    rank: '8d',
    playedMove: 'bb',
    playedPointLoss: 0.4,
    playedWinrateDrop: 0.04,
  });
  assert.equal(result.ok, true);
  assert.equal(result.bestMove, 'aa');
  assert.equal(result.totalPlayouts, 1020);
  assert.deepEqual(result.consideredMoves, ['aa', 'bb', 'cc', 'dd']);
  assert.deepEqual(result.pointGoodMoves, ['aa', 'bb', 'dd']);
  assert.deepEqual(result.winrateBadMoves, ['cc']);
  assert.deepEqual(result.winrateGoodMoves, ['aa', 'dd']);
});

test('rank-adjusted top three strengthens one Student Level at a time', () => {
  const candidates = [
    { moveNumber: 10, pointLoss: 2.2, solutionMove: 'aa' },
    { moveNumber: 20, pointLoss: 2.0, solutionMove: 'bb' },
    { moveNumber: 30, pointLoss: 1.55, solutionMove: 'cc' },
    { moveNumber: 40, pointLoss: 1.9, solutionMove: 'aa' },
    { moveNumber: 50, pointLoss: 20, solutionMove: 'dd', aiMove: true },
  ];
  const result = rankAdjustedTopPointLoss(candidates, '6k');
  assert.equal(result.error, null);
  assert.equal(result.rank, '3p');
  assert.equal(result.problemCount, 3);
  assert.deepEqual(result.top.map(x => x.moveNumber), [10, 20, 30]);
});

test('rank-adjusted Quiz escalation excludes point-loss inaccuracies', () => {
  const threshold = aiSenseiMistakeThreshold('10k', 'points');
  const candidates = [
    { moveNumber: 10, pointLoss: threshold * 0.7, solutionMove: 'aa' },
    { moveNumber: 20, pointLoss: threshold * 0.5, solutionMove: 'bb' },
    { moveNumber: 30, pointLoss: threshold * 0.31, solutionMove: 'cc' },
  ];
  const result = rankAdjustedTopPointLoss(candidates, '10k');
  assert.equal(result.error, null);
  assert.notEqual(result.rank, '10k');
  assert.equal(aiSenseiPointCategory(candidates[0].pointLoss, '10k'), 'inaccuracy');
  assert.equal(aiSenseiPointCategory(candidates[1].pointLoss, '10k'), 'inaccuracy');
  assert.equal(aiSenseiPointCategory(candidates[2].pointLoss, '10k'), 'inaccuracy');
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

test('remembered top-three position has priority for a loss even when normal rank calls it good', () => {
  const chosen = chooseCanonicalFromQuiz([
    { moveNumber: 10, pointLoss: 8, winrateDrop: 0.20, normalBadByPoint: true, normalBadByWinrate: true },
    { moveNumber: 20, pointLoss: 6, winrateDrop: 0.05, normalBadByPoint: false, normalBadByWinrate: false },
    { moveNumber: 30, pointLoss: 5, winrateDrop: 0.10, normalBadByPoint: true, normalBadByWinrate: false },
  ], { resultClass: 'loss', preferredExistingMoveNumber: 20 });
  assert.equal(chosen.keeper.moveNumber, 20);
  assert.equal(chosen.preferredExisting, true);
  assert.deepEqual(chosen.ranked.map(x => x.moveNumber), [20, 10, 30]);
});

test('remembered top-three position in a win is replaced only when neither normal-rank metric calls it bad', () => {
  const candidates = [
    { moveNumber: 10, pointLoss: 8, winrateDrop: 0.20, normalBadByPoint: true, normalBadByWinrate: false },
    { moveNumber: 20, pointLoss: 6, winrateDrop: 0.05, normalBadByPoint: false, normalBadByWinrate: false },
    { moveNumber: 30, pointLoss: 5, winrateDrop: 0.10, normalBadByPoint: true, normalBadByWinrate: false },
  ];
  const replaced = chooseCanonicalFromQuiz(candidates, {
    resultClass: 'win',
    preferredExistingMoveNumber: 20,
  });
  assert.equal(replaced.keeper.moveNumber, 10);
  assert.equal(replaced.preferredExisting, false);

  const pointInaccuracy = candidates.map(x => x.moveNumber === 20 ? { ...x, normalBadByPoint: true } : x);
  assert.equal(chooseCanonicalFromQuiz(pointInaccuracy, {
    resultClass: 'win', preferredExistingMoveNumber: 20,
  }).keeper.moveNumber, 20);

  const winrateMistake = candidates.map(x => x.moveNumber === 20 ? { ...x, normalBadByWinrate: true } : x);
  assert.equal(chooseCanonicalFromQuiz(winrateMistake, {
    resultClass: 'win', preferredExistingMoveNumber: 20,
  }).keeper.moveNumber, 20);
});

test('remembered move outside point-loss top three does not override automatic selection', () => {
  const chosen = chooseCanonicalFromQuiz([
    { moveNumber: 10, pointLoss: 8, winrateDrop: 0.10, normalBadByPoint: true },
    { moveNumber: 20, pointLoss: 7, winrateDrop: 0.20, normalBadByPoint: true },
    { moveNumber: 30, pointLoss: 6, winrateDrop: 0.15, normalBadByPoint: true },
  ], { resultClass: 'win', preferredExistingMoveNumber: 99 });
  assert.equal(chosen.keeper.moveNumber, 20);
  assert.equal(chosen.preferredExisting, false);
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
