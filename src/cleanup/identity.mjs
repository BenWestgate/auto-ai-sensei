export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isTeachingGameHumanLabel(label) {
  const s = normalizeName(label);
  return s.includes('human') && s.includes('teaching game');
}

function isNormalGameHumanLabel(label) {
  const s = normalizeName(label);
  return s.includes('human') && s.includes('normal game');
}

function isAiPlayerLabel(label) {
  const s = normalizeName(label);
  return /(^|\s|\()ai(?=\s|\(|$)/i.test(s) || /\bbot\b/i.test(s) || s.includes('calibrated rank');
}

export function stripTrailingRank(label) {
  let s = normalizeName(label);
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*(?:\(|\[)?\s*\d+(?:\.\d+)?\s*(?:k|d|p|kyu|dan)\s*(?:\)|\])?\s*$/i, '');
    s = s.replace(/\s*[\(\[]\s*\d+(?:\.\d+)?\s*[\)\]]\s*$/i, '');
    s = s.replace(/\s*\d+(?:\.\d+)?\s*(?:级|段)\s*$/u, '');
  } while (s !== prev);
  return s.trim();
}

export function playerColorFromGameName(gameName, myNames) {
  const partsRaw = String(gameName).split(/\s+vs\s+/i);
  if (partsRaw.length !== 2) return { color: null, reason: 'GAME_NAME_NOT_WHITE_VS_BLACK' };

  const teachingWhite = isTeachingGameHumanLabel(partsRaw[0]);
  const teachingBlack = isTeachingGameHumanLabel(partsRaw[1]);
  if (teachingWhite !== teachingBlack) {
    return {
      color: teachingWhite ? 'white' : 'black',
      reason: teachingWhite ? 'TEACHING_GAME_HUMAN_WHITE' : 'TEACHING_GAME_HUMAN_BLACK',
    };
  }

  const normalWhite = isNormalGameHumanLabel(partsRaw[0]);
  const normalBlack = isNormalGameHumanLabel(partsRaw[1]);
  if (normalWhite !== normalBlack) {
    const otherLooksAi = normalWhite ? isAiPlayerLabel(partsRaw[1]) : isAiPlayerLabel(partsRaw[0]);
    if (otherLooksAi) {
      return {
        color: normalWhite ? 'white' : 'black',
        reason: normalWhite ? 'NORMAL_GAME_HUMAN_VS_AI_WHITE' : 'NORMAL_GAME_HUMAN_VS_AI_BLACK',
      };
    }
  }

  const [whiteLabel, blackLabel] = partsRaw.map(stripTrailingRank);
  const aliasesByNormalized = new Map();
  for (const name of myNames ?? []) {
    const normalized = normalizeName(name);
    if (normalized && !aliasesByNormalized.has(normalized)) aliasesByNormalized.set(normalized, name);
  }
  const needles = [...aliasesByNormalized.keys()];
  const whiteMatches = needles.filter(n => n === whiteLabel);
  const blackMatches = needles.filter(n => n === blackLabel);

  if (whiteMatches.length === 1 && blackMatches.length === 0) {
    return {
      color: 'white',
      identityName: aliasesByNormalized.get(whiteMatches[0]) ?? whiteMatches[0],
      reason: `MATCHED_WHITE:${whiteMatches[0]}`,
    };
  }
  if (blackMatches.length === 1 && whiteMatches.length === 0) {
    return {
      color: 'black',
      identityName: aliasesByNormalized.get(blackMatches[0]) ?? blackMatches[0],
      reason: `MATCHED_BLACK:${blackMatches[0]}`,
    };
  }
  if (isAiPlayerLabel(partsRaw[0]) && isAiPlayerLabel(partsRaw[1])) {
    return { color: null, reason: 'NO_USER_SIDE_AI_VS_AI', whiteLabel, blackLabel };
  }
  return {
    color: null,
    reason: 'PLAYER_NAME_AMBIGUOUS_OR_NOT_FOUND',
    whiteLabel,
    blackLabel,
  };
}

export function exactPlayersFromGameName(gameName) {
  const parts = String(gameName).split(/\s+vs\s+/i);
  if (parts.length !== 2) return [];
  return parts.map(stripTrailingRank).filter(Boolean);
}

export function matchingRemovedPlayers(gameName, removePlayers) {
  if (!removePlayers?.length) return [];
  const players = new Set(exactPlayersFromGameName(gameName));
  return removePlayers.filter(name => players.has(normalizeName(name)));
}

export function classifyRemovedPlayerGame(gameName, myNames, removePlayers) {
  const ownership = playerColorFromGameName(gameName, myNames);
  const matchedRemovedPlayers = matchingRemovedPlayers(gameName, removePlayers);
  return {
    ownership,
    matchedRemovedPlayers,
    removable: matchedRemovedPlayers.length > 0 && !ownership.color,
  };
}
