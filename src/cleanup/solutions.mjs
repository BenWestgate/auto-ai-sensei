export function normalizeSolutionMove(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  // AI Sensei / SGF encodes pass as an empty coordinate.
  return s === '' ? '<pass>' : s;
}

function firestoreSolutionString(move) {
  return move === '<pass>' ? '' : move;
}

export function canonicalSolutionEntries(solutions) {
  if (!solutions || typeof solutions !== 'object' || Array.isArray(solutions)) return [];
  const keys = Object.keys(solutions).sort((a, b) => {
    const ai = /^\d+$/.test(a) ? Number(a) : Number.POSITIVE_INFINITY;
    const bi = /^\d+$/.test(b) ? Number(b) : Number.POSITIVE_INFINITY;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
  return keys.map(k => {
    const raw = solutions[k];
    const moves = Array.isArray(raw)
      ? raw.map(normalizeSolutionMove).filter(v => v != null)
      : [];
    return [String(k), moves];
  });
}

export function acceptedFirstMovesFromSolutions(solutions) {
  // Each numeric key is an alternative solution line. The array under that key
  // is the move sequence for that line, so only its first move is an accepted
  // first move. Later moves are continuations, not alternatives.
  return [...new Set(
    canonicalSolutionEntries(solutions)
      .map(([, moves]) => moves[0])
      .filter(Boolean),
  )].sort();
}

export function fullSolutionKeyFromSolutions(solutions) {
  const entries = canonicalSolutionEntries(solutions);
  if (!entries.length || entries.every(([, moves]) => moves.length === 0)) return null;
  return entries.map(([k, moves]) => `${k}=${moves.join('>')}`).join(';');
}

export function solutionKeyFromSolutions(solutions) {
  const firstMoves = acceptedFirstMovesFromSolutions(solutions);
  if (!firstMoves.length) return null;
  return `first=${firstMoves.join('|')}`;
}

export function firestoreSolutionsForFirstMoves(moves) {
  const unique = [...new Set((moves ?? []).map(normalizeSolutionMove).filter(Boolean))].sort();
  if (!unique.length) throw new Error('Cannot encode an empty solution set.');
  return {
    mapValue: {
      fields: Object.fromEntries(unique.map((move, i) => [
        String(i),
        { arrayValue: { values: [{ stringValue: firestoreSolutionString(move) }] } },
      ])),
    },
  };
}

export function hasExactFirstMoveSolutionEncoding(solutions, desiredMoves) {
  const desired = [...new Set((desiredMoves ?? []).map(normalizeSolutionMove).filter(Boolean))].sort();
  if (!desired.length || !solutions || typeof solutions !== 'object' || Array.isArray(solutions)) return false;

  const entries = canonicalSolutionEntries(solutions);
  if (entries.length !== desired.length) return false;
  for (let i = 0; i < entries.length; i++) {
    const [key, line] = entries[i];
    if (key !== String(i) || line.length !== 1 || line[0] !== desired[i]) return false;
  }
  return true;
}

export function hasExactFirestoreFirstMoveSolutionEncoding(value, desiredMoves) {
  const desired = [...new Set((desiredMoves ?? []).map(normalizeSolutionMove).filter(Boolean))].sort();
  if (!desired.length) return false;
  const fields = value?.mapValue?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields).sort((a, b) => Number(a) - Number(b));
  if (keys.length !== desired.length) return false;
  for (let i = 0; i < desired.length; i++) {
    const key = String(i);
    if (keys[i] !== key) return false;
    const values = fields[key]?.arrayValue?.values;
    if (!Array.isArray(values) || values.length !== 1) return false;
    if (normalizeSolutionMove(values[0]?.stringValue) !== desired[i]) return false;
  }
  return true;
}
