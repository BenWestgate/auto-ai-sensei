import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemoRestorePlan,
  memoRestoreAudit,
  splitMemoRestoreActions,
  validateMemoBackup,
} from '../src/cleanup/memo-backup.mjs';

const root = 'projects/test/databases/(default)/documents';
const uid = 'user-1';
const name = id => `${root}/:users/${uid}/:memos/${id}`;
const doc = (id, value, updateTime = '2026-09-17T00:00:00Z') => ({
  name: name(id),
  fields: { value: { stringValue: value } },
  updateTime,
});

test('restore plan exactly reconciles current memos to the raw backup', () => {
  const backup = {
    generatedAt: '2026-09-17T01:00:00Z',
    memoCount: 3,
    documents: [doc('same', 'same'), doc('changed', 'old'), doc('missing', 'restore-me')],
  };
  const current = [
    doc('same', 'same', '2026-09-17T02:00:00Z'),
    doc('changed', 'new', '2026-09-17T02:00:00Z'),
    doc('extra', 'remove-me', '2026-09-17T02:00:00Z'),
  ];

  const plan = buildMemoRestorePlan(backup, current, { firestoreRoot: root, uid });
  assert.deepEqual(plan.counts, { CREATE: 1, REPLACE: 1, DELETE: 1, UNCHANGED: 1 });
  assert.equal(plan.mutationCount, 3);
  assert.equal(plan.actions.find(row => row.name === name('missing')).action, 'CREATE');
  assert.equal(plan.actions.find(row => row.name === name('changed')).currentUpdateTime, '2026-09-17T02:00:00Z');
  assert.equal(plan.actions.find(row => row.name === name('extra')).action, 'DELETE');
  assert.equal(memoRestoreAudit(plan).actions.some(row => 'desired' in row), false);
});

test('restore plan is empty after exact restoration regardless of updateTime changes', () => {
  const backup = { memoCount: 2, documents: [doc('a', 'one'), doc('b', 'two')] };
  const current = [doc('a', 'one', 'later-a'), doc('b', 'two', 'later-b')];
  const plan = buildMemoRestorePlan(backup, current, { firestoreRoot: root, uid });
  assert.deepEqual(plan.counts, { CREATE: 0, REPLACE: 0, DELETE: 0, UNCHANGED: 2 });
  assert.equal(plan.mutationCount, 0);
});

test('restore rejects backups for another user and malformed counts', () => {
  assert.throws(
    () => buildMemoRestorePlan({ uid: 'other', memoCount: 0, documents: [] }, [], { firestoreRoot: root, uid }),
    /different Firebase user/,
  );
  assert.throws(
    () => buildMemoRestorePlan({ memoCount: 2, documents: [doc('a', 'one')] }, [], { firestoreRoot: root, uid }),
    /count mismatch/,
  );
});

test('backup validation accepts legacy snapshots but rejects unsafe document scope and duplicates', () => {
  const legacy = { memoCount: 1, documents: [doc('a', 'one')] };
  assert.doesNotThrow(() => validateMemoBackup(legacy, { firestoreRoot: root, uid }));

  assert.throws(
    () => validateMemoBackup({ version: 2, memoCount: 0, documents: [] }, { firestoreRoot: root, uid }),
    /Unsupported memo backup version/,
  );
  assert.throws(
    () => validateMemoBackup({ memoCount: 1, documents: [{ ...doc('a', 'one'), name: `${root}\/:users\/other\/:memos\/a` }] }, { firestoreRoot: root, uid }),
    /outside the authenticated memo collection/,
  );
  assert.throws(
    () => validateMemoBackup({ memoCount: 2, documents: [doc('a', 'one'), doc('a', 'two')] }, { firestoreRoot: root, uid }),
    /duplicate memo document/,
  );
});

test('restore actions are split so CREATE and REPLACE complete before DELETE', () => {
  const backup = { memoCount: 2, documents: [doc('changed', 'old'), doc('missing', 'restore-me')] };
  const current = [doc('changed', 'new'), doc('extra', 'remove-me')];
  const plan = buildMemoRestorePlan(backup, current, { firestoreRoot: root, uid });
  const phases = splitMemoRestoreActions(plan.actions);

  assert.deepEqual(phases.restore.map(row => row.action).sort(), ['CREATE', 'REPLACE']);
  assert.deepEqual(phases.deletions.map(row => row.action), ['DELETE']);
});
