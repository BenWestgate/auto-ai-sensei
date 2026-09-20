export const TOP_POINT_LOSS_CANDIDATES = 3;

export const AI_SENSEI_STUDENT_LEVELS = Object.freeze([
  ...Array.from({ length: 30 }, (_, i) => `${30 - i}k`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}d`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
]);

const BAD_LABELS = new Set(['inaccuracy', 'mistake', 'blunder']);
const WINRATE_VETO_LABELS = new Set(['mistake', 'blunder']);

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
  return rank == null ? -1 : AI_SENSEI_STUDENT_LEVELS.indexOf(rank);
}

export function strongerStudentRank(value) {
  const i = studentRankIndex(value);
  if (i < 0 || i >= AI_SENSEI_STUDENT_LEVELS.length - 1) return null;
  return AI_SENSEI_STUDENT_LEVELS[i + 1];
}

export function isBadQuizLabel(value) {
  return BAD_LABELS.has(String(value ?? '').trim().toLowerCase());
}

export function isWinrateVetoLabel(value) {
  return WINRATE_VETO_LABELS.has(String(value ?? '').trim().toLowerCase());
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

export function chooseCanonicalFromQuiz(top3, { resultClass = 'unknown' } = {}) {
  const needsNormalRankBadMove = resultClass !== 'loss';
  const eligible = needsNormalRankBadMove
    ? top3.filter(x => x.normalBadByPoint === true || x.normalBadByWinrate === true)
    : [...top3];
  const ranked = rankByImpact(eligible);
  return { keeper: ranked[0] ?? null, eligible, ranked };
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
