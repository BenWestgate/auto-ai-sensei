import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { invokedScriptPath } from '../src/cli/commands.mjs';

const script = path.resolve('src/ai-sensei.mjs');
const source = readFileSync(script, 'utf8');

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

test('--help is generic and contains no personal account defaults', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(source, /Auto AI Sensei/);
  assert.match(source, /--me NAME/);
  assert.match(source, /--ogs-account NAME/);
  assert.match(source, /--goquest-account NAME/);
  assert.match(source, /--restore-memos-backup PATH/);
  assert.match(source, /--restore-game-removal-backup PATH/);
  assert.match(source, /--restore-player NAME/);
  assert.match(source, /--self-test/);
  assert.match(source, /const DEFAULT_PLAYER_NAMES = Object\.freeze\(\[\]\);/);
  assert.match(source, /const DEFAULT_OGS_ACCOUNTS = Object\.freeze\(\[\]\);/);
  assert.match(source, /const DEFAULT_GOQUEST_ACCOUNTS = Object\.freeze\(\[\]\);/);
});

test('--self-test is allowed without a player alias', () => {
  const result = run('--self-test', '--execute');
  assert.equal(result.status, 1);
  assert.match(source, /--self-test is read-only/);
});

test('cleanup requires an explicit player alias before authentication', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(source, /cleanup requires at least one --me NAME/);
});

test('OGS import requires an explicit account', () => {
  const result = run('--ogs-import');
  assert.equal(result.status, 1);
  assert.match(source, /--ogs-import requires at least one --ogs-account NAME/);
});

test('GoQuest discovery requires an explicit account', () => {
  const result = run('--goquest-import');
  assert.equal(result.status, 1);
  assert.match(source, /--goquest-import requires at least one --goquest-account NAME/);
});

test('reviewed commands preserve the invoked src entrypoint', () => {
  assert.equal(
    invokedScriptPath({ cwd: '/repo', argv1: '/repo/src/ai-sensei.mjs' }),
    'src/ai-sensei.mjs',
  );
  assert.equal(
    invokedScriptPath({ cwd: '/repo', argv1: '/repo/tools/custom-entry.mjs' }),
    'tools/custom-entry.mjs',
  );
});
