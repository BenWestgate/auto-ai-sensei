function cleanText(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function normalizeStatus(value) {
  return cleanText(value).replace(/^:/, '').toLowerCase();
}

function squareBoardSize(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const text = cleanText(value);
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function playerLabel(name, rank) {
  const n = cleanText(name);
  const r = cleanText(rank);
  return r && r !== '?' ? `${n} ${r}` : n;
}

export function importedGameMetadataFromUploadFields(fields, {
  id = null,
  docName = null,
  updateTime = null,
} = {}) {
  const status = normalizeStatus(fields?.[':status']);
  if (status !== 'done') {
    return { ok: false, reason: `UPLOAD_NOT_DONE:${status || 'unknown'}` };
  }

  const info = fields?.[':sgf-info'];
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    return { ok: false, reason: 'UPLOAD_SGF_INFO_MISSING' };
  }

  const boardSize = squareBoardSize(info[':board-size']);
  if (!boardSize) {
    return { ok: false, reason: 'UPLOAD_SGF_INFO_UNSUPPORTED_BOARD_SIZE' };
  }

  const black = cleanText(info[':black']);
  const white = cleanText(info[':white']);
  if (!black || !white) {
    return { ok: false, reason: 'UPLOAD_SGF_INFO_MISSING_PLAYERS' };
  }

  const blackLabel = playerLabel(black, info[':br']);
  const whiteLabel = playerLabel(white, info[':wr']);

  return {
    ok: true,
    game: {
      id,
      docName,
      updateTime,
      name: `${whiteLabel} vs ${blackLabel}`,
      boardSize,
      moves: [],
      raw: fields,
      metadataSource: 'UPLOAD_SGF_INFO',
    },
  };
}
