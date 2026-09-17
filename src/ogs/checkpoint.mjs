export const OGS_AI_RESOLVED_STATUSES = Object.freeze([
  'LOCAL_DUPLICATE',
  'ALREADY_ANALYZED',
  'UPLOADED_NEW',
]);

export const OGS_TERMINAL_STATUSES = Object.freeze([
  ...OGS_AI_RESOLVED_STATUSES,
  'SKIP_SMALL_BOARD',
  'SKIP_UNSUPPORTED_GAME',
]);

const AI_RESOLVED = new Set(OGS_AI_RESOLVED_STATUSES);
const TERMINAL = new Set(OGS_TERMINAL_STATUSES);

export function summarizeOgsImportState(state) {
  const counts = {};
  for (const row of Object.values(state?.games ?? {})) {
    const status = row?.status ?? 'UNKNOWN';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function unresolvedOgsImportRows(state) {
  return Object.entries(state?.games ?? {})
    .filter(([, row]) => !TERMINAL.has(row?.status))
    .map(([ogsGameId, row]) => ({ ogsGameId, ...row }));
}

export function verifyOgsImportState(state, knownAiIds) {
  const missingAiIds = [];
  const unresolved = unresolvedOgsImportRows(state);
  for (const [ogsGameId, row] of Object.entries(state?.games ?? {})) {
    if (!AI_RESOLVED.has(row?.status)) continue;
    if (!row.aiGameId || !knownAiIds.has(row.aiGameId)) {
      missingAiIds.push({ ogsGameId, status: row.status, aiGameId: row.aiGameId ?? null });
    }
  }
  return { unresolved, missingAiIds };
}

export function classifyPlannedSmallBoards(state, plannedGames, minBoardSize, now = new Date()) {
  const next = structuredClone(state ?? { version: 1, games: {} });
  if (!next.games || typeof next.games !== 'object') next.games = {};
  const changes = [];

  for (const game of plannedGames ?? []) {
    const width = Number(game?.boardWidth ?? game?.boardSize);
    const height = Number(game?.boardHeight ?? game?.boardSize ?? width);
    if (!Number.isFinite(width) || !Number.isFinite(height) || (width >= minBoardSize && height >= minBoardSize)) continue;
    const key = String(game.id);
    const current = next.games[key];
    if (current?.status === 'SKIP_SMALL_BOARD') continue;
    if (current && TERMINAL.has(current.status)) continue;
    next.games[key] = {
      ogsGameId: game.id,
      ended: game.ended,
      accounts: game.accounts,
      status: 'SKIP_SMALL_BOARD',
      aiGameId: null,
      error: null,
      boardWidth: width,
      boardHeight: height,
      boardSize: width === height ? width : null,
      minAnalysisBoardSize: minBoardSize,
      updatedAt: now.toISOString(),
    };
    changes.push({ ogsGameId: key, from: current?.status ?? null, to: 'SKIP_SMALL_BOARD' });
  }

  return { state: next, changes };
}

export function verifyOgsImportPlanState(state, plannedGames, knownAiIds) {
  const plannedIds = new Set((plannedGames ?? []).map(game => String(game.id)));
  const missingPlanRows = [...plannedIds].filter(ogsGameId => !state?.games?.[ogsGameId]);
  const unresolved = unresolvedOgsImportRows(state).filter(row => plannedIds.has(String(row.ogsGameId)));
  const missingAiIds = verifyOgsImportState(state, knownAiIds).missingAiIds
    .filter(row => plannedIds.has(String(row.ogsGameId)));
  return { missingPlanRows, unresolved, missingAiIds };
}

export function reconcileOgsImportState(currentState, evidenceState, knownAiIds, now = new Date()) {
  const next = structuredClone(currentState ?? { version: 1, games: {} });
  if (!next.games || typeof next.games !== 'object') next.games = {};
  const changes = [];
  const rejected = [];

  for (const [ogsGameId, evidence] of Object.entries(evidenceState?.games ?? {})) {
    const current = next.games[ogsGameId];
    if (current && TERMINAL.has(current.status)) continue;

    if (evidence?.status === 'SKIP_UNSUPPORTED_GAME') {
      next.games[ogsGameId] = {
        ...evidence,
        updatedAt: now.toISOString(),
        reconciledFromEvidence: true,
      };
      changes.push({ ogsGameId, from: current?.status ?? null, to: evidence.status, aiGameId: null });
      continue;
    }

    if (AI_RESOLVED.has(evidence?.status)) {
      if (evidence.aiGameId && knownAiIds.has(evidence.aiGameId)) {
        next.games[ogsGameId] = {
          ...evidence,
          updatedAt: now.toISOString(),
          reconciledFromEvidence: true,
        };
        changes.push({ ogsGameId, from: current?.status ?? null, to: evidence.status, aiGameId: evidence.aiGameId });
      } else {
        rejected.push({
          ogsGameId,
          status: evidence.status,
          aiGameId: evidence.aiGameId ?? null,
          reason: evidence.aiGameId ? 'AI_GAME_ID_NOT_IN_LIVE_UPLOAD_INDEX' : 'MISSING_AI_GAME_ID',
        });
      }
    }
  }

  return { state: next, changes, rejected, verification: verifyOgsImportState(next, knownAiIds) };
}
