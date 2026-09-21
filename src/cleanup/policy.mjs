export const TOP_POINT_LOSS_CANDIDATES = 3;

export const AI_SENSEI_STUDENT_LEVELS = Object.freeze([
  ...Array.from({ length: 30 }, (_, i) => `${30 - i}k`),
  // Current AI Sensei UI jumps directly from 8d to 1p; there is no 9d
  // Student level stop on the slider.
  ...Array.from({ length: 8 }, (_, i) => `${i + 1}d`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
]);

const BAD_LABELS = new Set(['inaccuracy', 'mistake', 'blunder']);
const WINRATE_VETO_LABELS = new Set(['mistake', 'blunder']);
const CATEGORY_THRESHOLDS = Object.freeze([
  ['blunder', 2.5],
  ['mistake', 1],
  ['inaccuracy', 0.3],
  ['good move', -1000],
]);

export function normalizeStudentRank(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
  if (!text || text === '?') return null;
  const m = text.match(/^(\d{1,2})(k|q|kyu|d|dan|dm|p|pro)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  const kind = m[2].toLowerCase();
  if (['k', 'q', 'kyu'].includes(kind)) return n <= 30 ? `${n}k` : null;
  if (['d', 'dan', 'dm'].includes(kind)) return n <= 9 ? `${n}d` : null;
  if (['p', 'pro'].includes(kind)) return n <= 9 ? `${n}p` : null;
  return null;
}

export function studentRankIndex(value) {
  const rank = normalizeStudentRank(value);
  if (rank == null) return -1;
  // AI Sensei's rank parser maps numeric rank 38 to 1p. A textual 9d also
  // parses to numeric rank 38, and the current Student Level slider has no 9d
  // stop, so canonicalize that one edge case to the 1p slider position.
  if (rank === '9d') return AI_SENSEI_STUDENT_LEVELS.indexOf('1p');
  return AI_SENSEI_STUDENT_LEVELS.indexOf(rank);
}

export function strongerStudentRank(value) {
  const i = studentRankIndex(value);
  if (i < 0 || i >= AI_SENSEI_STUDENT_LEVELS.length - 1) return null;
  return AI_SENSEI_STUDENT_LEVELS[i + 1];
}

export function aiSenseiStrictnessThreshold(value) {
  const index = studentRankIndex(value);
  if (index < 0) return null;

  // Current AI Sensei frontend source uses linear interpolation through:
  // 30k -> 15.0, 8d -> 1.8, 9p -> 1.0. Student rank indexes are the same
  // numeric rank values used by the frontend (30k=0 ... 9p=46).
  if (index <= 37) {
    return 15 + (1.8 - 15) * (index / 37);
  }
  return 1.8 + (1.0 - 1.8) * ((index - 37) / 9);
}

export function aiSenseiMistakeThreshold(value, mode = 'points') {
  const strictness = aiSenseiStrictnessThreshold(value);
  if (!Number.isFinite(strictness)) return null;
  if (mode === 'points') return strictness;
  if (mode === 'winrate') return (4 * strictness) / 100;
  return null;
}

function categoryForNormalizedLoss(normalizedLoss, aiMove = false) {
  if (aiMove) return 'good move';
  if (!Number.isFinite(normalizedLoss)) return null;
  return CATEGORY_THRESHOLDS.find(([, threshold]) => normalizedLoss >= threshold)?.[0] ?? null;
}

export function aiSenseiPointCategory(pointLoss, rank, { aiMove = false } = {}) {
  const threshold = aiSenseiMistakeThreshold(rank, 'points');
  if (!Number.isFinite(threshold) || !Number.isFinite(pointLoss)) return null;
  return categoryForNormalizedLoss(pointLoss / threshold, aiMove);
}

export function aiSenseiWinrateCategory(winrateDrop, rank, { aiMove = false } = {}) {
  const threshold = aiSenseiMistakeThreshold(rank, 'winrate');
  if (!Number.isFinite(threshold) || !Number.isFinite(winrateDrop)) return null;
  return categoryForNormalizedLoss(winrateDrop / threshold, aiMove);
}

export function aiSenseiGoodMoveSets(bestMoves, {
  rank,
  playedMove = null,
  playedPointLoss = null,
  playedWinrateDrop = null,
} = {}) {
  if (!Array.isArray(bestMoves) || !bestMoves.length) {
    return { ok: false, reason: 'NO_BEST_MOVES', bestMove: null };
  }

  const indexed = bestMoves.map((move, index) => ({ ...move, index }));
  const best = indexed[0];
  const bestMove = best?.move ?? null;
  if (!bestMove) return { ok: false, reason: 'BEST_MOVE_MISSING_COORDINATE', bestMove: null };

  const totalPlayouts = indexed
    .filter(move => move.symmetry !== true)
    .reduce((sum, move) => sum + (Number.isFinite(move.playouts) ? move.playouts : 0), 0);
  if (!(totalPlayouts > 0)) {
    return { ok: false, reason: 'BEST_MOVES_MISSING_PLAYOUTS', bestMove };
  }

  const considered = indexed.filter(move =>
    move.move !== '<pass>' &&
    (move.index <= 2 || (Number.isFinite(move.playouts) && move.playouts >= totalPlayouts * 0.04))
  );
  const pointGoodMoves = [];
  const winrateGoodMoves = [];
  const winrateBadMoves = [];
  const classifications = [];

  for (const move of considered) {
    const isPlayed = playedMove != null && move.move === playedMove;
    const aiMove = move.index === 0 || (isPlayed && move.move === bestMove);
    const pointLoss = isPlayed
      ? playedPointLoss
      : (Number.isFinite(best.scoreMean) && Number.isFinite(move.scoreMean)
          ? best.scoreMean - move.scoreMean
          : null);
    const winrateDrop = isPlayed
      ? playedWinrateDrop
      : (Number.isFinite(best.winrate) && Number.isFinite(move.winrate)
          ? (best.winrate - move.winrate) / 100
          : null);
    const pointCategory = aiSenseiPointCategory(pointLoss, rank, { aiMove });
    const winrateCategory = aiSenseiWinrateCategory(winrateDrop, rank, { aiMove });

    if (pointCategory === 'good move') pointGoodMoves.push(move.move);
    if (winrateCategory === 'good move') winrateGoodMoves.push(move.move);
    if (isWinrateVetoLabel(winrateCategory)) winrateBadMoves.push(move.move);
    classifications.push({
      move: move.move,
      index: move.index,
      pointLoss,
      winrateDrop,
      pointCategory,
      winrateCategory,
    });
  }

  return {
    ok: true,
    reason: null,
    bestMove,
    totalPlayouts,
    consideredMoves: considered.map(move => move.move),
    pointGoodMoves: [...new Set(pointGoodMoves)].sort(),
    winrateGoodMoves: [...new Set(winrateGoodMoves)].sort(),
    winrateBadMoves: [...new Set(winrateBadMoves)].sort(),
    classifications,
  };
}

export function rankAdjustedTopPointLoss(candidates, normalRank, limit = TOP_POINT_LOSS_CANDIDATES) {
  const startIndex = studentRankIndex(normalRank);
  if (startIndex < 0) {
    return { rank: null, problemCount: 0, top: [], error: `UNSUPPORTED_STUDENT_RANK:${normalRank}` };
  }

  for (let index = startIndex; index < AI_SENSEI_STUDENT_LEVELS.length; index++) {
    const rank = AI_SENSEI_STUDENT_LEVELS[index];
    const mistakes = candidates.filter(candidate => {
      const category = aiSenseiPointCategory(candidate.pointLoss, rank, { aiMove: candidate.aiMove === true });
      // AI Sensei's displayed Quiz count that controls Student Level
      // escalation counts point-loss Mistake/Blunder rows, not Inaccuracy.
      // Keep this aligned with the live Quiz rank search; Inaccuracy remains a
      // normal-rank problem label elsewhere in the cleanup policy.
      return isWinrateVetoLabel(category);
    });
    const sorted = [...mistakes].sort((a, b) => b.pointLoss - a.pointLoss || a.moveNumber - b.moveNumber);
    const distinct = [];
    const seen = new Set();
    for (const candidate of sorted) {
      if (!candidate.solutionMove) {
        if (distinct.length < limit) {
          return {
            rank,
            problemCount: distinct.length,
            top: distinct,
            error: `MISSING_BEST_MOVE_FOR_TOP3@position${candidate.moveNumber - 1}`,
          };
        }
        break;
      }
      const key = candidate.solutionKey ?? solutionKeyFromFirstMove(candidate.solutionMove);
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push({ ...candidate, solutionKey: key });
    }
    if (distinct.length >= limit || index === AI_SENSEI_STUDENT_LEVELS.length - 1) {
      return {
        rank,
        problemCount: distinct.length,
        top: distinct.slice(0, limit),
        error: null,
      };
    }
  }

  return { rank: null, problemCount: 0, top: [], error: 'STUDENT_RANK_RANGE_EXHAUSTED' };
}

export function isBadQuizLabel(value) {
  return BAD_LABELS.has(String(value ?? '').trim().toLowerCase());
}

export function isWinrateVetoLabel(value) {
  return WINRATE_VETO_LABELS.has(String(value ?? '').trim().toLowerCase());
}

export function shouldForceZeroProblemsForFatal(reason) {
  return reason === 'PLAYER_NAME_AMBIGUOUS_OR_NOT_FOUND' ||
    reason === 'UPLOAD_SGF_INFO_MISSING_PLAYERS' ||
    reason === 'NO_USER_SIDE_AI_VS_AI' ||
    reason === 'REMOVABLE_FOREIGN_PLAYER';
}

export function analysisTransitionForMove(moveNumber) {
  const actualMove = Number(moveNumber);
  const beforePosition = actualMove - 1;
  if (!Number.isInteger(actualMove) || actualMove < 1 || beforePosition < 0) {
    return { ok: false, actualMove, beforePosition };
  }
  return { ok: true, actualMove, beforePosition };
}

export function directProblemColorAtMove(moveNumber, nodesById) {
  if (!Number.isInteger(moveNumber) || moveNumber < 1) return null;
  return nodesById?.get?.(moveNumber)?.[':color'] ?? null;
}

export function solutionKeyFromFirstMove(move) {
  return move ? `first=${move}` : null;
}

export function sgfCoordFromBoardLabelClass(className, boardSize = 19) {
  const match = String(className ?? '').match(/(?:^|\s)label-(\d+)-(\d+)(?:-|\s|$)/);
  if (!match) return null;
  const x = Number(match[1]) - 1;
  const y = Number(match[2]) - 1;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= boardSize || y >= boardSize) {
    return null;
  }
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
}

export function selectTopDistinctByFirstSolutionMove(candidates, limit = TOP_POINT_LOSS_CANDIDATES) {
  const sorted = [...candidates].sort((a, b) => b.pointLoss - a.pointLoss || a.moveNumber - b.moveNumber);
  const top = [];
  const seen = new Set();

  for (const candidate of sorted) {
    if (!candidate.solutionMove) {
      if (top.length < limit) {
        return {
          top,
          error: `MISSING_BEST_MOVE_FOR_TOP3@position${candidate.moveNumber - 1}`,
        };
      }
      break;
    }
    const solutionKey = candidate.solutionKey ?? solutionKeyFromFirstMove(candidate.solutionMove);
    if (seen.has(solutionKey)) continue;
    seen.add(solutionKey);
    top.push({ ...candidate, solutionKey });
    if (top.length >= limit) break;
  }

  return { top, error: null };
}

function rankByImpact(candidates) {
  const pool = [...candidates];
  const positiveWinrate = pool.filter(x => Number.isFinite(x.winrateDrop) && x.winrateDrop > 0);
  const ranked = positiveWinrate.length ? positiveWinrate : pool;
  return ranked.sort((a, b) => {
    if (positiveWinrate.length) {
      const aw = Number.isFinite(a.winrateDrop) ? a.winrateDrop : -1;
      const bw = Number.isFinite(b.winrateDrop) ? b.winrateDrop : -1;
      if (bw !== aw) return bw - aw;
    }
    if (b.pointLoss !== a.pointLoss) return b.pointLoss - a.pointLoss;
    return a.moveNumber - b.moveNumber;
  });
}

export function chooseCanonicalFromQuiz(top3, {
  resultClass = 'unknown',
  preferredExistingMoveNumber = null,
} = {}) {
  const needsNormalRankBadMove = resultClass !== 'loss';
  const eligible = needsNormalRankBadMove
    ? top3.filter(x => x.normalBadByPoint === true || x.normalBadByWinrate === true)
    : [...top3];
  const ranked = rankByImpact(eligible);
  const preferred = Number.isInteger(preferredExistingMoveNumber)
    ? eligible.find(x => x.moveNumber === preferredExistingMoveNumber) ?? null
    : null;
  if (preferred) {
    return {
      keeper: preferred,
      eligible,
      ranked: [preferred, ...ranked.filter(x => x.moveNumber !== preferred.moveNumber)],
      preferredExisting: true,
    };
  }
  return { keeper: ranked[0] ?? null, eligible, ranked, preferredExisting: false };
}

export function chooseWorstOwnMove(candidates) {
  const ranked = rankByImpact(candidates);
  return { keeper: ranked[0] ?? null, ranked };
}

export function mergeRankGoodMoveSets({ pointGoodMoves = [], winrateBadMoves = [], bestMove = null } = {}) {
  const point = new Set(pointGoodMoves.filter(Boolean));
  const winrateBad = new Set(winrateBadMoves.filter(Boolean));
  const moves = [...point].filter(move => !winrateBad.has(move));
  if (bestMove) moves.push(bestMove);
  return [...new Set(moves)].sort();
}

export function lossTeachingSolutions(solutionMoves, {
  playedMove = null,
  bestMove = null,
  allowPlayedBestFallback = false,
} = {}) {
  const all = [...new Set((solutionMoves ?? []).filter(Boolean))].sort();
  if (!playedMove || !all.includes(playedMove)) {
    return { solutionMoves: all, playedMoveExcluded: false, fallbackPlayedBest: false };
  }
  const withoutPlayed = all.filter(move => move !== playedMove);
  if (withoutPlayed.length) {
    return { solutionMoves: withoutPlayed, playedMoveExcluded: true, fallbackPlayedBest: false };
  }
  if (allowPlayedBestFallback && bestMove && playedMove === bestMove && all.length === 1) {
    return { solutionMoves: all, playedMoveExcluded: false, fallbackPlayedBest: true };
  }
  return { solutionMoves: [], playedMoveExcluded: true, fallbackPlayedBest: false };
}
