import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGameRemovalRestorePlan,
  collectGameRemovalRestoreCandidates,
  restorePreconditionDocumentNames,
} from '../src/cleanup/game-removal-backup.mjs';

const root = 'projects/test/databases/(default)/documents';
const uid = 'user-1';
const aliases = ['GManifesto', '9Manifesto'];

function target(gameId, gameName) {
  return {
    gameId,
    gameName,
    matchedPlayers: ['RaidenBrah'],
    uploadDocName: `${root}/:game-data/${uid}/:uploads/${gameId}`,
    uploadUpdateTime: 'old-upload-time',
    gameDocName: `${root}/:games/${gameId}`,
    gameUpdateTime: `game-${gameId}`,
    gameNodeDocName: `${root}/:game-data/${uid}/:nodes/${gameId}`,
    gameNodeUpdateTime: `node-${gameId}`,
  };
}

function doc(name, fields, updateTime = 'snapshot-time') {
  return { name, fields, updateTime };
}

function backup(targets) {
  const documents = targets.flatMap(t => [
    doc(t.uploadDocName, { ':status': { stringValue: 'completed' }, marker: { stringValue: t.gameId } }, t.uploadUpdateTime),
    doc(t.gameDocName, { name: { stringValue: t.gameName } }, t.gameUpdateTime),
    doc(t.gameNodeDocName, { node: { stringValue: t.gameId } }, t.gameNodeUpdateTime),
  ]);
  return {
    version: 1,
    kind: 'ai-sensei-game-removal-backup',
    uid,
    firestoreRoot: root,
    targetCount: targets.length,
    documentCount: documents.length,
    targets,
    documents,
  };
}

function liveDocs(selection) {
  const out = new Map();
  for (const row of selection.restoreCandidates) {
    out.set(row.target.gameDocName, doc(row.target.gameDocName, {}, row.target.gameUpdateTime));
    out.set(row.target.gameNodeDocName, doc(row.target.gameNodeDocName, {}, row.target.gameNodeUpdateTime));
  }
  return out;
}

test('restore selection keeps owned RaidenBrah games and leaves foreign games removed', () => {
  const targets = [
    target('g1', 'GManifesto 6k vs RaidenBrah 19k'),
    target('g2', 'RaidenBrah 19k vs 9Manifesto 6k'),
    target('g3', 'Other 5k vs RaidenBrah 19k'),
  ];
  const selection = collectGameRemovalRestoreCandidates([{ source: 'backup.json', backup: backup(targets) }], {
    firestoreRoot: root,
    uid,
    myNames: aliases,
    restorePlayers: ['RaidenBrah'],
  });
  assert.equal(selection.targetCount, 3);
  assert.deepEqual(selection.restoreCandidates.map(x => x.gameId), ['g1', 'g2']);
  assert.deepEqual(selection.restoreCandidates.map(x => x.identityName), ['GManifesto', '9Manifesto']);
  assert.deepEqual(selection.skipped.map(x => [x.gameId, x.reason]), [['g3', 'FOREIGN_OR_AMBIGUOUS_GAME']]);

  const plan = buildGameRemovalRestorePlan(selection, liveDocs(selection));
  assert.equal(plan.restoreCount, 2);
  assert.equal(plan.skippedCount, 1);
  assert.equal(restorePreconditionDocumentNames(selection).length, 6);
});

test('restore selection rejects duplicate targets and missing upload snapshots', () => {
  const t = target('g1', 'GManifesto 6k vs RaidenBrah 19k');
  const b = backup([t]);
  assert.throws(() => collectGameRemovalRestoreCandidates([
    { source: 'a.json', backup: b },
    { source: 'b.json', backup: b },
  ], { firestoreRoot: root, uid, myNames: aliases, restorePlayers: ['RaidenBrah'] }), /more than one removal backup/);

  const missing = backup([t]);
  missing.documents = missing.documents.filter(x => x.name !== t.uploadDocName);
  missing.documentCount = missing.documents.length;
  assert.throws(() => collectGameRemovalRestoreCandidates([{ source: 'missing.json', backup: missing }], {
    firestoreRoot: root, uid, myNames: aliases, restorePlayers: ['RaidenBrah'],
  }), /missing the upload snapshot/);
});

test('restore plan fails closed on existing uploads and stale game/node preconditions', () => {
  const t = target('g1', 'GManifesto 6k vs RaidenBrah 19k');
  const selection = collectGameRemovalRestoreCandidates([{ source: 'backup.json', backup: backup([t]) }], {
    firestoreRoot: root, uid, myNames: aliases, restorePlayers: ['RaidenBrah'],
  });
  const current = liveDocs(selection);
  current.set(t.uploadDocName, doc(t.uploadDocName, { marker: { stringValue: 'already-there' } }, 'new-time'));
  assert.throws(() => buildGameRemovalRestorePlan(selection, current), /already present/);

  current.delete(t.uploadDocName);
  current.set(t.gameDocName, doc(t.gameDocName, {}, 'changed'));
  assert.throws(() => buildGameRemovalRestorePlan(selection, current), /game changed since backup/);

  current.set(t.gameDocName, doc(t.gameDocName, {}, t.gameUpdateTime));
  current.delete(t.gameNodeDocName);
  assert.throws(() => buildGameRemovalRestorePlan(selection, current), /game-node is missing/);
});
