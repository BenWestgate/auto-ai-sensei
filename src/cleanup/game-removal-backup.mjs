import crypto from 'node:crypto';
import { normalizeName, playerColorFromGameName } from './identity.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function validateDocument(doc, source) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${source} contains a non-document entry`);
  if (typeof doc.name !== 'string' || !doc.name) throw new Error(`${source} contains a document without a name`);
  if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) {
    throw new Error(`${source} document ${doc.name} has no Firestore fields map`);
  }
}

export function validateGameRemovalBackup(backup, { firestoreRoot, uid, source = 'Game-removal backup' }) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error(`${source} must be a JSON object`);
  if (backup.version !== 1 || backup.kind !== 'ai-sensei-game-removal-backup') {
    throw new Error(`${source} is not a supported game-removal backup`);
  }
  if (backup.uid !== uid) throw new Error(`${source} belongs to a different Firebase user`);
  if (backup.firestoreRoot !== firestoreRoot) throw new Error(`${source} belongs to a different Firestore database`);
  if (!Array.isArray(backup.targets) || !Array.isArray(backup.documents)) throw new Error(`${source} is missing targets[] or documents[]`);
  if (backup.targetCount !== backup.targets.length) throw new Error(`${source} targetCount does not match targets[]`);
  if (backup.documentCount !== backup.documents.length) throw new Error(`${source} documentCount does not match documents[]`);

  const documents = new Map();
  for (const doc of backup.documents) {
    validateDocument(doc, source);
    if (documents.has(doc.name)) throw new Error(`${source} contains duplicate document ${doc.name}`);
    documents.set(doc.name, doc);
  }
  return documents;
}

export function collectGameRemovalRestoreCandidates(backups, {
  firestoreRoot,
  uid,
  myNames,
  restorePlayers,
} = {}) {
  if (!Array.isArray(backups) || !backups.length) throw new Error('At least one game-removal backup is required');
  const selectedPlayers = new Set((restorePlayers ?? []).map(normalizeName).filter(Boolean));
  if (!selectedPlayers.size) throw new Error('At least one --restore-player value is required');

  const seenGameIds = new Set();
  const restoreCandidates = [];
  const skipped = [];
  let targetCount = 0;
  for (const entry of backups) {
    const backup = entry.backup ?? entry;
    const source = entry.source ?? 'Game-removal backup';
    const documents = validateGameRemovalBackup(backup, { firestoreRoot, uid, source });
    for (const target of backup.targets) {
      targetCount++;
      if (!target?.gameId || !target?.gameName) throw new Error(`${source} contains an invalid removal target`);
      if (seenGameIds.has(target.gameId)) throw new Error(`Game ${target.gameId} appears in more than one removal backup`);
      seenGameIds.add(target.gameId);

      const matchedSelectedPlayer = (target.matchedPlayers ?? []).some(name => selectedPlayers.has(normalizeName(name)));
      if (!matchedSelectedPlayer) {
        skipped.push({ gameId: target.gameId, gameName: target.gameName, uploadDocName: target.uploadDocName ?? null, reason: 'RESTORE_PLAYER_NOT_SELECTED' });
        continue;
      }
      const ownership = playerColorFromGameName(target.gameName, myNames);
      if (!ownership.color || !ownership.identityName) {
        skipped.push({ gameId: target.gameId, gameName: target.gameName, uploadDocName: target.uploadDocName ?? null, reason: 'FOREIGN_OR_AMBIGUOUS_GAME' });
        continue;
      }
      if (!target.uploadDocName) throw new Error(`${source} target ${target.gameId} has no upload document name`);
      const expectedUploadName = `${firestoreRoot}/:game-data/${uid}/:uploads/${target.gameId}`;
      if (target.uploadDocName !== expectedUploadName) throw new Error(`${source} target ${target.gameId} has an unexpected upload document path`);
      const desiredUpload = documents.get(target.uploadDocName);
      if (!desiredUpload) throw new Error(`${source} is missing the upload snapshot for ${target.gameId}`);
      if (target.gameDocName && !documents.has(target.gameDocName)) throw new Error(`${source} is missing the game snapshot for ${target.gameId}`);
      if (target.gameNodeDocName && !documents.has(target.gameNodeDocName)) throw new Error(`${source} is missing the game-node snapshot for ${target.gameId}`);

      restoreCandidates.push({
        gameId: target.gameId,
        gameName: target.gameName,
        identityName: ownership.identityName,
        myColor: ownership.color,
        source,
        target,
        desiredUpload,
        fieldsHash: digest(desiredUpload.fields),
      });
    }
  }
  restoreCandidates.sort((a, b) => a.gameId.localeCompare(b.gameId));
  skipped.sort((a, b) => a.gameId.localeCompare(b.gameId));
  return { targetCount, restoreCandidates, skipped };
}

