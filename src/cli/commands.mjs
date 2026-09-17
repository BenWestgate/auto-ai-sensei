import path from 'node:path';

export function invokedScriptPath({ cwd = process.cwd(), argv1 = process.argv[1] } = {}) {
  if (!argv1) return 'src/ai-sensei.mjs';
  return path.relative(cwd, argv1) || argv1;
}
