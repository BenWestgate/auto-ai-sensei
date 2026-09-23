#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CDP = 'http://127.0.0.1:9222';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_SENSEI = path.join(ROOT, 'src', 'ai-sensei.mjs');
const CLEANUP_PLAN = path.join(ROOT, 'cleanup-plan.json');
const OGS_PLAN = path.join(ROOT, 'ogs-import-plan.json');

export function valuesForFlag(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
}

export function hasFlag(args, flag) {
  return args.includes(flag);
}

export function splitNames(value) {
  return [...new Set(String(value ?? '').split(',').map(x => x.trim()).filter(Boolean))];
}

export function withDefaultCdp(args) {
  if (hasFlag(args, '--cdp') || hasFlag(args, '--profile-dir')) return [...args];
  return ['--cdp', DEFAULT_CDP, ...args];
}

function rejectUnsafeWorkflowFlags(args, flags) {
  for (const flag of flags) {
    if (hasFlag(args, flag)) {
      throw new Error(`${flag} is managed by this guided workflow. Remove it and rerun the command.`);
    }
  }
}

function authArgsFrom(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cdp' || args[i] === '--profile-dir') {
      out.push(args[i], args[i + 1]);
      i++;
    } else if (args[i] === '--headless' || args[i] === '--verbose') {
      out.push(args[i]);
    }
  }
  return withDefaultCdp(out);
}

function runAiSensei(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AI_SENSEI, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`Auto AI Sensei stopped by signal ${signal}.`));
      else if (code !== 0) reject(new Error(`Auto AI Sensei exited with status ${code}.`));
      else resolve();
    });
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function prompt(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This guided command needs an interactive terminal for confirmation.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptNames(question) {
  while (true) {
    const names = splitNames(await prompt(question));
    if (names.length) return names;
    console.log('Please enter at least one name.');
  }
}

async function confirmExactPlan(kind, hash) {
  const answer = await prompt(`\nType YES to apply this exact ${kind} plan (${hash}), or press Enter to cancel: `);
  if (answer !== 'YES') {
    console.log('Cancelled. Nothing was changed.');
    return false;
  }
  return true;
}

async function runSelfTest(args) {
  console.log('\nChecking browser, login, Node.js, and AI Sensei compatibility first...');
  await runAiSensei([...authArgsFrom(args), '--self-test']);
}

async function uploadGames(rawArgs) {
  rejectUnsafeWorkflowFlags(rawArgs, [
    '--ogs-import', '--allow-ogs-upload', '--confirm-ogs', '--execute', '--confirm', '--allow-create',
  ]);
  let args = withDefaultCdp(rawArgs);
  let accounts = valuesForFlag(args, '--ogs-account');
  if (!accounts.length) {
    accounts = await promptNames('OGS username(s), separated by commas: ');
    for (const account of accounts) args.push('--ogs-account', account);
  }

  await runSelfTest(args);
  const planArgs = [...args, '--ogs-import'];
  console.log('\nBuilding the complete OGS upload plan. No games will be uploaded yet...');
  await runAiSensei(planArgs);
  const plan = await readJson(OGS_PLAN);
  console.log('\nUPLOAD PLAN READY');
  console.log(`  OGS accounts:          ${plan.accounts?.map(x => x.username ?? x.requested).join(', ') || accounts.join(', ')}`);
  console.log(`  unique games found:    ${plan.totalUniqueGames ?? plan.games?.length ?? 0}`);
  console.log(`  selected for checking: ${plan.selectedGameCount ?? plan.games?.length ?? 0}`);
  console.log(`  small boards noted:    ${plan.selectedSmallBoardCount ?? 0}`);
  console.log(`  plan hash:             ${plan.planHash}`);
  console.log('Existing/checkpointed games are rechecked or skipped safely; unmatched games use AI Sensei\'s normal upload UI.');

  if (!await confirmExactPlan('upload', plan.planHash)) return;
  console.log('\nRecomputing the plan and applying it only if the hash is unchanged...');
  await runAiSensei([...planArgs, '--allow-ogs-upload', '--confirm-ogs', plan.planHash]);
}

async function updateProblems(rawArgs) {
  rejectUnsafeWorkflowFlags(rawArgs, [
    '--execute', '--confirm', '--allow-create', '--repair-solutions-plan', '--remove-player',
  ]);
  let args = withDefaultCdp(rawArgs);
  let aliases = valuesForFlag(args, '--me');
  if (!aliases.length) {
    aliases = await promptNames('Your player name(s)/aliases, separated by commas: ');
    for (const alias of aliases) args.push('--me', alias);
  }

  await runSelfTest(args);
  console.log('\nBuilding the practice-problem plan. Nothing will be changed yet...');
  await runAiSensei(args);
  const plan = await readJson(CLEANUP_PLAN);
  const mutations = Number(plan.createCount ?? 0) + Number(plan.updateCount ?? 0) + Number(plan.deleteCount ?? 0);
  console.log('\nPRACTICE PLAN READY');
  console.log(`  keep unchanged: ${plan.keepCount ?? 0}`);
  console.log(`  create:         ${plan.createCount ?? 0}`);
  console.log(`  update in place:${String(plan.updateCount ?? 0).padStart(2, ' ')}`);
  console.log(`  delete old/superseded: ${plan.deleteCount ?? 0}`);
  console.log(`  safely skipped: ${plan.skipCount ?? 0}`);
  console.log(`  no problem needed: ${plan.noneCount ?? 0}`);
  console.log(`  plan hash:      ${plan.planHash}`);
  console.log('An existing saved problem is preserved whenever its move remains in the distinct top-3 point-loss set; same-position updates keep its training history.');

  if (!mutations && !(plan.gameRemovalCount ?? 0)) {
    console.log('\nNo practice-problem changes are required.');
    return;
  }
  if (plan.gameRemovalCount) {
    throw new Error('The guided problem workflow refuses plans that remove games. Use the advanced CLI only after reviewing game-removal intent.');
  }
  if (!await confirmExactPlan('practice-problem', plan.planHash)) return;

  const executeArgs = [...args, '--execute', '--confirm', plan.planHash];
  if (Number(plan.createCount ?? 0) > 0) executeArgs.push('--allow-create');
  console.log('\nRecomputing the plan and applying it only if the hash is unchanged...');
  await runAiSensei(executeArgs);
}

function usage() {
  console.log(`Auto AI Sensei guided workflows\n\nCommands:\n  npm run upload-games       Plan, confirm, then upload all completed OGS games\n  npm run update-problems    Plan, confirm, then reconcile the practice set\n  npm run self-test          Check Node, browser/login, Firestore, and schema compatibility\n\nYou can also pass advanced identity flags after --, for example:\n  npm run upload-games -- --ogs-account YOUR_OGS_NAME\n  npm run update-problems -- --me YOUR_NAME --me ANOTHER_ALIAS\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'upload-games') return uploadGames(args);
  if (command === 'update-problems') return updateProblems(args);
  if (command === 'self-test') return runAiSensei([...withDefaultCdp(args), '--self-test']);
  usage();
  if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error(`ERROR: ${err?.message ?? err}`);
    process.exit(1);
  });
}
