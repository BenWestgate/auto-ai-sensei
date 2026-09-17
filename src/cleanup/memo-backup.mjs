import crypto from 'node:crypto';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function validateDocument(doc, prefix, source) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source} contains a non-document entry`);
  }
  if (typeof doc.name !== 'string' || !doc.name.startsWith(prefix)) {
    throw new Error(`${source} document is outside the authenticated memo collection: ${doc.name ?? '(missing name)'}`);
  }
  const suffix = doc.name.slice(prefix.length);
  if (!suffix || suffix.includes('/')) {
    throw new Error(`${source} document has an invalid memo document name: ${doc.name}`);
  }
  if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) {
    throw new Error(`${source} document ${doc.name} has no Firestore fields map`);
  }
}

function mapUniqueDocuments(documents, prefix, source) {
  const out = new Map();
  for (const doc of documents) {
    validateDocument(doc, prefix, source);
    if (out.has(doc.name)) throw new Error(`${source} contains duplicate memo document ${doc.name}`);
    out.set(doc.name, doc);
  }
  return out;
}

export function memoCollectionPrefix(firestoreRoot, uid) {
  if (!firestoreRoot || !uid) throw new Error('firestoreRoot and uid are required');
  return `${String(firestoreRoot).replace(/\/$/, '')}/:users/${uid}/:memos/`;
}

export function validateMemoBackup(backup, { firestoreRoot, uid }) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('Memo backup must be a JSON object');
  }
  if (backup.version !== undefined && backup.version !== 1) {
    throw new Error(`Unsupported memo backup version: ${backup.version}`);
  }
  if (!Array.isArray(backup.documents)) throw new Error('Memo backup is missing documents[]');
  if (backup.memoCount !== undefined) {
    if (!Number.isSafeInteger(backup.memoCount) || backup.memoCount < 0) {
      throw new Error(`Memo backup has invalid memoCount: ${backup.memoCount}`);
    }
    if (backup.memoCount !== backup.documents.length) {
      throw new Error(`Memo backup count mismatch: memoCount=${backup.memoCount}, documents=${backup.documents.length}`);
    }
  }
  if (backup.uid && backup.uid !== uid) {
    throw new Error(`Memo backup belongs to a different Firebase user (${backup.uid})`);
  }
  if (backup.firestoreRoot && backup.firestoreRoot !== firestoreRoot) {
    throw new Error('Memo backup belongs to a different Firestore database');
  }

  const prefix = memoCollectionPrefix(firestoreRoot, uid);
  return mapUniqueDocuments(backup.documents, prefix, 'Backup');
}

export function buildMemoRestorePlan(backup, currentDocuments, { firestoreRoot, uid }) {
  if (!Array.isArray(currentDocuments)) throw new Error('Current memo documents must be an array');

  const prefix = memoCollectionPrefix(firestoreRoot, uid);
  const desired = validateMemoBackup(backup, { firestoreRoot, uid });
  const current = mapUniqueDocuments(currentDocuments, prefix, 'Current library');
  const actions = [];

  for (const [name, backupDoc] of desired) {
    const currentDoc = current.get(name);
    const fieldsHash = digest(backupDoc.fields);
    if (!currentDoc) {
      actions.push({ action: 'CREATE', name, fieldsHash, desired: backupDoc });
      continue;
    }
    if (stableJson(currentDoc.fields) === stableJson(backupDoc.fields)) {
      actions.push({ action: 'UNCHANGED', name, fieldsHash, desired: backupDoc, current: currentDoc });
      continue;
    }
    if (!currentDoc.updateTime) throw new Error(`Current memo ${name} has no updateTime precondition`);
    actions.push({ action: 'REPLACE', name, fieldsHash, currentUpdateTime: currentDoc.updateTime, desired: backupDoc, current: currentDoc });
  }

  for (const [name, currentDoc] of current) {
    if (desired.has(name)) continue;
    if (!currentDoc.updateTime) throw new Error(`Current memo ${name} has no updateTime precondition`);
    actions.push({ action: 'DELETE', name, currentUpdateTime: currentDoc.updateTime, current: currentDoc });
  }

  actions.sort((a, b) => a.name.localeCompare(b.name) || a.action.localeCompare(b.action));
  const counts = { CREATE: 0, REPLACE: 0, DELETE: 0, UNCHANGED: 0 };
  for (const row of actions) counts[row.action]++;
  const hashRows = actions.map(row => ({
    action: row.action,
    name: row.name,
    fieldsHash: row.fieldsHash ?? null,
    currentUpdateTime: row.currentUpdateTime ?? null,
  }));
  const planHash = crypto.createHash('sha256').update(JSON.stringify(hashRows)).digest('hex').slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    backupGeneratedAt: backup.generatedAt ?? null,
    backupMemoCount: backup.documents.length,
    currentMemoCount: currentDocuments.length,
    counts,
    mutationCount: counts.CREATE + counts.REPLACE + counts.DELETE,
    planHash,
    actions,
  };
}

export function splitMemoRestoreActions(actions) {
  if (!Array.isArray(actions)) throw new Error('Memo restore actions must be an array');
  const restore = [];
  const deletions = [];
  for (const row of actions) {
    if (row.action === 'CREATE' || row.action === 'REPLACE') restore.push(row);
    else if (row.action === 'DELETE') deletions.push(row);
    else if (row.action !== 'UNCHANGED') throw new Error(`Unsupported memo restore action: ${row.action}`);
  }
  return { restore, deletions };
}

export function memoRestoreAudit(plan) {
  return {
    generatedAt: plan.generatedAt,
    backupGeneratedAt: plan.backupGeneratedAt,
    backupMemoCount: plan.backupMemoCount,
    currentMemoCount: plan.currentMemoCount,
    counts: plan.counts,
    mutationCount: plan.mutationCount,
    planHash: plan.planHash,
    actions: plan.actions.map(row => ({
      action: row.action,
      name: row.name,
      fieldsHash: row.fieldsHash ?? null,
      currentUpdateTime: row.currentUpdateTime ?? null,
    })),
  };
}
