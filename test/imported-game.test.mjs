import assert from 'node:assert/strict';
import test from 'node:test';
import { importedGameMetadataFromUploadFields } from '../src/games/imported-game.mjs';

test('completed upload metadata safely reconstructs White vs Black title order', () => {
  const parsed = importedGameMetadataFromUploadFields({
    ':status': ':done',
    ':sgf-info': {
      ':board-size': 13,
      ':black': 'BlackPlayer',
      ':white': 'WhitePlayer',
      ':br': '6k',
      ':wr': '4k',
    },
  }, { id: 'upload-id', docName: 'upload-doc', updateTime: 'time' });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.game.name, 'WhitePlayer 4k vs BlackPlayer 6k');
  assert.equal(parsed.game.boardSize, 13);
  assert.equal(parsed.game.docName, 'upload-doc');
  assert.equal(parsed.game.updateTime, 'time');
});

test('unknown rank marker does not become part of the player identity label', () => {
  const parsed = importedGameMetadataFromUploadFields({
    ':status': ':done',
    ':sgf-info': {
      ':board-size': 19,
      ':black': 'Student',
      ':white': 'Opponent',
      ':br': '?',
      ':wr': '4k',
    },
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.game.name, 'Opponent 4k vs Student');
});

test('upload metadata fallback refuses incomplete or unsupported records', () => {
  assert.equal(importedGameMetadataFromUploadFields({
    ':status': ':queued',
    ':sgf-info': { ':board-size': 19, ':black': 'B', ':white': 'W' },
  }).ok, false);

  assert.equal(importedGameMetadataFromUploadFields({
    ':status': ':done',
    ':sgf-info': { ':board-size': '13:9', ':black': 'B', ':white': 'W' },
  }).reason, 'UPLOAD_SGF_INFO_UNSUPPORTED_BOARD_SIZE');

  assert.equal(importedGameMetadataFromUploadFields({
    ':status': ':done',
    ':sgf-info': { ':board-size': 19, ':black': '', ':white': 'W' },
  }).reason, 'UPLOAD_SGF_INFO_MISSING_PLAYERS');
});
