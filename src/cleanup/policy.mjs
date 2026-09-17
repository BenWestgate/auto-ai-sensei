export const MIN_POINT_LOSS = 1.0;
export const MIN_WR_DROP = 0.02;
export const TOP_POINT_LOSS_CANDIDATES = 3;

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

export function qualifiesPracticeFloor(candidate) {
  return candidate.pointLoss >= MIN_POINT_LOSS
    || (Number.isFinite(candidate.winrateDrop) && candidate.winrateDrop >= MIN_WR_DROP);
}

export function chooseCanonicalFromTop3(top3) {
  const qualifying = top3.filter(qualifiesPracticeFloor);
  if (!qualifying.length) return { keeper: null, qualifying: [], ranked: [] };
  const ranked = [...qualifying].sort((a, b) => {
    const aw = Number.isFinite(a.winrateDrop) ? a.winrateDrop : -1;
    const bw = Number.isFinite(b.winrateDrop) ? b.winrateDrop : -1;
    if (bw !== aw) return bw - aw;
    if (b.pointLoss !== a.pointLoss) return b.pointLoss - a.pointLoss;
    return a.moveNumber - b.moveNumber;
  });
  return { keeper: ranked[0], qualifying, ranked };
}