export function restorePreconditionDocumentNames(selection) {
  const names = [];
  for (const candidate of selection.restoreCandidates ?? []) {
    names.push(candidate.target.uploadDocName);
    if (candidate.target.gameDocName) names.push(candidate.target.gameDocName);
    if (candidate.target.gameNodeDocName) names.push(candidate.target.gameNodeDocName);
  }
  return [...new Set(names)];
}

export function buildGameRemovalRestorePlan(selection, currentDocuments) {
  if (!(currentDocuments instanceof Map)) throw new Error('Current Firestore documents must be a Map');
  const actions = [];
  for (const candidate of selection.restoreCandidates ?? []) {
    const { target } = candidate;
    if (currentDocuments.has(target.uploadDocName)) {
      throw new Error(`Upload ${target.gameId} is already present; refusing to overwrite an existing account record`);
    }
    for (const [kind, name, updateTime] of [
      ['game', target.gameDocName, target.gameUpdateTime],
      ['game-node', target.gameNodeDocName, target.gameNodeUpdateTime],
    ]) {
      if (!name) continue;
      const current = currentDocuments.get(name);
      if (!current) throw new Error(`${target.gameId}:${kind} is missing; restoration preconditions are no longer valid`);
      if (!updateTime || current.updateTime !== updateTime) {
        throw new Error(`${target.gameId}:${kind} changed since backup; restoration preconditions are no longer valid`);
      }
    }
    actions.push({ ...candidate, action: 'RESTORE_UPLOAD' });
  }

  const hashRows = actions.map(row => ({
    action: row.action,
    gameId: row.gameId,
    gameName: row.gameName,
    identityName: row.identityName,
    myColor: row.myColor,
    uploadDocName: row.target.uploadDocName,
    gameDocName: row.target.gameDocName ?? null,
    gameUpdateTime: row.target.gameUpdateTime ?? null,
    gameNodeDocName: row.target.gameNodeDocName ?? null,
    gameNodeUpdateTime: row.target.gameNodeUpdateTime ?? null,
    fieldsHash: row.fieldsHash,
  }));
  const planHash = crypto.createHash('sha256').update(JSON.stringify(hashRows)).digest('hex').slice(0, 12);
  return {
    generatedAt: new Date().toISOString(),
    targetCount: selection.targetCount,
    restoreCount: actions.length,
    skippedCount: selection.skipped.length,
    planHash,
    actions,
    skipped: selection.skipped,
  };
}

export function gameRemovalRestoreAudit(plan) {
  return {
    generatedAt: plan.generatedAt,
    targetCount: plan.targetCount,
    restoreCount: plan.restoreCount,
    skippedCount: plan.skippedCount,
    planHash: plan.planHash,
    actions: plan.actions.map(row => ({
      action: row.action,
      gameId: row.gameId,
      gameName: row.gameName,
      identityName: row.identityName,
      myColor: row.myColor,
      uploadDocName: row.target.uploadDocName,
      fieldsHash: row.fieldsHash,
    })),
    skipped: plan.skipped,
  };
}
