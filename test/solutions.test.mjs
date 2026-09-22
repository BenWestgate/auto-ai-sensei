import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedFirstMovesFromSolutions,
  firestoreSolutionsForFirstMoves,
  hasExactFirstMoveSolutionEncoding,
  hasExactFirestoreFirstMoveSolutionEncoding,
  solutionKeyFromSolutions,
} from '../src/cleanup/solutions.mjs';

test('separate solution keys are alternative accepted first moves', () => {
  const solutions = { '0': ['ab'], '1': ['ac'], '2': ['cc'] };
  assert.deepEqual(acceptedFirstMovesFromSolutions(solutions), ['ab', 'ac', 'cc']);
  assert.equal(solutionKeyFromSolutions(solutions), 'first=ab|ac|cc');
});

test('later moves in one solution line are continuations, not alternatives', () => {
  const solutions = { '0': ['ab', 'ac'], '1': ['cc', 'dd'] };
  assert.deepEqual(acceptedFirstMovesFromSolutions(solutions), ['ab', 'cc']);
  assert.equal(solutionKeyFromSolutions(solutions), 'first=ab|cc');
});

test('writer emits one numbered one-move solution line per accepted first move', () => {
  assert.deepEqual(firestoreSolutionsForFirstMoves(['cc', 'ab', 'ac', 'ab']), {
    mapValue: {
      fields: {
        '0': { arrayValue: { values: [{ stringValue: 'ab' }] } },
        '1': { arrayValue: { values: [{ stringValue: 'ac' }] } },
        '2': { arrayValue: { values: [{ stringValue: 'cc' }] } },
      },
    },
  });
});

test('exact verifier rejects old malformed one-line encoding', () => {
  assert.equal(hasExactFirstMoveSolutionEncoding({ '0': ['ab', 'ac', 'cc'] }, ['ab', 'ac', 'cc']), false);
  assert.equal(hasExactFirstMoveSolutionEncoding({ '0': ['ab'], '1': ['ac'], '2': ['cc'] }, ['ab', 'ac', 'cc']), true);
});

test('raw Firestore verifier independently rejects packed alternatives', () => {
  const correct = firestoreSolutionsForFirstMoves(['ab', 'ac', 'cc']);
  const malformed = {
    mapValue: {
      fields: {
        '0': { arrayValue: { values: [
          { stringValue: 'ab' }, { stringValue: 'ac' }, { stringValue: 'cc' },
        ] } },
      },
    },
  };
  assert.equal(hasExactFirestoreFirstMoveSolutionEncoding(correct, ['ab', 'ac', 'cc']), true);
  assert.equal(hasExactFirestoreFirstMoveSolutionEncoding(malformed, ['ab', 'ac', 'cc']), false);
});

test('pass is normalized consistently in parser, writer, and verifier', () => {
  assert.deepEqual(acceptedFirstMovesFromSolutions({ '0': [''], '1': ['aa'] }), ['<pass>', 'aa']);
  assert.equal(hasExactFirstMoveSolutionEncoding({ '0': [''], '1': ['aa'] }, ['<pass>', 'aa']), true);
  assert.deepEqual(firestoreSolutionsForFirstMoves(['<pass>', 'aa']), {
    mapValue: {
      fields: {
        '0': { arrayValue: { values: [{ stringValue: '' }] } },
        '1': { arrayValue: { values: [{ stringValue: 'aa' }] } },
      },
    },
  });
});
