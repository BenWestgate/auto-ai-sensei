import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRemovedPlayerGame, playerColorFromGameName } from '../src/cleanup/identity.mjs';

const aliases = ['benwestg', 'GManifesto', '9Manifesto', 'MDINGICM', 'Me'];

test('owned RaidenBrah games remain owned regardless of title order', () => {
  const white = classifyRemovedPlayerGame('GManifesto 6k vs RaidenBrah 19k', aliases, ['RaidenBrah']);
  assert.equal(white.ownership.color, 'white');
  assert.equal(white.ownership.identityName, 'GManifesto');
  assert.equal(white.removable, false);

  const black = classifyRemovedPlayerGame('RaidenBrah 19k vs GManifesto 6k', aliases, ['RaidenBrah']);
  assert.equal(black.ownership.color, 'black');
  assert.equal(black.ownership.identityName, 'GManifesto');
  assert.equal(black.removable, false);

  const nine = classifyRemovedPlayerGame('9Manifesto 4k vs RaidenBrah 12k', aliases, ['RaidenBrah']);
  assert.equal(nine.ownership.identityName, '9Manifesto');
  assert.equal(nine.removable, false);

  const numericRating = classifyRemovedPlayerGame('RaidenBrah(800) vs benwestg(1671)', aliases, ['RaidenBrah']);
  assert.equal(numericRating.ownership.color, 'black');
  assert.equal(numericRating.ownership.identityName, 'benwestg');
  assert.equal(numericRating.removable, false);
});

test('foreign RaidenBrah games remain removable', () => {
  const result = classifyRemovedPlayerGame('Somebody 5k vs RaidenBrah 12k', aliases, ['RaidenBrah']);
  assert.equal(result.ownership.color, null);
  assert.equal(result.removable, true);
});

test('identity matching stays exact rather than substring based', () => {
  assert.equal(playerColorFromGameName('NotGManifesto 5k vs RaidenBrah 12k', aliases).color, null);
});
