import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasFlag,
  splitNames,
  valuesForFlag,
  withDefaultCdp,
} from '../src/workflow.mjs';

test('guided workflow parses repeated account/name flags', () => {
  const args = ['--ogs-account', 'one', '--ogs-account', 'two'];
  assert.deepEqual(valuesForFlag(args, '--ogs-account'), ['one', 'two']);
  assert.equal(hasFlag(args, '--ogs-account'), true);
});

test('guided workflow accepts comma-separated names and removes duplicates', () => {
  assert.deepEqual(splitNames('alpha, beta,alpha,  gamma '), ['alpha', 'beta', 'gamma']);
});

test('guided workflow defaults to the local CDP browser without overriding an explicit browser choice', () => {
  assert.deepEqual(withDefaultCdp(['--me', 'alpha']).slice(0, 2), ['--cdp', 'http://127.0.0.1:9222']);
  assert.deepEqual(withDefaultCdp(['--cdp', 'http://localhost:9333']), ['--cdp', 'http://localhost:9333']);
  assert.deepEqual(withDefaultCdp(['--profile-dir', '/tmp/profile']), ['--profile-dir', '/tmp/profile']);
});
