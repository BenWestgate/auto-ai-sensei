#!/usr/bin/env node

/**
 * Auto AI Sensei: full-history practice-position planner + OGS/GoQuest importer.
 *
 * Target policy:
 *   - Teaching games count as serious games.
 *   - At most one qualifying practice problem per eligible game.
 *   - Consider only the user's played moves.
 *   - Rank mistakes by point loss, de-duplicating by the AI best FIRST solution move.
 *   - Take the top 3 distinct mistakes by point loss.
 *   - Among qualifying top-3 candidates, prefer larger win-rate drop, then point loss.
 *   - A candidate qualifies at >= 1.0 point loss OR >= 2 percentage-point win-rate loss.
 *   - If the canonical problem is already saved with the same first solution move, keep it.
 *   - Otherwise propose/create one canonical problem, then remove superseded problems.
 *   - If no candidate clears the floor, leave that game with zero practice problems.
 *
 * Full-history discovery:
 *   - Enumerates the user's :game-data/:uploads collection, plus any game IDs referenced
 *     by current memos. Games without usable analysis are reported and left untouched.
 *
 * Optional OGS import stage (--ogs-import):
 *   - Resolves account names supplied with --ogs-account via OGS's public REST API.
 *   - Enumerates completed, non-annulled games and de-duplicates shared game IDs.
 *   - Dry-run writes a hash-stable import plan. --allow-ogs-upload + --confirm-ogs
 *     submits reviewed SGFs through AI Sensei's normal authenticated upload UI.
 *   - OGS boards smaller than 7x7 are skipped before upload; 7x7 and larger continue.
 *   - Before opening AI Sensei's upload UI, fingerprints each OGS SGF by board size,
 *     initial setup, and exact main-line move sequence and compares it with the user's
 *     existing AI Sensei records. It indexes :games directly and reconstructs missing
 *     move lists from the main-line :down chain in :game-data/:nodes. Exact local
 *     matches never get uploaded.
 *   - AI Sensei's own "Game Already Analyzed" dialog remains the fallback authority
 *     for unmatched games. The importer always chooses "Go to game" and never
 *     "Reupload game".
 *   - A dedicated upload tab is validated immediately before real UI submissions. If it
 *     is closed/detached OR alive but no longer exposes the upload file input, the importer
 *     recreates it and retries that same game once; page-health failures do not count toward
 *     the AI Sensei service-failure circuit breaker.
 *   - Final transient AI Sensei service failures trigger adaptive cooldowns (30s, 60s, then
 *     120s capped) while successful UI outcomes reset the cooldown pressure.
 *   - If the attached Chromium browser itself disconnects, import stops immediately with
 *     BROWSER_DISCONNECTED instead of burning five games against a dead browser.
 *   - A checkpoint file makes interrupted imports resumable. Newly uploaded analyses can
 *     be polled before the full-history cleanup plan is regenerated.
 *
 * Optional GoQuest discovery stage (--goquest-import), read-only payload/linkage probe:
 *   - Queries public GoQuest Player-page data for accounts supplied with --goquest-account via the legacy
 *     Socket.IO 0.9 d4b6e7ef event using HTTP xhr-polling; no GoQuest credentials are read.
 *   - Probes go9, go13, and go19 separately because GoQuest profile data are game-type scoped.
 *   - Uses the public GoQuest web client in a script-owned headless Chromium tab to request each
 *     known category-specific lastGame ID, captures the complete public game payload from the
 *     web client's Socket.IO/XHR traffic, and never signs in.
 *   - Recursively inventories predecessor/next/history/cursor/sequence-shaped linkage fields and
 *     candidate linked game IDs without following unverified links or brute-forcing opaque IDs.
 *   - Runs a case-only public profile identifier diagnostic for target accounts that return
 *     NOT FOUND; it does not invent aliases or mutate account names beyond casing.
 *   - Preserves raw profile responses, raw captured game payloads, request-envelope evidence,
 *     normalized linkage JSON, and CSV audit files.
 *   - This stage is deliberately incapable of uploading anything to AI Sensei. There is no
 *     --allow-goquest-upload flag and no AI Sensei browser/session is opened.
 *
 * CREATE safety:
 *   - Existing memo at the selected canonical position is replaced when current analysis no longer accepts its saved first solution move.
 *   - New-problem solution extraction uses KataGo moveInfos from the analysis position
 *     immediately before the mistake. The dry-run reports how often this derived first
 *     move agrees with existing saved problems. Review that validation before execution.
 *   - Proposed backfills intentionally store only the validated first best move (one ply),
 *     which is a Firestore memo shape observed in AI Sensei's own bulk-add writes.
 *   - --execute is dry-run gated by the plan hash; any CREATE rows additionally require
 *     --allow-create. Creates are committed and verified BEFORE any deletions.
 *   - A full raw memo backup is written before execution.
 *   - Deletes use Firestore updateTime preconditions.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { gunzipSync, unzipSync, inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { invokedScriptPath } from './cli/commands.mjs';
import {
  MIN_POINT_LOSS,
  MIN_WR_DROP,
  TOP_POINT_LOSS_CANDIDATES,
  analysisTransitionForMove,
  chooseCanonicalFromTop3,
  directProblemColorAtMove,
  qualifiesPracticeFloor,
  selectTopDistinctByFirstSolutionMove,
} from './cleanup/policy.mjs';
import { importedGameMetadataFromUploadFields } from './games/imported-game.mjs';

const require = createRequire(import.meta.url);

const PROJECT_ID = 'sensei-160117';
const DATABASE = '(default)';
const FIRESTORE_ROOT = `projects/${PROJECT_ID}/databases/${DATABASE}/documents`;
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE}/documents`;
const FIREBASE_GMPID = '1:670187203450:web:08f09dc683cc81772384c3';
const PROFILE_DIR = path.resolve('.ai-sensei-playwright-profile');
const PLAN_JSON = path.resolve('cleanup-plan.json');
const PLAN_CSV = path.resolve('cleanup-plan.csv');
const DELETE_BATCH_SIZE = 200;
const CREATE_BATCH_SIZE = 100;
const ANALYSIS_CONCURRENCY = 8;
const DECISIVE = 0.90;
const LIVE_GAME = 0.10;
const MATERIAL_WR_DROP = 0.10;
const DEFAULT_PLAYER_NAMES = Object.freeze([]);

const DEFAULT_OGS_ACCOUNTS = Object.freeze([]);
const OGS_IMPORT_PLAN_JSON = path.resolve('ogs-import-plan.json');
const OGS_IMPORT_PLAN_CSV = path.resolve('ogs-import-plan.csv');
const OGS_IMPORT_STATE_JSON = path.resolve('ogs-import-state.json');
const OGS_BASE = 'https://online-go.com';
const OGS_API_BASE = `${OGS_BASE}/api/v1`;
const OGS_PAGE_SIZE = 100;
const OGS_REQUEST_DELAY_MS = 1250;
const OGS_LOCAL_DELAY_MS = 500;
const OGS_UPLOAD_DELAY_MS = 10_000;
const OGS_TRANSIENT_COOLDOWN_STEPS_MS = Object.freeze([30_000, 60_000, 120_000]);
const OGS_UPLOAD_TIMEOUT_MS = 180_000;
const OGS_ANALYSIS_POLL_MS = 15_000;
const OGS_UPLOAD_ATTEMPTS = 3;
const OGS_FAILURE_CIRCUIT_BREAKER = 5;
const MIN_OGS_ANALYSIS_BOARD_SIZE = 7;

const DEFAULT_GOQUEST_ACCOUNTS = Object.freeze([]);
const DEFAULT_GOQUEST_GTYPES = Object.freeze([
  'go9',
  'go13',
  'go19',
]);
const GOQUEST_SOCKET_IO_BASE = 'http://questgames.net:3002/socket.io/1/';
const GOQUEST_PROFILE_EVENT = 'd4b6e7ef';
const GOQUEST_IMPORT_PLAN_JSON = path.resolve('goquest-import-plan.json');
const GOQUEST_IMPORT_PLAN_CSV = path.resolve('goquest-import-plan.csv');
const GOQUEST_PROFILE_RAW_JSON = path.resolve('goquest-profile-probe-raw.json');
const GOQUEST_GAME_RAW_JSON = path.resolve('goquest-game-payloads-raw.json');
const GOQUEST_LINKAGE_JSON = path.resolve('goquest-linkage-plan.json');
const GOQUEST_LINKAGE_CSV = path.resolve('goquest-linkage-plan.csv');
const GOQUEST_REQUEST_TIMEOUT_MS = 20_000;
const GOQUEST_GAME_CAPTURE_TIMEOUT_MS = 30_000;
const GOQUEST_WEB_BASES = Object.freeze([
  'http://wars.fm',
  'https://wars.fm',
]);
const GOQUEST_DEFAULT_CHROMIUM = '/usr/bin/chromium';

function die(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    me: [...DEFAULT_PLAYER_NAMES],
    execute: false,
    allowCreate: false,
    confirm: null,
    headless: false,
    maxGames: null,
    profileDir: PROFILE_DIR,
    cdpUrl: null,
    verbose: false,
    ogsImport: false,
    ogsAccounts: [...DEFAULT_OGS_ACCOUNTS],
    allowOgsUpload: false,
    confirmOgs: null,
    maxOgsGames: null,
    ogsDelayMs: OGS_LOCAL_DELAY_MS,
    ogsUploadDelayMs: OGS_UPLOAD_DELAY_MS,
    waitAnalysisMinutes: 10,
    ogsUploadTimeoutMs: OGS_UPLOAD_TIMEOUT_MS,
    ogsUploadAttempts: OGS_UPLOAD_ATTEMPTS,
    goquestImport: false,
    goquestAccounts: [...DEFAULT_GOQUEST_ACCOUNTS],
    goquestGtypes: [...DEFAULT_GOQUEST_GTYPES],
    goquestTimeoutMs: GOQUEST_REQUEST_TIMEOUT_MS,
    goquestGameCaptureTimeoutMs: GOQUEST_GAME_CAPTURE_TIMEOUT_MS,
    goquestChromiumPath: GOQUEST_DEFAULT_CHROMIUM,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--me') out.me.push(argv[++i] ?? '');
    else if (a === '--execute') out.execute = true;
    else if (a === '--allow-create') out.allowCreate = true;
    else if (a === '--confirm') out.confirm = argv[++i] ?? null;
    else if (a === '--headless') out.headless = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--max-games') out.maxGames = Number(argv[++i]);
    else if (a === '--profile-dir') out.profileDir = path.resolve(argv[++i] ?? PROFILE_DIR);
    else if (a === '--cdp') out.cdpUrl = argv[++i] ?? null;
    else if (a === '--ogs-import') out.ogsImport = true;
    else if (a === '--ogs-account') out.ogsAccounts.push(argv[++i] ?? '');
    else if (a === '--allow-ogs-upload') out.allowOgsUpload = true;
    else if (a === '--confirm-ogs') out.confirmOgs = argv[++i] ?? null;
    else if (a === '--max-ogs-games') out.maxOgsGames = Number(argv[++i]);
    else if (a === '--ogs-delay-ms') out.ogsDelayMs = Number(argv[++i]);
    else if (a === '--ogs-upload-delay-ms') out.ogsUploadDelayMs = Number(argv[++i]);
    else if (a === '--wait-analysis-minutes') out.waitAnalysisMinutes = Number(argv[++i]);
    else if (a === '--ogs-upload-timeout-seconds') out.ogsUploadTimeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--ogs-upload-attempts') out.ogsUploadAttempts = Number(argv[++i]);
    else if (a === '--goquest-import') out.goquestImport = true;
    else if (a === '--goquest-account') out.goquestAccounts.push(argv[++i] ?? '');
    else if (a === '--goquest-gtype') out.goquestGtypes.push(argv[++i] ?? '');
    else if (a === '--goquest-timeout-seconds') out.goquestTimeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--goquest-game-timeout-seconds') out.goquestGameCaptureTimeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--goquest-chromium') out.goquestChromiumPath = path.resolve(argv[++i] ?? GOQUEST_DEFAULT_CHROMIUM);
    else if (a === '--help' || a === '-h') {
      console.log(`
Auto AI Sensei

Optional:
  --me NAME              Identify one of your player names/handles. Repeat as needed.
  --execute              Apply the reviewed plan. Without this, dry-run only.
  --allow-create         Required with --execute when the plan contains CREATE rows.
  --confirm HASH         Required with --execute. Use the hash printed by dry-run.
  --max-games N          Limit games for testing.
  --profile-dir PATH     Persistent Playwright browser profile.
  --cdp URL              Attach to an already-running Chrome/Chromium via CDP.
                         Recommended when Google blocks automated sign-in.
  --headless             Only works after the Playwright profile is already logged in.
  --verbose              Print additional schema-detection details.

OGS import stage (runs instead of cleanup planning):
  --ogs-import            Discover completed, non-annulled OGS games for the account(s)
                          supplied with --ogs-account. Dry-run by default.
  --ogs-account NAME      OGS account to import. Repeat as needed.
  --allow-ogs-upload      Actually submit the reviewed OGS import plan to AI Sensei.
  --confirm-ogs HASH      Required with --allow-ogs-upload; hash from OGS dry-run.
  --max-ogs-games N       Limit OGS submissions for a test run.
  --ogs-delay-ms N        Delay after local/no-upload OGS processing (default ${OGS_LOCAL_DELAY_MS} ms).
  --ogs-upload-delay-ms N Delay after a game touches the AI Sensei upload UI (default ${OGS_UPLOAD_DELAY_MS} ms).
  --wait-analysis-minutes N
                          After upload, wait up to N minutes for new analyses (default 10).
                          Set 0 to return immediately after submissions.
  --ogs-upload-timeout-seconds N
                          Wait for one AI Sensei upload outcome (default 180 seconds).
  --ogs-upload-attempts N  Retry transient upload/UI failures per game (default 3).

GoQuest discovery stage (intentionally read-only):
  --goquest-import         Probe public GoQuest profiles, retrieve known public game payloads,
                           and inspect them for historical-linkage fields. Never uploads.
  --goquest-account NAME   GoQuest account to inspect. Repeat as needed.
  --goquest-gtype TYPE     Add a game type to probe (go9, go13, go19). Repeat as needed.
  --goquest-timeout-seconds N
                           Public profile request/poll timeout (default 20 seconds).
  --goquest-game-timeout-seconds N
                           Per-game public web-client capture timeout (default 30 seconds).
  --goquest-chromium PATH  Chromium executable used only for public GoQuest game retrieval
                           (default /usr/bin/chromium).
  NOTE: there is no GoQuest upload flag. --goquest-import does not open AI Sensei or use
        --cdp; its browser is a separate temporary headless GoQuest-only process.

Examples:
  node src/ai-sensei.mjs --me YOUR_HANDLE --max-games 20 --verbose
  node src/ai-sensei.mjs --cdp http://127.0.0.1:9222 --me YOUR_HANDLE --max-games 20
  node src/ai-sensei.mjs --me YOUR_HANDLE --execute --allow-create --confirm 8ab12cd34ef5
  node src/ai-sensei.mjs --cdp http://127.0.0.1:9222 --ogs-import --ogs-account YOUR_OGS_HANDLE --max-ogs-games 20
  node src/ai-sensei.mjs --goquest-import --goquest-account YOUR_GOQUEST_HANDLE
`);
      process.exit(0);
    } else {
      die(`Unknown argument: ${a}`);
    }
  }

  out.me = [...new Set(out.me.map(s => s.trim()).filter(Boolean))];
  if (out.maxGames !== null && (!Number.isFinite(out.maxGames) || out.maxGames <= 0)) {
    die('--max-games must be a positive number.');
  }
  out.ogsAccounts = [...new Set(out.ogsAccounts.map(s => s.trim()).filter(Boolean))];
  out.goquestAccounts = [...new Set(out.goquestAccounts.map(s => s.trim()).filter(Boolean))];
  out.goquestGtypes = [...new Set(out.goquestGtypes.map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!out.ogsImport && !out.goquestImport && !out.me.length) {
    die('cleanup requires at least one --me NAME so your moves can be identified safely.');
  }
  if (out.maxOgsGames !== null && (!Number.isFinite(out.maxOgsGames) || out.maxOgsGames <= 0)) {
    die('--max-ogs-games must be a positive number.');
  }
  if (!Number.isFinite(out.ogsDelayMs) || out.ogsDelayMs < 500) {
    die('--ogs-delay-ms must be at least 500 ms.');
  }
  if (!Number.isFinite(out.ogsUploadDelayMs) || out.ogsUploadDelayMs < 500) {
    die('--ogs-upload-delay-ms must be at least 500 ms.');
  }
  if (!Number.isFinite(out.waitAnalysisMinutes) || out.waitAnalysisMinutes < 0) {
    die('--wait-analysis-minutes must be zero or a positive number.');
  }
  if (!Number.isFinite(out.ogsUploadTimeoutMs) || out.ogsUploadTimeoutMs < 30_000) {
    die('--ogs-upload-timeout-seconds must be at least 30 seconds.');
  }
  if (!Number.isFinite(out.ogsUploadAttempts) || out.ogsUploadAttempts < 1 || out.ogsUploadAttempts > 10 || !Number.isInteger(out.ogsUploadAttempts)) {
    die('--ogs-upload-attempts must be an integer from 1 to 10.');
  }
  if (!Number.isFinite(out.goquestTimeoutMs) || out.goquestTimeoutMs < 5_000 || out.goquestTimeoutMs > 120_000) {
    die('--goquest-timeout-seconds must be between 5 and 120 seconds.');
  }
  if (!Number.isFinite(out.goquestGameCaptureTimeoutMs) || out.goquestGameCaptureTimeoutMs < 5_000 || out.goquestGameCaptureTimeoutMs > 180_000) {
    die('--goquest-game-timeout-seconds must be between 5 and 180 seconds.');
  }
  if (out.ogsImport && !out.ogsAccounts.length) die('--ogs-import requires at least one --ogs-account NAME.');
  if (out.goquestImport && !out.goquestAccounts.length) die('--goquest-import requires at least one --goquest-account NAME.');
  if (!out.goquestGtypes.length || out.goquestGtypes.some(g => !/^go(?:9|13|19)$/.test(g))) {
    die('--goquest-gtype values must be go9, go13, or go19.');
  }
  if (out.ogsImport && out.goquestImport) {
    die('--ogs-import and --goquest-import are separate stages; choose one.');
  }
  if (out.goquestImport && out.execute) {
    die('--goquest-import is a read-only discovery stage and cannot be combined with cleanup --execute.');
  }
  if (out.goquestImport && (out.allowOgsUpload || out.confirmOgs)) {
    die('--goquest-import cannot be combined with OGS upload flags.');
  }
  if (out.ogsImport && out.execute) {
    die('--ogs-import is a separate stage. Do not combine it with cleanup --execute.');
  }
  if (out.allowOgsUpload && !out.ogsImport) {
    die('--allow-ogs-upload requires --ogs-import.');
  }
  if (out.allowOgsUpload && !out.confirmOgs) {
    die('--allow-ogs-upload requires --confirm-ogs HASH from an OGS dry run.');
  }
  if (out.execute && !out.confirm) {
    die('--execute requires --confirm HASH from a dry run.');
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(s) {
  const v = String(s);
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\"'\"'`)}'`;
}

function replayCliArgs(args) {
  const defaults = new Set(DEFAULT_PLAYER_NAMES.map(normalizeName));
  const parts = [];
  for (const name of args.me) {
    if (!defaults.has(normalizeName(name))) parts.push('--me', shellQuote(name));
  }
  if (Number.isFinite(args.maxGames)) parts.push('--max-games', String(args.maxGames));
  if (path.resolve(args.profileDir) !== PROFILE_DIR) parts.push('--profile-dir', shellQuote(args.profileDir));
  if (args.cdpUrl) parts.push('--cdp', shellQuote(args.cdpUrl));
  if (args.headless) parts.push('--headless');
  if (args.allowCreate) parts.push('--allow-create');
  return parts.join(' ');
}

function base64UrlDecode(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Unexpected Firebase token format');
  return JSON.parse(base64UrlDecode(parts[1]));
}

function normalizeColor(v) {
  const s = String(v ?? '').toLowerCase().replace(/^:/, '');
  if (s === 'black' || s === 'b') return 'black';
  if (s === 'white' || s === 'w') return 'white';
  return null;
}

function opposite(color) {
  return color === 'black' ? 'white' : color === 'white' ? 'black' : null;
}

function decodeFsValue(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(decodeFsValue);
  if ('mapValue' in v) return decodeFsFields(v.mapValue?.fields ?? {});
  return v;
}

function decodeFsFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeFsValue(v);
  return out;
}

function docId(docName) {
  return String(docName).split('/').at(-1);
}

function normalizeSolutionMove(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  // AI Sensei / SGF encodes pass as an empty coordinate.
  return s === '' ? '<pass>' : s;
}

function canonicalSolutionEntries(solutions) {
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

function primarySolutionMoves(solutions) {
  const first = canonicalSolutionEntries(solutions).find(([k]) => k === '0');
  if (!first) return [];
  // Key the AI Sensei "Avoid same move" behavior by the move(s) accepted at the
  // FIRST ply of the solution. Later reply moves do not make it a different
  // "same move" problem. Sort/dedupe so Firestore array ordering cannot matter.
  return [...new Set(first[1])].sort();
}

function fullSolutionKeyFromSolutions(solutions) {
  const entries = canonicalSolutionEntries(solutions);
  if (!entries.length || entries.every(([, moves]) => moves.length === 0)) return null;
  return entries.map(([k, moves]) => `${k}=${moves.join('>')}`).join(';');
}

function solutionKeyFromSolutions(solutions) {
  const firstMoves = primarySolutionMoves(solutions);
  if (!firstMoves.length) return null;
  // User-confirmed AI Sensei semantics: "same move" means the same solution move
  // recurring at different turns (for example, both players repeatedly miss the
  // same critical play). Only the first solution ply defines the de-duplication key.
  return `first=${firstMoves.join('|')}`;
}

function parseMemo(doc) {
  const f = decodeFsFields(doc.fields);
  const solutions = f[':solutions'] ?? null;
  return {
    id: docId(doc.name),
    docName: doc.name,
    gameId: f[':game-id'] ?? null,
    moveNumber: Number.isInteger(f[':move-number']) ? f[':move-number'] : null,
    level: Number.isFinite(f[':level']) ? Number(f[':level']) : 0,
    variation: f[':variation'] ?? [],
    solutions,
    primarySolutionMoves: primarySolutionMoves(solutions),
    solutionKey: solutionKeyFromSolutions(solutions),
    fullSolutionKey: fullSolutionKeyFromSolutions(solutions),
    uploadDate: f[':upload-date'] ?? null,
    updatedAtField: f[':updated-at'] ?? null,
    updateTime: doc.updateTime ?? null,
    raw: f,
  };
}

function parseGameDoc(doc) {
  const f = decodeFsFields(doc.fields);
  return {
    id: docId(doc.name),
    docName: doc.name,
    updateTime: doc.updateTime ?? null,
    name: String(f[':name'] ?? ''),
    boardSize: Number.isInteger(f[':board-size']) ? f[':board-size'] : 19,
    moves: f[':moves'] ?? [],
    raw: f,
  };
}

function plainifyTransit(value, seen = new Set()) {
  if (value == null || typeof value !== 'object') {
    if (typeof value === 'string') return value;
    return value;
  }
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) return value.map(v => plainifyTransit(v, seen));

  // transit-js maps expose forEach/get/size rather than enumerable plain-object fields.
  if (
    typeof value.forEach === 'function' &&
    typeof value.get === 'function' &&
    typeof value.size === 'number'
  ) {
    const out = {};
    value.forEach((v, k) => {
      out[String(k)] = plainifyTransit(v, seen);
    });
    return out;
  }

  // Transit keywords/symbols stringify to their readable representation.
  const ctorName = value?.constructor?.name ?? '';
  if (/Keyword|Symbol/.test(ctorName)) return String(value);

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return Array.from(value);

  const out = {};
  for (const [k, v] of Object.entries(value)) out[String(k)] = plainifyTransit(v, seen);
  return out;
}

function looksLikeTransitJson(text, parsed) {
  if (typeof text === 'string' && (/"~[:#]/.test(text) || /"\^ "/.test(text))) return true;
  if (Array.isArray(parsed) && parsed[0] === '^ ') return true;
  return false;
}

function parseCompressedAnalysisText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'GZIP_DECOMPRESSED_EMPTY' };

  let parsedJson = null;
  try { parsedJson = JSON.parse(trimmed); } catch {}

  if (parsedJson != null && !looksLikeTransitJson(trimmed, parsedJson)) {
    return { ok: true, format: 'json', payload: parsedJson };
  }

  // AI Sensei is a ClojureScript application and some compact payloads are Transit JSON.
  // transit-js is tiny, FOSS, and lets us read the exact encoding instead of guessing.
  try {
    const transit = require('transit-js');
    const reader = transit.reader('json');
    const transitValue = reader.read(trimmed);
    return { ok: true, format: 'transit-json', payload: plainifyTransit(transitValue) };
  } catch (err) {
    if (parsedJson != null) {
      // JSON parsed but looked Transit-like. Returning the raw JSON would make cached
      // Transit references such as ^0 look like real field names, so fail closed.
      return {
        ok: false,
        reason: `TRANSIT_DECODE_FAILED:${err.message}`,
        preview: trimmed.slice(0, 500),
      };
    }
    return {
      ok: false,
      reason: `GZIP_PAYLOAD_PARSE_FAILED:${err.message}`,
      preview: trimmed.slice(0, 500),
    };
  }
}

function extractBase64FromFirestoreField(field) {
  if (field == null) return null;

  const directString = v => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      if (typeof v.bytesValue === 'string' && v.bytesValue.trim()) return v.bytesValue.trim();
      if (typeof v.stringValue === 'string' && v.stringValue.trim()) return v.stringValue.trim();
    }
    return null;
  };

  // Normal Firestore REST bytes field: {bytesValue: "...base64..."}.
  let hit = directString(field);
  if (hit) return hit;

  // Some AI Sensei documents wrap the bytes in a map, e.g.
  // {mapValue:{fields:{bytesValue:{stringValue:"..."}}}}. v5 only handled
  // the direct Firestore bytesValue form, which is why it could SEE
  // ':gzip.bytesValue' in the decoded schema without actually decompressing it.
  const preferredKeys = new Set(['bytesValue', ':bytesValue', 'bytes', ':bytes', 'data', ':data', 'payload', ':payload']);
  const seen = new Set();
  function walk(v, depth = 0) {
    if (v == null || depth > 8) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v !== 'object') return null;
    if (seen.has(v)) return null;
    seen.add(v);

    if (typeof v.bytesValue === 'string' && v.bytesValue.trim()) return v.bytesValue.trim();
    if (typeof v.stringValue === 'string' && v.stringValue.trim()) return v.stringValue.trim();

    const objects = [];
    if (v.mapValue?.fields && typeof v.mapValue.fields === 'object') objects.push(v.mapValue.fields);
    if (v.fields && typeof v.fields === 'object') objects.push(v.fields);
    objects.push(v);

    for (const obj of objects) {
      for (const key of preferredKeys) {
        if (!(key in obj)) continue;
        const s = directString(obj[key]) ?? walk(obj[key], depth + 1);
        if (s) return s;
      }
    }
    for (const obj of objects) {
      for (const child of Object.values(obj)) {
        const s = walk(child, depth + 1);
        if (s) return s;
      }
    }
    return null;
  }
  return walk(field);
}

function decodeBase64Flexible(s) {
  const cleaned = String(s ?? '')
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(cleaned + pad, 'base64');
}

function decodeGzipAnalysisField(doc) {
  const rawField = doc?.fields?.[':gzip'];
  if (rawField == null) return null;

  const b64 = extractBase64FromFirestoreField(rawField);
  if (typeof b64 !== 'string' || !b64.length) {
    return {
      ok: false,
      reason: 'GZIP_FIELD_PRESENT_BUT_BYTES_NOT_FOUND',
      fieldShape: Object.keys(rawField ?? {}).slice(0, 20),
    };
  }

  let compressed;
  try {
    compressed = decodeBase64Flexible(b64);
  } catch (err) {
    return { ok: false, reason: `GZIP_BASE64_DECODE_FAILED:${err.message}` };
  }
  if (!compressed.length) {
    return { ok: false, reason: 'GZIP_BASE64_DECODED_EMPTY' };
  }

  const attempts = [
    ['gzip', gunzipSync],
    ['zlib-or-gzip', unzipSync],
    ['deflate', inflateSync],
  ];
  const errors = [];
  for (const [codec, fn] of attempts) {
    try {
      const uncompressed = fn(compressed);
      const parsed = parseCompressedAnalysisText(uncompressed.toString('utf8'));
      return {
        ...parsed,
        codec,
        compressedBytes: compressed.length,
        uncompressedBytes: uncompressed.length,
        compressedMagic: compressed.subarray(0, 8).toString('hex'),
      };
    } catch (err) {
      errors.push(`${codec}:${err.message}`);
    }
  }
  return {
    ok: false,
    reason: `GZIP_DECOMPRESSION_FAILED:${errors.join(' | ')}`,
    compressedBytes: compressed.length,
    compressedMagic: compressed.subarray(0, 16).toString('hex'),
  };
}

function augmentDocWithCompressedAnalysis(doc, verbose = false, source = 'analysis-doc') {
  const fields = decodeFsFields(doc.fields);
  const compressedAnalysis = decodeGzipAnalysisField(doc);
  if (compressedAnalysis?.ok) fields[':decompressed-gzip'] = compressedAnalysis.payload;

  if (verbose && compressedAnalysis) {
    console.log(`    compressed analysis [${source}/${docId(doc.name)}]:`, compressedAnalysis.ok
      ? {
          ok: true,
          format: compressedAnalysis.format,
          codec: compressedAnalysis.codec,
          compressedBytes: compressedAnalysis.compressedBytes,
          uncompressedBytes: compressedAnalysis.uncompressedBytes,
          compressedMagic: compressedAnalysis.compressedMagic,
        }
      : {
          ok: false,
          reason: compressedAnalysis.reason,
          compressedBytes: compressedAnalysis.compressedBytes,
          compressedMagic: compressedAnalysis.compressedMagic,
          fieldShape: compressedAnalysis.fieldShape,
          preview: compressedAnalysis.preview,
        });
  }

  return {
    id: docId(doc.name),
    fields,
    name: doc.name,
    compressedAnalysis,
  };
}

function parseGameNodeDoc(doc) {
  const f = decodeFsFields(doc.fields);
  const arr = Array.isArray(f[':node-array']) ? f[':node-array'] : [];
  const byId = new Map();
  for (const n of arr) {
    if (n && Number.isInteger(n[':id'])) byId.set(n[':id'], n);
  }

  const compressedAnalysis = decodeGzipAnalysisField(doc);
  const raw = { ...f };
  if (compressedAnalysis?.ok) raw[':decompressed-gzip'] = compressedAnalysis.payload;

  return {
    id: docId(doc.name),
    nodes: arr,
    byId,
    raw,
    compressedAnalysis,
  };
}

function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isTeachingGameHumanLabel(label) {
  const s = normalizeName(label);
  return s.includes('human') && s.includes('teaching game');
}

function isNormalGameHumanLabel(label) {
  const s = normalizeName(label);
  return s.includes('human') && s.includes('normal game');
}

function isAiPlayerLabel(label) {
  // AI Sensei-generated AI opponents use labels such as
  // "AI (Calibrated Rank)" and "Humanlike bot". Match whole words so a
  // human username containing the letters "ai" is not misclassified.
  const s = normalizeName(label);
  return /(^|\s|\()ai(?=\s|\(|$)/i.test(s) || /\bbot\b/i.test(s) || s.includes('calibrated rank');
}

function stripTrailingRank(label) {
  let s = normalizeName(label);
  // AI Sensei game titles can append either a Go rank ("7k", "1d") or a
  // numeric server rating ("(1671)", "(1891)"). Strip those suffixes only.
  // Exact matching after suffix removal is important because short aliases
  // must not substring-match unrelated player names.
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*(?:\(|\[)?\s*\d+(?:\.\d+)?\s*(?:k|d|p|kyu|dan)\s*(?:\)|\])?\s*$/i, '');
    s = s.replace(/\s*[\(\[]\s*\d+(?:\.\d+)?\s*[\)\]]\s*$/i, '');
    // Chinese server rank suffixes, e.g. "player 8级" / "1段".
    s = s.replace(/\s*\d+(?:\.\d+)?\s*(?:级|段)\s*$/u, '');
  } while (s !== prev);
  return s.trim();
}

function playerColorFromGameName(gameName, myNames) {
  // AI Sensei's generated title is "White vs Black".
  const partsRaw = String(gameName).split(/\s+vs\s+/i);
  if (partsRaw.length !== 2) return { color: null, reason: 'GAME_NAME_NOT_WHITE_VS_BLACK' };

  // User-confirmed convention: in AI Sensei Teaching Games, "Human (Teaching Game)"
  // is always the user's side.
  const teachingWhite = isTeachingGameHumanLabel(partsRaw[0]);
  const teachingBlack = isTeachingGameHumanLabel(partsRaw[1]);
  if (teachingWhite !== teachingBlack) {
    return {
      color: teachingWhite ? 'white' : 'black',
      reason: teachingWhite ? 'TEACHING_GAME_HUMAN_WHITE' : 'TEACHING_GAME_HUMAN_BLACK',
    };
  }

  // User-confirmed convention: "Human (Normal Game)" is also the user's side
  // when the opponent is an AI/bot. Require the other side to look like an AI
  // so a generic human-vs-human import with that label is not guessed.
  const normalWhite = isNormalGameHumanLabel(partsRaw[0]);
  const normalBlack = isNormalGameHumanLabel(partsRaw[1]);
  if (normalWhite !== normalBlack) {
    const otherLooksAi = normalWhite ? isAiPlayerLabel(partsRaw[1]) : isAiPlayerLabel(partsRaw[0]);
    if (otherLooksAi) {
      return {
        color: normalWhite ? 'white' : 'black',
        reason: normalWhite ? 'NORMAL_GAME_HUMAN_VS_AI_WHITE' : 'NORMAL_GAME_HUMAN_VS_AI_BLACK',
      };
    }
  }

  // Otherwise match the player label exactly after removing only its trailing rank/rating.
  const [whiteLabel, blackLabel] = partsRaw.map(stripTrailingRank);
  const needles = [...new Set(myNames.map(normalizeName).filter(Boolean))];

  const whiteMatches = needles.filter(n => n === whiteLabel);
  const blackMatches = needles.filter(n => n === blackLabel);

  if (whiteMatches.length === 1 && blackMatches.length === 0) {
    return { color: 'white', reason: `MATCHED_WHITE:${whiteMatches[0]}` };
  }
  if (blackMatches.length === 1 && whiteMatches.length === 0) {
    return { color: 'black', reason: `MATCHED_BLACK:${blackMatches[0]}` };
  }
  if (isAiPlayerLabel(partsRaw[0]) && isAiPlayerLabel(partsRaw[1])) {
    return { color: null, reason: 'NO_USER_SIDE_AI_VS_AI', whiteLabel, blackLabel };
  }
  return {
    color: null,
    reason: 'PLAYER_NAME_AMBIGUOUS_OR_NOT_FOUND',
    whiteLabel,
    blackLabel,
  };
}

function inferAlternatingColorMap(game, gameNodes) {
  // AI Sensei's :node-array usually has a :color on each main-line node, but
  // occasionally the node for a saved problem is absent or lacks :color. Go
  // move colors still alternate (passes included), including handicap games;
  // handicap/setup stones only change which color owns the odd/even move IDs.
  //
  // Learn that phase from the colors AI Sensei *did* store instead of assuming
  // "odd = black". This is important for handicap games.
  const observations = [];
  for (const [id, node] of gameNodes?.byId ?? []) {
    if (!Number.isInteger(id) || id < 0) continue;
    const color = normalizeColor(node?.[':color']);
    if (!color) continue;
    observations.push({ id, color });
  }

  const phases = [
    { even: 'black', odd: 'white', label: 'EVEN_BLACK' },
    { even: 'white', odd: 'black', label: 'EVEN_WHITE' },
  ].map(phase => {
    let matches = 0;
    let mismatches = 0;
    for (const o of observations) {
      const predicted = o.id % 2 === 0 ? phase.even : phase.odd;
      if (predicted === o.color) matches++;
      else mismatches++;
    }
    return { ...phase, matches, mismatches };
  }).sort((a, b) => a.mismatches - b.mismatches || b.matches - a.matches);

  const best = phases[0];
  const second = phases[1];

  // Strongest case: all observed node colors agree with one alternating phase
  // and the opposite phase clearly does not. Two observations are enough to
  // establish the phase; in real games there are generally many more.
  if (
    best && best.matches >= 2 && best.mismatches === 0 &&
    second && second.mismatches > best.mismatches
  ) {
    return {
      ok: true,
      even: best.even,
      odd: best.odd,
      source: `NODE_PARITY:${best.label}`,
      matches: best.matches,
      mismatches: best.mismatches,
      observations: observations.length,
    };
  }

  // If a few nodes are exceptional (for example imported tree/setup metadata),
  // allow a phase only when it is overwhelmingly supported. Never use a bare
  // majority: deletion safety matters more than rescuing every game.
  if (
    best && best.matches >= 8 && best.matches >= 10 * Math.max(1, best.mismatches) &&
    second && best.matches > second.matches
  ) {
    return {
      ok: true,
      even: best.even,
      odd: best.odd,
      source: `NODE_PARITY_STRONG:${best.label}`,
      matches: best.matches,
      mismatches: best.mismatches,
      observations: observations.length,
    };
  }

  // Secondary check using the game document's :root-color. In AI Sensei's
  // game model the root node has a color and subsequent move-node colors
  // alternate from it. Only trust this when it agrees with every available
  // stored node color; this avoids guessing about imported SGF quirks.
  const rootColor = normalizeColor(game?.raw?.[':root-color']);
  if (rootColor) {
    const even = rootColor;
    const odd = opposite(rootColor);
    let matches = 0;
    let mismatches = 0;
    for (const o of observations) {
      const predicted = o.id % 2 === 0 ? even : odd;
      if (predicted === o.color) matches++;
      else mismatches++;
    }
    if (matches >= 1 && mismatches === 0) {
      return {
        ok: true,
        even,
        odd,
        source: 'ROOT_COLOR_VALIDATED',
        matches,
        mismatches,
        observations: observations.length,
      };
    }
  }

  return {
    ok: false,
    source: 'NO_SAFE_ALTERNATING_COLOR_PHASE',
    observations: observations.length,
    phases,
    rootColor,
  };
}

function inferColorFromNearestNodes(actualMoveNumber, gameNodes) {
  // Local fallback for unusual node arrays where global parity is noisy.
  // Use the nearest known node on each side. A known color shifted by an even
  // number of plies stays the same; shifted by an odd number flips. If both
  // sides exist they must independently predict the same color.
  const known = [];
  for (const [id, node] of gameNodes?.byId ?? []) {
    if (!Number.isInteger(id)) continue;
    const color = normalizeColor(node?.[':color']);
    if (color) known.push({ id, color });
  }
  if (!known.length) return { color: null, source: 'NO_NEIGHBOR_COLORS' };

  const below = known
    .filter(x => x.id < actualMoveNumber)
    .sort((a, b) => b.id - a.id)[0] ?? null;
  const above = known
    .filter(x => x.id > actualMoveNumber)
    .sort((a, b) => a.id - b.id)[0] ?? null;

  const predict = anchor => {
    if (!anchor) return null;
    const delta = Math.abs(actualMoveNumber - anchor.id);
    return delta % 2 === 0 ? anchor.color : opposite(anchor.color);
  };
  const pBelow = predict(below);
  const pAbove = predict(above);

  if (pBelow && pAbove && pBelow === pAbove) {
    return {
      color: pBelow,
      source: `NEIGHBOR_BOTH:${below.id},${above.id}`,
    };
  }

  // A single adjacent anchor is safe: it is exactly one alternating ply away.
  if (below && actualMoveNumber - below.id === 1 && !above) {
    return { color: pBelow, source: `NEIGHBOR_PREV_ADJACENT:${below.id}` };
  }
  if (above && above.id - actualMoveNumber === 1 && !below) {
    return { color: pAbove, source: `NEIGHBOR_NEXT_ADJACENT:${above.id}` };
  }

  return {
    color: null,
    source: 'NEIGHBOR_INFERENCE_CONFLICT_OR_WEAK',
    below,
    above,
    pBelow,
    pAbove,
  };
}

function resolveProblemColor(actualMoveNumber, game, gameNodes, alternatingMap) {
  const direct = normalizeColor(directProblemColorAtMove(actualMoveNumber, gameNodes?.byId));
  if (direct) return { color: direct, source: 'DIRECT_NODE' };

  // Firestore :move-number identifies the move being trained. Prefer that
  // move's direct node color. A custom problem may exceptionally target the
  // next move after the recorded game, so allow exactly game length + 1 and
  // infer its color from the validated alternating phase. Reject anything
  // farther beyond the game.
  if (!Number.isInteger(actualMoveNumber) || actualMoveNumber < 1) {
    return { color: null, source: 'INVALID_ACTUAL_MOVE_NUMBER' };
  }
  const gameLength = Array.isArray(game?.moves) ? game.moves.length : 0;
  if (gameLength && actualMoveNumber > gameLength + 1) {
    return {
      color: null,
      source: `MOVE_NUMBER_TOO_FAR_BEYOND_GAME:${actualMoveNumber}>${gameLength + 1}`,
    };
  }

  if (alternatingMap?.ok) {
    const color = actualMoveNumber % 2 === 0 ? alternatingMap.even : alternatingMap.odd;
    const suffix = gameLength && actualMoveNumber === gameLength + 1 ? ':NEXT_MOVE_AFTER_GAME_END' : '';
    return {
      color,
      source: `${alternatingMap.source}${suffix}`,
    };
  }

  const neighbor = inferColorFromNearestNodes(actualMoveNumber, gameNodes);
  if (neighbor.color && gameLength && actualMoveNumber === gameLength + 1) {
    neighbor.source = `${neighbor.source}:NEXT_MOVE_AFTER_GAME_END`;
  }
  return neighbor;
}

function chooseRepresentativeMemo(memos) {
  // Same-move duplicates are semantically equivalent for this cleanup.
  // Preserve the record with the most training progress; use recency as tie-breaker.
  return [...memos].sort((a, b) => {
    if (b.level !== a.level) return b.level - a.level;
    return String(b.updateTime ?? '').localeCompare(String(a.updateTime ?? ''));
  })[0];
}

function groupBy(items, fn) {
  const m = new Map();
  for (const item of items) {
    const key = fn(item);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(item);
  }
  return m;
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return Infinity;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function flattenScalars(value, prefix = '', out = []) {
  if (value == null) return out;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    out.push([prefix, value]);
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) flattenScalars(value[i], `${prefix}[${i}]`, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenScalars(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

function numericIdFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = [':id', 'id', ':move-number', 'move-number', ':moveNumber', 'moveNumber', ':node-id', 'node-id', ':nodeId', 'nodeId'];
  for (const k of keys) {
    const v = obj[k];
    if (Number.isInteger(v) && v >= 0 && v < 2000) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function collectAnalysisObjects(value, out = [], seen = new Set(), expectedNodeIds = null, pathName = '') {
  if (value == null || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (!Array.isArray(value)) {
    const id = numericIdFromObject(value);
    if (id != null) out.push({ id, value, sourcePath: pathName });
    for (const [k, child] of Object.entries(value)) {
      collectAnalysisObjects(child, out, seen, expectedNodeIds, pathName ? `${pathName}.${k}` : k);
    }
  } else {
    // Some compact AI Sensei payloads store one analysis object per node in an
    // array and omit the id inside each entry. If the array indexes line up with
    // known game-node ids, index i is a safe node id. Metric evidence later still
    // has to match recognized score/win/loss field names before this is used.
    if (expectedNodeIds?.size) {
      let candidateCount = 0;
      let matchedCount = 0;
      for (const id of expectedNodeIds) {
        const child = value[id];
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          candidateCount++;
          if (numericIdFromObject(child) == null) matchedCount++;
        }
      }
      if (candidateCount >= 2 && matchedCount / candidateCount >= 0.5) {
        for (const id of expectedNodeIds) {
          const child = value[id];
          if (child && typeof child === 'object' && !Array.isArray(child) && numericIdFromObject(child) == null) {
            out.push({ id, value: child, sourcePath: `${pathName}[${id}]` });
          }
        }
      }
    }
    for (let i = 0; i < value.length; i++) {
      collectAnalysisObjects(value[i], out, seen, expectedNodeIds, `${pathName}[${i}]`);
    }
  }
  return out;
}

function metricScore(pathName, type) {
  const p = pathName.toLowerCase();
  let score = 0;

  if (/visits|policy|prior|ownership|stdev|stddev|variance|radius|weight|count|id|move-number|move_number/.test(p)) score -= 100;

  if (type === 'loss') {
    if (/point.?loss|points.?lost|loss.?points|score.?loss|lost.?points|mistake.?size|error.?size|score.?delta|point.?delta/.test(p)) score += 240;
    else if (/(^|[.:_\-])loss($|[.:_\-])/.test(p)) score += 100;
    if (/win|percent|prob/.test(p)) score -= 80;
  } else if (type === 'win') {
    if (/win.?rate|winrate|win.?prob|winning.?prob|win.?percent|win.?pct/.test(p)) score += 240;
    else if (/win/.test(p) && /rate|prob|percent|pct/.test(p)) score += 180;
    else if (/win/.test(p)) score += 70;
    if (/loss|score|point/.test(p)) score -= 70;
  } else if (type === 'score') {
    if (/score.?lead|scorelead|lead.?score/.test(p)) score += 240;
    else if (/score.?mean|mean.?score/.test(p)) score += 200;
    else if (/(^|[.:_\-])score($|[.:_\-])/.test(p)) score += 150;
    else if (/point.?lead|points.?lead/.test(p)) score += 140;
    if (/loss|stdev|stddev|variance/.test(p)) score -= 100;
  }

  if (/black/.test(p)) score += 15;
  if (/white/.test(p)) score += 10;
  return score;
}

function pickMetric(obj, type) {
  const leaves = flattenScalars(obj).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  const ranked = leaves
    .map(([p, v]) => ({ path: p, value: v, score: metricScore(p, type) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}

function normalizeWinrate(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= -1e-9 && v <= 1 + 1e-9) return Math.max(0, Math.min(1, v));
  if (v >= -1e-9 && v <= 100 + 1e-9) return Math.max(0, Math.min(1, v / 100));
  return null;
}

function orientationHint(pathName) {
  const p = String(pathName).toLowerCase();
  if (/black/.test(p)) return 'black';
  if (/white/.test(p)) return 'white';
  if (/current|to.?move|side.?to.?move|player/.test(p)) return 'side-to-move';
  if (/mover|played/.test(p)) return 'mover';
  return 'unknown';
}

function smoothness(series) {
  const ids = [...series.keys()].sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] !== ids[i - 1] + 1) continue;
    const a = series.get(ids[i - 1]);
    const b = series.get(ids[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(Math.abs(b - a));
  }
  return median(diffs);
}

function orientWinrate(rawSeries, metricPath, gameNodes) {
  const hint = orientationHint(metricPath);
  const candidates = new Map();

  const directBlack = new Map();
  const directWhite = new Map();
  const sideToMove = new Map();
  const mover = new Map();

  for (const [id, raw] of rawSeries.entries()) {
    const wr = normalizeWinrate(raw);
    if (wr == null) continue;
    directBlack.set(id, wr);
    directWhite.set(id, 1 - wr);

    const node = gameNodes.get(id);
    const moverColor = normalizeColor(node?.[':color']);
    const stm = opposite(moverColor); // position after node id: normally opponent to move
    if (stm) sideToMove.set(id, stm === 'black' ? wr : 1 - wr);
    if (moverColor) mover.set(id, moverColor === 'black' ? wr : 1 - wr);
  }

  candidates.set('black', directBlack);
  candidates.set('white', directWhite);
  candidates.set('side-to-move', sideToMove);
  candidates.set('mover', mover);

  if (hint !== 'unknown' && candidates.get(hint)?.size) {
    return { series: candidates.get(hint), orientation: hint, smoothness: smoothness(candidates.get(hint)) };
  }

  const ranked = [...candidates.entries()]
    .filter(([, s]) => s.size >= 2)
    .map(([name, s]) => ({ name, series: s, smoothness: smoothness(s) }))
    .sort((a, b) => a.smoothness - b.smoothness);
  if (!ranked.length) return null;
  return { series: ranked[0].series, orientation: ranked[0].name, smoothness: ranked[0].smoothness };
}

function orientScore(rawSeries, metricPath, gameNodes) {
  const hint = orientationHint(metricPath);
  const directBlack = new Map();
  const directWhite = new Map();
  const sideToMove = new Map();
  const mover = new Map();

  for (const [id, raw] of rawSeries.entries()) {
    if (!Number.isFinite(raw)) continue;
    directBlack.set(id, raw);
    directWhite.set(id, -raw);
    const node = gameNodes.get(id);
    const moverColor = normalizeColor(node?.[':color']);
    const stm = opposite(moverColor);
    if (stm) sideToMove.set(id, stm === 'black' ? raw : -raw);
    if (moverColor) mover.set(id, moverColor === 'black' ? raw : -raw);
  }

  const candidates = new Map([
    ['black', directBlack], ['white', directWhite], ['side-to-move', sideToMove], ['mover', mover],
  ]);

  if (hint !== 'unknown' && candidates.get(hint)?.size) {
    return { series: candidates.get(hint), orientation: hint, smoothness: smoothness(candidates.get(hint)) };
  }

  const ranked = [...candidates.entries()]
    .filter(([, s]) => s.size >= 2)
    .map(([name, s]) => ({ name, series: s, smoothness: smoothness(s) }))
    .sort((a, b) => a.smoothness - b.smoothness);
  if (!ranked.length) return null;
  return { series: ranked[0].series, orientation: ranked[0].name, smoothness: ranked[0].smoothness };
}

function firestoreAnalysisPositionId(docIdValue) {
  const id = String(docIdValue ?? '').trim();
  // AI Sensei's :analysis/<game>/:nodes collection uses document ids
  // ":root", ":1", ":2", ... for positions.  The leading colon is part
  // of the actual Firestore document id.  Position 0 is the root.
  if (id === ':root' || id === 'root') return 0;
  const m = id.match(/^:?(\d+)$/);
  return m ? Number(m[1]) : null;
}

function buildAnalysisAdapterFromPlainDocs(plainDocs, gameNodeMap, verbose = false, source = 'unknown') {

  const objects = [];
  const expectedIds = new Set(gameNodeMap.keys());
  const authoritativeDocIds = [];

  for (const d of plainDocs) {
    const positionId = firestoreAnalysisPositionId(d.id);

    if (positionId != null) {
      // For AI Sensei analysis docs, the Firestore document id is the
      // authoritative game-position id.  The decompressed KataGo payload can
      // itself contain unrelated numeric `id` fields (for candidate moves /
      // variations).  Treating those nested ids as game positions was the v6
      // bug that collapsed a 39-position game into only 16 metric points.
      //
      // Keep the whole decoded document as one candidate for this position so
      // pickMetric() can find root winrate/scoreLead anywhere inside it.
      objects.push({
        id: positionId,
        value: d.fields,
        sourcePath: `${d.name ?? d.id ?? source}#firestore-doc-id`,
        authoritativeDocId: true,
      });
      authoritativeDocIds.push(positionId);
      continue;
    }

    // Fall back to schema inference only for collections whose document ids do
    // not directly encode the game position.
    collectAnalysisObjects(d.fields, objects, new Set(), expectedIds, d.name ?? d.id ?? source);
  }

  if (verbose && authoritativeDocIds.length) {
    const ids = [...new Set(authoritativeDocIds)].sort((a, b) => a - b);
    console.log(`    analysis position docs [${source}]:`, {
      count: ids.length,
      first: ids.slice(0, 10),
      last: ids.slice(-10),
    });
  }

  // For each move id, keep the object with the strongest metric evidence.
  const byIdCandidates = groupBy(objects, x => x.id);
  const nodes = new Map();
  for (const [id, candidates] of byIdCandidates.entries()) {
    const ranked = candidates.map(c => {
      const loss = pickMetric(c.value, 'loss');
      const win = pickMetric(c.value, 'win');
      const score = pickMetric(c.value, 'score');
      const evidence = (loss?.score ?? 0) + (win?.score ?? 0) + (score?.score ?? 0);
      return { ...c, loss, win, score, evidence };
    }).sort((a, b) => b.evidence - a.evidence);
    if (ranked[0]?.evidence > 0) nodes.set(Number(id), ranked[0]);
  }

  if (!nodes.size) {
    return {
      ok: false,
      reason: 'NO_ANALYSIS_NODE_METRICS_DETECTED',
      meta: { source, detectedNodes: 0 },
      schemaKeys: [...new Set(plainDocs.flatMap(d => flattenScalars(d.fields).map(([p]) => p)))].slice(0, 200),
    };
  }

  const winRaw = new Map();
  const scoreRaw = new Map();
  const lossDirect = new Map();
  let winPath = null;
  let scorePath = null;
  let lossPath = null;

  for (const [id, n] of nodes.entries()) {
    if (n.win && normalizeWinrate(n.win.value) != null) {
      winRaw.set(id, n.win.value);
      if (!winPath || n.win.score > metricScore(winPath, 'win')) winPath = n.win.path;
    }
    if (n.score && Number.isFinite(n.score.value)) {
      scoreRaw.set(id, n.score.value);
      if (!scorePath || n.score.score > metricScore(scorePath, 'score')) scorePath = n.score.path;
    }
    if (n.loss && Number.isFinite(n.loss.value)) {
      lossDirect.set(id, Math.abs(n.loss.value));
      if (!lossPath || n.loss.score > metricScore(lossPath, 'loss')) lossPath = n.loss.path;
    }
  }

  const win = winRaw.size >= 2 ? orientWinrate(winRaw, winPath ?? '', gameNodeMap) : null;
  const score = scoreRaw.size >= 2 ? orientScore(scoreRaw, scorePath ?? '', gameNodeMap) : null;

  if (verbose) {
    console.log(`    analysis schema [${source}]:`, {
      detectedNodes: nodes.size,
      winPath,
      winOrientation: win?.orientation ?? null,
      scorePath,
      scoreOrientation: score?.orientation ?? null,
      directLossPath: lossPath,
    });
  }

  const canPointLoss = lossDirect.size > 0 || (score?.series?.size ?? 0) >= 2;
  const canWinrate = (win?.series?.size ?? 0) >= 2;

  return {
    ok: canPointLoss,
    reason: canPointLoss ? null : 'INSUFFICIENT_POINT_LOSS_OR_SCORE_SERIES',
    canPointLoss,
    canWinrate,
    winBlack: win?.series ?? new Map(),
    scoreBlack: score?.series ?? new Map(),
    directLoss: lossDirect,
    meta: {
      source,
      detectedNodes: nodes.size,
      winPath,
      winOrientation: win?.orientation ?? null,
      winSmoothness: win?.smoothness ?? null,
      scorePath,
      scoreOrientation: score?.orientation ?? null,
      scoreSmoothness: score?.smoothness ?? null,
      directLossPath: lossPath,
    },
    schemaKeys: [...new Set(plainDocs.flatMap(d => flattenScalars(d.fields).map(([p]) => p)))].slice(0, 200),
  };
}


function buildAnalysisAdapter(docs, gameNodeMap, verbose = false) {
  // The compressed analysis blob can live in an individual :analysis/:nodes
  // document, not only in the per-game :game-data/:nodes document. Decode all
  // such blobs before schema detection.
  const plainDocs = docs.map(doc => augmentDocWithCompressedAnalysis(doc, verbose, 'analysis-collection'));
  const adapter = buildAnalysisAdapterFromPlainDocs(plainDocs, gameNodeMap, verbose, 'analysis-collection');
  const compressed = plainDocs.map(d => d.compressedAnalysis).filter(Boolean);
  adapter.meta = {
    ...(adapter.meta ?? {}),
    compressedDocs: compressed.map(c => ({
      ok: c.ok,
      format: c.format ?? null,
      codec: c.codec ?? null,
      reason: c.reason ?? null,
      compressedBytes: c.compressedBytes ?? null,
      uncompressedBytes: c.uncompressedBytes ?? null,
    })),
  };
  if (!adapter.ok) {
    const failed = compressed.find(c => !c.ok);
    if (failed) adapter.reason = failed.reason ?? adapter.reason;
  }
  return adapter;
}

function buildAnalysisAdapterFromGameNodeDoc(gameNodes, verbose = false) {
  if (!gameNodes?.raw) {
    return { ok: false, reason: 'NO_GAME_NODE_DOCUMENT', meta: { source: 'game-data-node-document', detectedNodes: 0 }, schemaKeys: [] };
  }

  if (verbose && gameNodes.compressedAnalysis) {
    const c = gameNodes.compressedAnalysis;
    console.log('    compressed game-data analysis:', c.ok
      ? { ok: true, format: c.format, codec: c.codec, compressedBytes: c.compressedBytes, uncompressedBytes: c.uncompressedBytes }
      : { ok: false, reason: c.reason, compressedBytes: c.compressedBytes, preview: c.preview });
  }

  const adapter = buildAnalysisAdapterFromPlainDocs([
    { id: gameNodes.id ?? 'game-node-doc', fields: gameNodes.raw, name: `game-data-node:${gameNodes.id ?? ''}` },
  ], gameNodes.byId, verbose, 'game-data-node-document');

  adapter.meta = {
    ...(adapter.meta ?? {}),
    compressedAnalysis: gameNodes.compressedAnalysis
      ? {
          ok: gameNodes.compressedAnalysis.ok,
          format: gameNodes.compressedAnalysis.format ?? null,
          codec: gameNodes.compressedAnalysis.codec ?? null,
          reason: gameNodes.compressedAnalysis.reason ?? null,
          compressedBytes: gameNodes.compressedAnalysis.compressedBytes ?? null,
          uncompressedBytes: gameNodes.compressedAnalysis.uncompressedBytes ?? null,
        }
      : null,
  };

  if (!adapter.ok && gameNodes.compressedAnalysis && !gameNodes.compressedAnalysis.ok) {
    adapter.reason = gameNodes.compressedAnalysis.reason ?? adapter.reason;
  }
  return adapter;
}

function mergeAnalysisAdapters(primary, fallback) {
  const mergeMaps = (a, b) => {
    const out = new Map();
    for (const [k, v] of (b ?? new Map()).entries()) out.set(k, v);
    for (const [k, v] of (a ?? new Map()).entries()) out.set(k, v); // primary wins
    return out;
  };

  const directLoss = mergeMaps(primary?.directLoss, fallback?.directLoss);
  const scoreBlack = mergeMaps(primary?.scoreBlack, fallback?.scoreBlack);
  const winBlack = mergeMaps(primary?.winBlack, fallback?.winBlack);
  const canPointLoss = directLoss.size > 0 || scoreBlack.size >= 2;
  const canWinrate = winBlack.size >= 2;
  const schemaKeys = [...new Set([...(primary?.schemaKeys ?? []), ...(fallback?.schemaKeys ?? [])])].slice(0, 300);

  return {
    ok: canPointLoss,
    reason: canPointLoss ? null : (primary?.reason ?? fallback?.reason ?? 'INSUFFICIENT_POINT_LOSS_OR_SCORE_SERIES'),
    canPointLoss,
    canWinrate,
    winBlack,
    scoreBlack,
    directLoss,
    meta: {
      source: 'merged',
      primary: primary?.meta ?? null,
      fallback: fallback?.meta ?? null,
      winPoints: winBlack.size,
      scorePoints: scoreBlack.size,
      directLossPoints: directLoss.size,
    },
    schemaKeys,
  };
}

function evaluateCandidate(uniqueMove, analysis, gameNodeMap, myColor) {
  // AI Sensei memo :move-number is the move being trained. The analysis maps
  // are board positions: position 0 is the root, position N is after move N.
  // Therefore the loss caused by target move N is measured from N-1 -> N.
  const transition = analysisTransitionForMove(uniqueMove.moveNumber);
  const { actualMove, beforePosition } = transition;
  if (!transition.ok) {
    return { ok: false, reason: 'INVALID_TARGET_MOVE_NUMBER', actualMove, beforePosition };
  }

  const node = gameNodeMap.get(actualMove);
  const directMoverColor = normalizeColor(node?.[':color']);
  const resolvedProblemColor = normalizeColor(uniqueMove.problemColor);

  if (directMoverColor && resolvedProblemColor && directMoverColor !== resolvedProblemColor) {
    return {
      ok: false,
      reason: 'PROBLEM_COLOR_CONFLICT_WITH_DIRECT_NODE',
      directMoverColor,
      resolvedProblemColor,
      actualMove,
      beforePosition,
    };
  }
  const moverColor = directMoverColor ?? resolvedProblemColor;
  if (!moverColor) return { ok: false, reason: 'MISSING_ACTUAL_MOVE_COLOR', actualMove, beforePosition };
  if (moverColor !== myColor) return { ok: false, reason: 'NOT_MY_MOVE', moverColor, actualMove, beforePosition };

  // Point loss of move N = evaluation before N minus evaluation after N from
  // the mover's perspective. Fall back to an explicit per-move loss metric.
  let pointLoss = null;
  const beforeScore = analysis.scoreBlack.get(beforePosition);
  const afterScore = analysis.scoreBlack.get(actualMove);
  if (Number.isFinite(beforeScore) && Number.isFinite(afterScore)) {
    pointLoss = moverColor === 'black'
      ? Math.max(0, beforeScore - afterScore)
      : Math.max(0, afterScore - beforeScore);
  }
  if (!Number.isFinite(pointLoss)) {
    const explicit = analysis.directLoss.get(actualMove) ?? analysis.directLoss.get(beforePosition);
    if (Number.isFinite(explicit)) pointLoss = Math.abs(explicit);
  }
  if (!Number.isFinite(pointLoss)) {
    return { ok: false, reason: 'MISSING_POINT_LOSS_AND_SCORE_SERIES', moverColor, actualMove, beforePosition };
  }

  const beforeBlackWr = analysis.winBlack.get(beforePosition);
  const afterBlackWr = analysis.winBlack.get(actualMove);
  let myWinrateBefore = null;
  let myWinrateAfter = null;
  let winrateDrop = null;
  if (Number.isFinite(beforeBlackWr) && Number.isFinite(afterBlackWr)) {
    myWinrateBefore = myColor === 'black' ? beforeBlackWr : 1 - beforeBlackWr;
    myWinrateAfter = myColor === 'black' ? afterBlackWr : 1 - afterBlackWr;
    winrateDrop = Math.max(0, myWinrateBefore - myWinrateAfter);
  }

  return {
    ok: true,
    moverColor,
    actualMove,
    beforePosition,
    pointLoss,
    myWinrateBefore,
    myWinrateAfter,
    winrateDrop,
    winrateAvailable: Number.isFinite(winrateDrop),
  };
}

function consequence(candidate) {
  const before = candidate.myWinrateBefore;
  const after = candidate.myWinrateAfter;
  const drop = candidate.winrateDrop;

  if (before >= 0.50 && after < 0.50) {
    return { tier: 4, label: 'WINNING_TO_LOSING' };
  }
  if (before >= DECISIVE && after < DECISIVE) {
    return { tier: 3, label: 'THREW_AWAY_DECISIVE_LEAD' };
  }
  if (
    drop >= MATERIAL_WR_DROP &&
    ((before > LIVE_GAME && before < DECISIVE) || (after > LIVE_GAME && after < DECISIVE))
  ) {
    return { tier: 2, label: 'MEANINGFUL_WINRATE_LOSS' };
  }
  if (!((before >= DECISIVE && after >= DECISIVE) || (before <= LIVE_GAME && after <= LIVE_GAME))) {
    return { tier: 1, label: 'COMPETITIVE_POSITION' };
  }
  return { tier: 0, label: 'ALREADY_DECIDED' };
}

function chooseKeeperFromDistinctSolutions(evaluatedMoves) {
  // AI Sensei's "Avoid same move" means the saved SOLUTION is the same on
  // different turns, not that the problem came from the same move number.
  const bySolution = groupBy(evaluatedMoves, x => x.solutionKey);
  const solutionCandidates = [];

  for (const [solutionKey, moves] of bySolution.entries()) {
    if (!solutionKey) {
      return { keeper: null, top3: [], ranked: [], error: 'MISSING_PRIMARY_SOLUTION' };
    }
    const representative = [...moves].sort((a, b) => {
      if (b.pointLoss !== a.pointLoss) return b.pointLoss - a.pointLoss;
      const bWr = Number.isFinite(b.winrateDrop) ? b.winrateDrop : -1;
      const aWr = Number.isFinite(a.winrateDrop) ? a.winrateDrop : -1;
      if (bWr !== aWr) return bWr - aWr;
      return a.moveNumber - b.moveNumber;
    })[0];
    solutionCandidates.push({
      ...representative,
      repeatedSolutionMoveNumbers: moves.map(x => x.moveNumber).sort((a, b) => a - b),
    });
  }

  const top3Raw = solutionCandidates
    .sort((a, b) => b.pointLoss - a.pointLoss)
    .slice(0, TOP_POINT_LOSS_CANDIDATES);

  if (top3Raw.length === 1) {
    const only = {
      ...top3Raw[0],
      consequence: { tier: null, label: 'ONLY_UNIQUE_SOLUTION' },
    };
    return { keeper: only, top3: [only], ranked: [only], solutionCandidates };
  }

  const missingWr = top3Raw.find(x => !Number.isFinite(x.winrateDrop));
  if (missingWr) {
    return {
      keeper: null,
      top3: top3Raw,
      ranked: [],
      solutionCandidates,
      error: `MISSING_WINRATE_FOR_TOP3@position${missingWr.moveNumber}`,
    };
  }

  const top3 = top3Raw.map(x => ({ ...x, consequence: consequence(x) }));
  const ranked = [...top3].sort((a, b) => {
    if (b.consequence.tier !== a.consequence.tier) return b.consequence.tier - a.consequence.tier;
    if (b.winrateDrop !== a.winrateDrop) return b.winrateDrop - a.winrateDrop;
    return b.pointLoss - a.pointLoss;
  });

  return { keeper: ranked[0] ?? null, top3, ranked, solutionCandidates };
}

async function captureAuth(args) {
  let browser = null;
  let context;
  let externalBrowser = false;

  if (args.cdpUrl) {
    console.log(`Attaching to existing browser at ${args.cdpUrl} ...`);
    browser = await chromium.connectOverCDP(args.cdpUrl);
    context = browser.contexts()[0];
    if (!context) throw new Error('Connected browser has no usable browser context.');
    externalBrowser = true;
  } else {
    context = await chromium.launchPersistentContext(args.profileDir, {
      headless: args.headless,
      viewport: { width: 1400, height: 900 },
    });
  }

  let page = context.pages().find(p => p.url().startsWith('https://ai-sensei.com/'))
    ?? context.pages()[0]
    ?? await context.newPage();

  let resolveToken;
  const tokenPromise = new Promise(resolve => { resolveToken = resolve; });
  let captured = false;
  let latestToken = null;
  const tokenWaiters = new Set();

  const noteToken = token => {
    if (!token) return;
    latestToken = token;
    if (!captured) {
      captured = true;
      resolveToken(token);
    }
    for (const waiter of [...tokenWaiters]) waiter(token);
  };

  const attach = p => {
    p.on('request', req => {
      if (!req.url().startsWith('https://firestore.googleapis.com/')) return;
      const header = req.headers()['authorization'];
      if (header?.startsWith('Bearer ')) noteToken(header.slice('Bearer '.length));
    });
  };
  for (const p of context.pages()) attach(p);
  context.on('page', attach);

  if (args.cdpUrl) {
    console.log('Using the already-authenticated browser session. Do not close that browser until the script finishes.');
  } else {
    console.log('Opening AI Sensei. If this Playwright profile is not logged in yet, log in in the browser window.');
  }

  await page.goto('https://ai-sensei.com/problems', { waitUntil: 'domcontentloaded' });

  // Reload once to force an authenticated Firestore request if the app came from cache.
  await sleep(2500);
  if (!captured) await page.reload({ waitUntil: 'domcontentloaded' });

  const initialToken = await Promise.race([
    tokenPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      args.cdpUrl
        ? 'Timed out waiting for an authenticated Firestore request. Confirm AI Sensei is signed in in the attached browser, then retry.'
        : 'Timed out waiting for an authenticated Firestore request. Log in and retry.'
    )), 5 * 60_000)),
  ]);

  const payload = decodeJwt(initialToken);
  const uid = payload.user_id ?? payload.sub;
  if (!uid) {
    if (!externalBrowser) await context.close();
    throw new Error('Could not determine Firebase user id from the authenticated session.');
  }

  const authState = {
    browser, context, page, uploadPage: null, uid, externalBrowser,
    get token() { return latestToken ?? initialToken; },
    async refreshToken() {
      const oldToken = latestToken ?? initialToken;
      let refreshPage = this.page;
      if (!refreshPage || refreshPage.isClosed()) {
        if (this.browser && !this.browser.isConnected()) {
          throw new Error('BROWSER_DISCONNECTED: attached Chromium session is no longer connected.');
        }
        try {
          refreshPage = this.context.pages().find(p => !p.isClosed() && p !== this.uploadPage && p.url().startsWith('https://ai-sensei.com/'))
            ?? this.context.pages().find(p => !p.isClosed() && p !== this.uploadPage)
            ?? await this.context.newPage();
          this.page = refreshPage;
        } catch (err) {
          if (this.browser && !this.browser.isConnected()) {
            throw new Error('BROWSER_DISCONNECTED: attached Chromium session is no longer connected.');
          }
          throw err;
        }
      }
      const waitForDifferentToken = timeoutMs => new Promise((resolve, reject) => {
        let timer = null;
        const waiter = token => {
          if (!token || token === oldToken) return;
          tokenWaiters.delete(waiter);
          if (timer) clearTimeout(timer);
          resolve(token);
        };
        tokenWaiters.add(waiter);
        timer = setTimeout(() => {
          tokenWaiters.delete(waiter);
          reject(new Error('Timed out waiting for Firebase to refresh the browser authentication token. Sign in again in the attached browser if necessary, then retry.'));
        }, timeoutMs);
      });

      // The browser's Firebase SDK owns token refresh. Force a normal authenticated
      // application request and capture the newest Bearer token from the browser.
      const wait1 = waitForDifferentToken(45_000);
      await refreshPage.goto('https://ai-sensei.com/problems', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      if (latestToken && latestToken !== oldToken) return latestToken;
      try {
        return await wait1;
      } catch {
        const wait2 = waitForDifferentToken(60_000);
        await refreshPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return await wait2;
      }
    },
  };
  return authState;
}

class FirestoreClient {
  constructor(authState) {
    this.authState = authState;
  }

  headers(token) {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
      'X-Goog-Api-Client': 'gl-js/ fire/10.14.1',
      'X-Firebase-GMPID': FIREBASE_GMPID,
      'google-cloud-resource-prefix': `projects/${PROJECT_ID}/databases/${DATABASE}`,
      'x-goog-request-params': `project_id=${PROJECT_ID}`,
    };
  }

  async post(url, body) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = this.authState.token;
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : null;
      if (res.status === 401 && attempt === 1) {
        console.log('Firestore authentication expired; refreshing from the attached browser session and retrying...');
        await this.authState.refreshToken();
        continue;
      }
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
    }
    throw new Error('Firestore request failed after authentication refresh.');
  }

  async runQueryParent(parentPath, structuredQuery) {
    const encodedParent = parentPath.split('/').map(encodeURIComponent).join('/');
    const url = `${FIRESTORE_BASE}/${encodedParent}:runQuery`;
    const rows = await this.post(url, { structuredQuery });
    return (rows ?? []).filter(x => x.document).map(x => x.document);
  }

  async allMemos(uid) {
    return this.runQueryParent(`:users/${uid}`, {
      from: [{ collectionId: ':memos' }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    });
  }

  async allUploads(uid) {
    return this.runQueryParent(`:game-data/${uid}`, {
      from: [{ collectionId: ':uploads' }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    });
  }

  async analysisNodes(gameId) {
    return this.runQueryParent(`:analysis/${gameId}`, {
      from: [{ collectionId: ':nodes' }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    });
  }

  async batchGet(docNames) {
    if (!docNames.length) return new Map();
    const url = `${FIRESTORE_BASE}:batchGet`;
    const rows = await this.post(url, { documents: docNames });
    const out = new Map();
    for (const row of rows ?? []) {
      if (row.found) out.set(row.found.name, row.found);
    }
    return out;
  }

  async batchGetChunked(docNames, chunkSize = 100) {
    const out = new Map();
    for (let i = 0; i < docNames.length; i += chunkSize) {
      const chunk = docNames.slice(i, i + chunkSize);
      const part = await this.batchGet(chunk);
      for (const [k, v] of part.entries()) out.set(k, v);
      process.stdout.write(`\rFetched documents ${Math.min(i + chunk.length, docNames.length)}/${docNames.length}`);
    }
    if (docNames.length) process.stdout.write('\n');
    return out;
  }

  async commitCreates(creates, uid) {
    if (!creates.length) return null;
    const url = `${FIRESTORE_BASE}:commit`;
    const now = new Date();
    const due = initialDueDate(now);
    const writes = [];
    for (const c of creates) {
      if (!c.memoId || !c.gameId || !Number.isInteger(c.moveNumber) || !c.solutionMove) {
        throw new Error(`Invalid CREATE plan row for ${c.gameId ?? '?'} move ${c.moveNumber ?? '?'}`);
      }
      const memoName = `${FIRESTORE_ROOT}/:users/${uid}/:memos/${c.memoId}`;
      writes.push({
        update: {
          name: memoName,
          fields: {
            ':upload-date': { timestampValue: now.toISOString() },
            ':game-uid': { stringValue: uid },
            ':game-id': { stringValue: c.gameId },
            ':move-number': { integerValue: String(c.moveNumber) },
            ':solutions': firestoreSolutionsForFirstMove(c.solutionMove),
            ':due-date': { timestampValue: due },
          },
        },
        updateTransforms: [{ fieldPath: '`:updated-at`', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      });
      if (c.gameDocName && c.gameUpdateTime) {
        writes.push({ verify: c.gameDocName, currentDocument: { updateTime: c.gameUpdateTime } });
      }
    }
    return this.post(url, { writes });
  }

  async commitDeletes(memos) {
    const url = `${FIRESTORE_BASE}:commit`;
    const writes = memos.map(m => {
      if (!m.docName || !m.updateTime) throw new Error(`Memo ${m.id} is missing docName/updateTime`);
      return {
        delete: m.docName,
        currentDocument: { updateTime: m.updateTime },
      };
    });
    return this.post(url, { writes });
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}


function planToCsv(rows) {
  const cols = [
    'gameId', 'gameName', 'myColor', 'memoId', 'moveNumber', 'problemColor', 'problemColorSource',
    'solutionKey', 'solutionMove', 'solutionSource', 'pointLoss', 'myWinrateBefore', 'myWinrateAfter', 'winrateDrop',
    'qualifiesFloor', 'top3DistinctSolution', 'action', 'reason', 'keeperMemoId', 'analysisStatus', 'gameUpdateTime',
  ];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
  return lines.join('\n') + '\n';
}

function stablePlanHash(rows) {
  const minimal = rows.map(r => ({
    gameId: r.gameId,
    memoId: r.memoId || null,
    moveNumber: r.moveNumber === '' ? null : r.moveNumber,
    action: r.action,
    reason: r.reason,
    solutionMove: r.solutionMove || null,
    keeperMemoId: r.keeperMemoId || null,
    updateTime: r.updateTime || null,
    gameUpdateTime: r.gameUpdateTime || null,
  })).sort((a, b) => `${a.gameId}/${a.memoId ?? ''}/${a.action}`.localeCompare(`${b.gameId}/${b.memoId ?? ''}/${b.action}`));
  return crypto.createHash('sha256').update(JSON.stringify(minimal)).digest('hex').slice(0, 12);
}

function normalizedKeyName(k) {
  return String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getLoose(obj, names) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const wanted = new Set(names.map(normalizedKeyName));
  for (const [k, v] of Object.entries(obj)) if (wanted.has(normalizedKeyName(k))) return v;
  return undefined;
}

function sgfCoordFromGtp(move, boardSize = 19) {
  const s = String(move ?? '').trim();
  if (!s) return null;
  if (/^(pass|tt)$/i.test(s)) return '<pass>';
  if (/^[a-z]{2}$/i.test(s)) {
    const v = s.toLowerCase();
    const x = v.charCodeAt(0) - 97;
    const y = v.charCodeAt(1) - 97;
    if (x >= 0 && y >= 0 && x < boardSize && y < boardSize) return v;
  }
  const m = s.match(/^([A-Za-z])(\d{1,2})$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (letter === 'I') return null; // GTP skips I.
  let x = letter.charCodeAt(0) - 65;
  if (letter > 'I') x--;
  const row = Number(m[2]);
  if (!Number.isInteger(row) || row < 1 || row > boardSize || x < 0 || x >= boardSize) return null;
  const y = boardSize - row;
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
}

function findMoveInfoArrays(value, pathName = '', out = [], seen = new Set()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (!Array.isArray(value)) {
    for (const [k, child] of Object.entries(value)) {
      const p = pathName ? `${pathName}.${k}` : k;
      if (normalizedKeyName(k) === 'moveinfos' && Array.isArray(child)) out.push({ path: p, value: child });
      findMoveInfoArrays(child, p, out, seen);
    }
  } else {
    for (let i = 0; i < value.length; i++) findMoveInfoArrays(value[i], `${pathName}[${i}]`, out, seen);
  }
  return out;
}

function extractBestFirstMove(fields, boardSize = 19) {
  const arrays = findMoveInfoArrays(fields);
  const candidates = [];
  for (const hit of arrays) {
    const infos = hit.value.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (!infos.length) continue;
    const ranked = infos.map((info, index) => {
      const rawMove = getLoose(info, ['move']);
      const move = sgfCoordFromGtp(rawMove, boardSize);
      const visitsRaw = getLoose(info, ['visits']);
      const orderRaw = getLoose(info, ['order']);
      const visits = Number.isFinite(Number(visitsRaw)) ? Number(visitsRaw) : null;
      const order = Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : null;
      const pvRaw = getLoose(info, ['pv']);
      const pv = Array.isArray(pvRaw) ? pvRaw.map(x => sgfCoordFromGtp(x, boardSize)).filter(Boolean) : [];
      return { move, visits, order, pv, index, rawMove };
    }).filter(x => x.move);
    if (!ranked.length) continue;
    ranked.sort((a, b) => {
      if (a.order != null || b.order != null) return (a.order ?? 1e9) - (b.order ?? 1e9);
      if (a.visits != null || b.visits != null) return (b.visits ?? -1) - (a.visits ?? -1);
      return a.index - b.index;
    });
    const best = ranked[0];
    let score = 0;
    if (/decompressed.?gzip/i.test(hit.path)) score += 100;
    if (/\.json\.?/i.test(hit.path)) score += 20;
    if (best.visits != null) score += 10;
    if (best.pv.length) score += 5;
    candidates.push({
      firstMove: best.move,
      pv: best.pv.length && best.pv[0] === best.move ? best.pv : [best.move, ...best.pv.filter((x, i) => i > 0 || x !== best.move)],
      source: `MOVEINFOS:${hit.path}`,
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function buildSolutionIndexFromPlainDocs(plainDocs, boardSize = 19) {
  const out = new Map();
  for (const d of plainDocs) {
    const position = firestoreAnalysisPositionId(d.id);
    if (position == null) continue;
    const best = extractBestFirstMove(d.fields, boardSize);
    if (best) out.set(position, best);
  }
  return out;
}

// ------------------------------ GoQuest discovery stage ------------------------------

function normalizeGoQuestAccount(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function decodeSocketIo09Payload(body) {
  const text = String(body ?? '');
  if (!text.startsWith('\ufffd')) return [text];
  const packets = [];
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] !== '\ufffd') throw new Error('Malformed Socket.IO 0.9 payload framing.');
    const end = text.indexOf('\ufffd', offset + 1);
    if (end < 0) throw new Error('Unterminated Socket.IO 0.9 payload length.');
    const sizeText = text.slice(offset + 1, end);
    if (!/^\d+$/.test(sizeText)) throw new Error(`Invalid Socket.IO 0.9 payload length: ${JSON.stringify(sizeText)}`);
    const size = Number(sizeText);
    const start = end + 1;
    packets.push(text.slice(start, start + size));
    offset = start + size;
  }
  return packets;
}

function goQuestCookieHeader(setCookieValues) {
  if (!Array.isArray(setCookieValues)) return '';
  return setCookieValues.map(v => String(v).split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

function goQuestExtractSetCookie(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const one = headers.get?.('set-cookie');
  return one ? [one] : [];
}

async function goQuestFetchText(url, { method = 'GET', body = null, headers = {}, timeoutMs = GOQUEST_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, body, headers, redirect: 'follow', signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`GoQuest HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    return { text, headers: res.headers };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`GoQuest request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class GoQuestPublicProfileClient {
  constructor({ endpoint = GOQUEST_SOCKET_IO_BASE, timeoutMs = GOQUEST_REQUEST_TIMEOUT_MS } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '') + '/';
    this.timeoutMs = timeoutMs;
    const parsed = new URL(this.endpoint);
    this.origin = `${parsed.protocol}//${parsed.host}`;
    this.userAgent = 'auto-ai-sensei/0.1 (+read-only GoQuest public payload/linkage discovery)';
  }

  headers(cookie = '', extra = {}) {
    return {
      Accept: '*/*',
      Origin: this.origin,
      Referer: `${this.origin}/`,
      'User-Agent': this.userAgent,
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    };
  }

  async queryProfile(account, gtype) {
    const requested = String(account ?? '').trim();
    if (!requested) throw new Error('GoQuest account is empty.');
    const stamp = () => Date.now();
    const handshake = await goQuestFetchText(`${this.endpoint}?t=${stamp()}`, {
      headers: this.headers(), timeoutMs: this.timeoutMs,
    });
    const cookie = goQuestCookieHeader(goQuestExtractSetCookie(handshake.headers));
    const parts = handshake.text.split(':', 4);
    if (parts.length !== 4 || !parts[0]) throw new Error(`Invalid Socket.IO 0.9 handshake: ${JSON.stringify(handshake.text.slice(0, 300))}`);
    const [sid, heartbeat, closeTimeout, transports] = parts;
    if (!String(transports).split(',').includes('xhr-polling')) throw new Error(`GoQuest did not offer xhr-polling transport: ${transports}`);
    const polling = `${this.endpoint}xhr-polling/${encodeURIComponent(sid)}`;
    const initial = await goQuestFetchText(`${polling}?t=${stamp()}`, { headers: this.headers(cookie), timeoutMs: this.timeoutMs });
    if (!decodeSocketIo09Payload(initial.text).some(packet => packet.startsWith('1::'))) {
      throw new Error(`Socket.IO transport did not open: ${JSON.stringify(initial.text.slice(0, 300))}`);
    }

    const packet = `5:::${JSON.stringify({ name: GOQUEST_PROFILE_EVENT, args: [{ id: requested, gtype }] })}`;
    const posted = await goQuestFetchText(`${polling}?t=${stamp()}`, {
      method: 'POST', body: packet,
      headers: this.headers(cookie, { 'Content-Type': 'text/plain;charset=UTF-8' }),
      timeoutMs: this.timeoutMs,
    });
    if (!['1', 'ok'].includes(posted.text.trim())) throw new Error(`GoQuest profile event was not acknowledged: ${JSON.stringify(posted.text.slice(0, 300))}`);

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const polled = await goQuestFetchText(`${polling}?t=${stamp()}`, { headers: this.headers(cookie), timeoutMs: Math.min(this.timeoutMs, remaining) });
      for (const item of decodeSocketIo09Payload(polled.text)) {
        if (item.startsWith('2::')) {
          await goQuestFetchText(`${polling}?t=${stamp()}`, {
            method: 'POST', body: '2::', headers: this.headers(cookie, { 'Content-Type': 'text/plain;charset=UTF-8' }), timeoutMs: Math.min(this.timeoutMs, remaining),
          }).catch(() => {});
          continue;
        }
        if (!item.startsWith('5:::')) continue;
        let envelope;
        try { envelope = JSON.parse(item.slice(4)); } catch { continue; }
        if (envelope?.name !== GOQUEST_PROFILE_EVENT) continue;
        const args = envelope?.args;
        if (!Array.isArray(args) || args.length !== 1 || !args[0] || typeof args[0] !== 'object') {
          throw new Error(`Unexpected GoQuest profile response envelope: ${JSON.stringify(envelope).slice(0, 500)}`);
        }
        return {
          response: args[0],
          protocol: {
            endpoint: this.endpoint,
            event: GOQUEST_PROFILE_EVENT,
            transport: 'xhr-polling',
            heartbeatSeconds: Number(heartbeat) || null,
            closeTimeoutSeconds: Number(closeTimeout) || null,
          },
        };
      }
    }
    throw new Error(`Timed out waiting for GoQuest ${GOQUEST_PROFILE_EVENT} response for ${requested} / ${gtype}.`);
  }
}

function goQuestValueSummary(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `object(${Object.keys(value).length})`;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  return value;
}

function goQuestCollectHistoryHints(value, { pathPrefix = '$', historyContext = false, hints = [], ids = new Set() } = {}) {
  if (Array.isArray(value)) {
    if (historyContext) hints.push({ path: pathPrefix, type: 'array', summary: `array(${value.length})` });
    for (let i = 0; i < value.length; i++) goQuestCollectHistoryHints(value[i], { pathPrefix: `${pathPrefix}[${i}]`, historyContext, hints, ids });
    return { hints, ids };
  }
  if (!value || typeof value !== 'object') return { hints, ids };
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathPrefix}.${key}`;
    const keyLooksHistorical = /(?:game|history|record|recent|last)/.test(key.toLowerCase());
    const childHistoryContext = historyContext || keyLooksHistorical;
    if (keyLooksHistorical) hints.push({ path: childPath, type: Array.isArray(child) ? 'array' : child && typeof child === 'object' ? 'object' : typeof child, summary: goQuestValueSummary(child) });
    if (/^(?:lastgame|gameid|game_id|gid)$/i.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      const id = String(child).trim(); if (id) ids.add(id);
    } else if (childHistoryContext && /^id$/i.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      const id = String(child).trim(); if (id && /[0-9]/.test(id)) ids.add(id);
    }
    goQuestCollectHistoryHints(child, { pathPrefix: childPath, historyContext: childHistoryContext, hints, ids });
  }
  return { hints, ids };
}

function goQuestCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function stableJsonSha256(value) {
  const stable = v => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function normalizeGoQuestProfile(account, gtype, response, protocol, fetchedAt) {
  if (!response || typeof response !== 'object') throw new Error('GoQuest profile response is not an object.');
  if (response.error) throw new Error(`GoQuest profile error: ${String(response.error)}`);
  const returnedId = String(response.id ?? '').trim();
  if (!returnedId) throw new Error('GoQuest profile response has no id.');
  if (normalizeGoQuestAccount(returnedId) !== normalizeGoQuestAccount(account)) throw new Error(`GoQuest account mismatch: requested ${JSON.stringify(account)}, returned ${JSON.stringify(returnedId)}.`);
  const returnedGtype = String(response.gtype ?? gtype).trim().toLowerCase();
  if (returnedGtype && returnedGtype !== gtype) throw new Error(`GoQuest gtype mismatch: requested ${gtype}, returned ${returnedGtype}.`);

  const history = goQuestCollectHistoryHints(response);
  const candidateGameIds = [...history.ids];
  const win = goQuestCount(response.win), loss = goQuestCount(response.loss), draw = goQuestCount(response.draw);
  const playedFromRecord = [win, loss, draw].every(v => v !== null) ? win + loss + draw : null;
  const played = goQuestCount(response.played) ?? playedFromRecord;
  const lastGame = response.lastGame == null ? null : String(response.lastGame).trim() || null;
  let historyStatus = 'NO_GAME_IDS_DISCOVERED';
  if (candidateGameIds.length > 1) historyStatus = 'MULTIPLE_GAME_IDS_DISCOVERED_UNVERIFIED';
  else if (candidateGameIds.length === 1) historyStatus = lastGame ? 'LATEST_GAME_ONLY_OR_SINGLE_ID' : 'SINGLE_GAME_ID_DISCOVERED_UNVERIFIED';

  return {
    schema: 'goquest-public-profile-probe-v1', requestedAccount: account, normalizedAccount: normalizeGoQuestAccount(account),
    returnedId, returnedName: String(response.name ?? '').trim() || null, gtype,
    rating: Number.isFinite(Number(response.rating)) ? Number(response.rating) : null,
    high: Number.isFinite(Number(response.high)) ? Number(response.high) : null,
    win, loss, draw, played, last: response.last ?? null, lastGame, candidateGameIds, historyStatus,
    historyHints: history.hints, rawTopLevelKeys: Object.keys(response).sort(), rawResponseSha256: stableJsonSha256(response), fetchedAt, protocol,
  };
}

function goQuestImportCsv(plan) {
  const cols = ['account','gtype','status','returnedId','returnedName','rating','played','lastGame','candidateGameIdCount','historyStatus','historyHintCount','error'];
  const lines = [cols.join(',')];
  for (const row of plan.probes) {
    const values = {
      account: row.account, gtype: row.gtype, status: row.status,
      returnedId: row.profile?.returnedId ?? '', returnedName: row.profile?.returnedName ?? '', rating: row.profile?.rating ?? '', played: row.profile?.played ?? '',
      lastGame: row.profile?.lastGame ?? '', candidateGameIdCount: row.profile?.candidateGameIds?.length ?? 0,
      historyStatus: row.profile?.historyStatus ?? '', historyHintCount: row.profile?.historyHints?.length ?? 0, error: row.error ?? '',
    };
    lines.push(cols.map(c => csvEscape(values[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

function goQuestAccountCaseVariants(account) {
  const raw = String(account ?? '').trim();
  return [...new Set([raw, raw.toLowerCase(), raw.toUpperCase()].filter(Boolean))];
}

function goQuestGameIdLike(value) {
  return typeof value === 'string' && /^[a-z0-9]{10,16}$/i.test(value.trim());
}

function goQuestLinkageScan(value, {
  pathPrefix = '$',
  hints = [],
  linkedIds = new Set(),
  currentGameId = null,
  parentKey = '',
} = {}) {
  if (Array.isArray(value)) {
    const context = /(?:hist|archive|recent|games?|prev|next|older|newer|cursor|sequence|adjacent)/i.test(parentKey);
    if (context) hints.push({ path: pathPrefix, key: parentKey, kind: 'array', summary: `array(${value.length})` });
    for (let i = 0; i < value.length; i++) {
      goQuestLinkageScan(value[i], { pathPrefix: `${pathPrefix}[${i}]`, hints, linkedIds, currentGameId, parentKey });
    }
    return { hints, linkedIds };
  }
  if (!value || typeof value !== 'object') return { hints, linkedIds };

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathPrefix}.${key}`;
    const keyLower = key.toLowerCase();
    const linkishKey = /(?:prev|previous|next|older|newer|before|after|cursor|history|archive|recent|adjacent|sequence|seq|index|offset|page|game)/i.test(key);
    if (linkishKey) {
      hints.push({
        path: childPath,
        key,
        kind: Array.isArray(child) ? 'array' : child && typeof child === 'object' ? 'object' : typeof child,
        summary: goQuestValueSummary(child),
      });
    }

    if ((typeof child === 'string' || typeof child === 'number')) {
      const candidate = String(child).trim();
      const candidateKey = /(?:prev|previous|next|older|newer|before|after|game|history|archive|recent|adjacent)/i.test(keyLower);
      if (candidateKey && goQuestGameIdLike(candidate) && candidate !== currentGameId) linkedIds.add(candidate);
    }
    goQuestLinkageScan(child, { pathPrefix: childPath, hints, linkedIds, currentGameId, parentKey: key });
  }
  return { hints, linkedIds };
}

function goQuestPayloadSummary(gameId, expectedGtype, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Captured GoQuest game payload is not an object.');
  const actualId = String(payload.id ?? '').trim() || null;
  const gtype = String(payload.gtype ?? expectedGtype ?? '').trim().toLowerCase() || null;
  const players = Array.isArray(payload.players) ? payload.players.map((p, index) => ({
    index,
    id: p && typeof p === 'object' ? String(p.id ?? '').trim() || null : null,
    name: p && typeof p === 'object' ? String(p.name ?? '').trim() || null : null,
    oldR: p && typeof p === 'object' && Number.isFinite(Number(p.oldR)) ? Number(p.oldR) : null,
    rating: p && typeof p === 'object' && Number.isFinite(Number(p.rating)) ? Number(p.rating) : null,
  })) : [];
  const moves = Array.isArray(payload.position?.moves) ? payload.position.moves : [];
  const scan = goQuestLinkageScan(payload, { currentGameId: gameId });
  return {
    requestedGameId: gameId,
    returnedGameId: actualId,
    idMatchesRequest: actualId === gameId,
    expectedGtype,
    gtype,
    players,
    created: payload.created ?? null,
    started: payload.started ?? null,
    finished: payload.finished ?? null,
    moveCount: moves.length,
    positionSize: Number.isFinite(Number(payload.position?.size)) ? Number(payload.position.size) : null,
    topLevelKeys: Object.keys(payload).sort(),
    linkageHints: scan.hints,
    candidateLinkedGameIds: [...scan.linkedIds],
    rawPayloadSha256: stableJsonSha256(payload),
  };
}

function decodePossibleSocketText(text) {
  const s = String(text ?? '');
  const packets = [];
  try { packets.push(...decodeSocketIo09Payload(s)); } catch { packets.push(s); }
  return packets;
}

function findGamePayloadInValue(value, gameId, { depth = 0, seen = new Set() } = {}) {
  if (depth > 12 || value == null) return null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value)) {
    const id = String(value.id ?? '').trim();
    if (id === gameId && (Array.isArray(value.players) || value.position || value.gtype)) return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGamePayloadInValue(item, gameId, { depth: depth + 1, seen });
      if (found) return found;
    }
  } else {
    for (const child of Object.values(value)) {
      const found = findGamePayloadInValue(child, gameId, { depth: depth + 1, seen });
      if (found) return found;
    }
  }
  return null;
}

function parseGamePayloadFromNetworkText(text, gameId) {
  for (const packet of decodePossibleSocketText(text)) {
    let candidate = packet;
    if (candidate.startsWith('5:::')) candidate = candidate.slice(4);
    if (!candidate.includes(gameId)) continue;
    try {
      const parsed = JSON.parse(candidate);
      const found = findGamePayloadInValue(parsed, gameId);
      if (found) return { payload: found, envelope: parsed };
    } catch {}
  }
  return null;
}

class GoQuestPublicGameBrowserClient {
  constructor({ timeoutMs = GOQUEST_GAME_CAPTURE_TIMEOUT_MS, chromiumPath = GOQUEST_DEFAULT_CHROMIUM } = {}) {
    this.timeoutMs = timeoutMs;
    this.chromiumPath = chromiumPath;
    this.browser = null;
    this.context = null;
  }

  async open() {
    if (this.browser) return;
    const launch = { headless: true };
    try {
      await fs.access(this.chromiumPath);
      launch.executablePath = this.chromiumPath;
    } catch {}
    this.browser = await chromium.launch(launch);
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36 auto-ai-sensei-goquest-readonly',
    });
  }

  async close() {
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.context = null;
    this.browser = null;
  }

  async captureGame(gameId, gtype) {
    await this.open();
    const attempts = [];
    for (const base of GOQUEST_WEB_BASES) {
      const url = `${base}/${encodeURIComponent(gtype)}#game/${encodeURIComponent(gameId)}`;
      const result = await this.captureAtUrl(url, gameId, gtype);
      attempts.push(result.diagnostic);
      if (result.payload) return { ...result, attempts };
    }
    return { payload: null, envelope: null, evidence: null, attempts, diagnostic: attempts.at(-1) ?? null };
  }

  async captureAtUrl(url, gameId, gtype) {
    const page = await this.context.newPage();
    const networkEvidence = [];
    let resolvePayload;
    let settled = false;
    const payloadPromise = new Promise(resolve => { resolvePayload = resolve; });
    const acceptText = (direction, transport, text, meta = {}) => {
      if (settled || typeof text !== 'string') return;
      if (text.includes(gameId)) {
        networkEvidence.push({ direction, transport, text: text.slice(0, 4000), ...meta });
        const parsed = parseGamePayloadFromNetworkText(text, gameId);
        if (parsed?.payload) {
          settled = true;
          resolvePayload({ payload: parsed.payload, envelope: parsed.envelope, evidence: { direction, transport, ...meta } });
        }
      }
    };

    page.on('websocket', ws => {
      const wsUrl = ws.url();
      ws.on('framesent', event => acceptText('sent', 'websocket', typeof event.payload === 'string' ? event.payload : '', { url: wsUrl }));
      ws.on('framereceived', event => acceptText('received', 'websocket', typeof event.payload === 'string' ? event.payload : '', { url: wsUrl }));
    });
    page.on('request', req => {
      const body = req.postData();
      if (body) acceptText('sent', 'http', body, { url: req.url(), method: req.method() });
    });
    page.on('response', async res => {
      try {
        const u = res.url();
        if (!/(?:socket\.io|questgames|wars\.fm)/i.test(u)) return;
        const ct = String(res.headers()['content-type'] ?? '');
        if (ct && !/(?:text|json|javascript|octet-stream)/i.test(ct)) return;
        const body = await res.text();
        acceptText('received', 'http', body, { url: u, status: res.status() });
      } catch {}
    });

    let navError = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(this.timeoutMs, 20_000) });
    } catch (err) {
      navError = err?.message ?? String(err);
    }

    let found = null;
    const timer = new Promise(resolve => setTimeout(() => resolve(null), this.timeoutMs));
    found = await Promise.race([payloadPromise, timer]);
    if (!settled) {
      settled = true;
      resolvePayload(null);
    }
    const diagnostic = {
      requestedGameId: gameId,
      gtype,
      url,
      finalUrl: page.url(),
      title: await page.title().catch(() => ''),
      navError,
      evidenceCount: networkEvidence.length,
      matchingNetworkEvidence: networkEvidence,
    };
    await page.close().catch(() => {});
    return found ? { ...found, diagnostic } : { payload: null, envelope: null, evidence: null, diagnostic };
  }
}

function goQuestLinkageCsv(plan) {
  const cols = ['gameId','expectedGtype','status','returnedGameId','gtype','moveCount','player0Id','player0Name','player1Id','player1Name','linkageHintCount','candidateLinkedGameIdCount','candidateLinkedGameIds','error'];
  const lines = [cols.join(',')];
  for (const row of plan.games) {
    const s = row.summary;
    const values = {
      gameId: row.gameId, expectedGtype: row.expectedGtype, status: row.status,
      returnedGameId: s?.returnedGameId ?? '', gtype: s?.gtype ?? '', moveCount: s?.moveCount ?? '',
      player0Id: s?.players?.[0]?.id ?? '', player0Name: s?.players?.[0]?.name ?? '',
      player1Id: s?.players?.[1]?.id ?? '', player1Name: s?.players?.[1]?.name ?? '',
      linkageHintCount: s?.linkageHints?.length ?? 0, candidateLinkedGameIdCount: s?.candidateLinkedGameIds?.length ?? 0,
      candidateLinkedGameIds: (s?.candidateLinkedGameIds ?? []).join(';'), error: row.error ?? '',
    };
    lines.push(cols.map(c => csvEscape(values[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function loadPriorGoQuestCandidateIds() {
  try {
    const doc = JSON.parse(await fs.readFile(GOQUEST_IMPORT_PLAN_JSON, 'utf8'));
    const byId = new Map();
    for (const probe of doc?.probes ?? []) {
      const gtype = String(probe?.gtype ?? '').toLowerCase();
      for (const id of probe?.profile?.candidateGameIds ?? []) {
        if (goQuestGameIdLike(String(id))) byId.set(String(id), gtype || null);
      }
    }
    return { source: GOQUEST_IMPORT_PLAN_JSON, byId };
  } catch {
    return { source: null, byId: new Map() };
  }
}

async function runGoQuestImportStage(args) {
  const generatedAt = new Date().toISOString();
  const client = new GoQuestPublicProfileClient({ timeoutMs: args.goquestTimeoutMs });
  const probes = [];
  const identifierDiagnostics = [];
  const raw = { schema: 'goquest-public-profile-raw-bundle-v2', generatedAt, endpoint: GOQUEST_SOCKET_IO_BASE, event: GOQUEST_PROFILE_EVENT, accounts: {} };

  console.log('GoQuest read-only payload/linkage discovery probe');
  console.log('  No AI Sensei browser/session will be opened and no game can be uploaded by this stage.');
  console.log('  A separate temporary headless Chromium may open public GoQuest game pages only.');
  console.log(`  accounts: ${args.goquestAccounts.join(', ')}`);
  console.log(`  game types: ${args.goquestGtypes.join(', ')}`);
  console.log(`  public profile protocol: Socket.IO 0.9 ${GOQUEST_PROFILE_EVENT} over xhr-polling`);

  const liveCandidateById = new Map();
  for (const account of args.goquestAccounts) {
    raw.accounts[account] = {};
    let exactAccountFound = false;
    for (const gtype of args.goquestGtypes) {
      process.stdout.write(`  ${account} / ${gtype}: querying public profile... `);
      try {
        const result = await client.queryProfile(account, gtype);
        const fetchedAt = new Date().toISOString();
        raw.accounts[account][gtype] = { fetchedAt, protocol: result.protocol, response: result.response };
        const profile = normalizeGoQuestProfile(account, gtype, result.response, result.protocol, fetchedAt);
        probes.push({ account, gtype, status: 'OK', profile, error: null });
        exactAccountFound = true;
        for (const id of profile.candidateGameIds) liveCandidateById.set(id, gtype);
        console.log(`OK; played=${profile.played ?? '?'}; category lastGame IDs=${profile.candidateGameIds.length}`);
      } catch (err) {
        raw.accounts[account][gtype] = { fetchedAt: new Date().toISOString(), error: err?.message ?? String(err) };
        probes.push({ account, gtype, status: 'ERROR', profile: null, error: err?.message ?? String(err) });
        console.log(`ERROR: ${err?.message ?? err}`);
      }
    }

    if (!exactAccountFound) {
      const variants = goQuestAccountCaseVariants(account).filter(v => v !== account);
      for (const variant of variants) {
        for (const gtype of args.goquestGtypes) {
          process.stdout.write(`    identifier diagnostic ${JSON.stringify(variant)} / ${gtype}... `);
          try {
            const result = await client.queryProfile(variant, gtype);
            const response = result.response;
            if (response?.error) throw new Error(`GoQuest profile error: ${String(response.error)}`);
            identifierDiagnostics.push({ requestedAccount: account, variant, gtype, status: 'FOUND', returnedId: response?.id ?? null, returnedName: response?.name ?? null, error: null });
            console.log(`FOUND -> id=${JSON.stringify(response?.id ?? null)} name=${JSON.stringify(response?.name ?? null)}`);
          } catch (err) {
            identifierDiagnostics.push({ requestedAccount: account, variant, gtype, status: 'NOT_FOUND_OR_ERROR', returnedId: null, returnedName: null, error: err?.message ?? String(err) });
            console.log(`no (${err?.message ?? err})`);
          }
        }
      }
    }
  }

  const prior = await loadPriorGoQuestCandidateIds();
  const gameById = new Map(prior.byId);
  for (const [id, gtype] of liveCandidateById) gameById.set(id, gtype);
  const knownGames = [...gameById.entries()].map(([gameId, expectedGtype]) => ({ gameId, expectedGtype }));

  console.log(`\nPublic game-payload retrieval: ${knownGames.length} distinct known IDs${prior.source ? ` (merged with ${prior.source})` : ''}`);
  const gameClient = new GoQuestPublicGameBrowserClient({ timeoutMs: args.goquestGameCaptureTimeoutMs, chromiumPath: args.goquestChromiumPath });
  const rawGames = { schema: 'goquest-public-game-payload-bundle-v1', generatedAt, readOnly: true, games: {} };
  const games = [];
  try {
    for (let i = 0; i < knownGames.length; i++) {
      const { gameId, expectedGtype } = knownGames[i];
      process.stdout.write(`  [${i + 1}/${knownGames.length}] ${gameId} ${expectedGtype ?? '?'}: capture public game payload... `);
      try {
        if (!expectedGtype || !/^go(?:9|13|19)$/.test(expectedGtype)) throw new Error('Unknown GoQuest gtype for this game ID.');
        const captured = await gameClient.captureGame(gameId, expectedGtype);
        rawGames.games[gameId] = {
          expectedGtype,
          capturedAt: new Date().toISOString(),
          payload: captured.payload,
          envelope: captured.envelope,
          evidence: captured.evidence,
          attempts: captured.attempts,
        };
        if (!captured.payload) throw new Error('No matching complete game payload observed in public GoQuest web-client traffic.');
        const summary = goQuestPayloadSummary(gameId, expectedGtype, captured.payload);
        games.push({ gameId, expectedGtype, status: 'OK', summary, error: null });
        console.log(`OK; moves=${summary.moveCount}; players=${summary.players.map(p => p.id || p.name || '?').join(' vs ')}; linked IDs=${summary.candidateLinkedGameIds.length}`);
      } catch (err) {
        if (!rawGames.games[gameId]) rawGames.games[gameId] = { expectedGtype, capturedAt: new Date().toISOString(), error: err?.message ?? String(err) };
        else rawGames.games[gameId].error = err?.message ?? String(err);
        games.push({ gameId, expectedGtype, status: 'ERROR', summary: null, error: err?.message ?? String(err) });
        console.log(`ERROR: ${err?.message ?? err}`);
      }
    }
  } finally {
    await gameClient.close();
  }

  const successful = probes.filter(p => p.status === 'OK');
  const failed = probes.filter(p => p.status !== 'OK');
  const successfulGames = games.filter(g => g.status === 'OK');
  const failedGames = games.filter(g => g.status !== 'OK');
  const allCandidateIds = new Set(successful.flatMap(p => p.profile.candidateGameIds));
  for (const id of prior.byId.keys()) allCandidateIds.add(id);
  const linkedIds = new Set(successfulGames.flatMap(g => g.summary.candidateLinkedGameIds));
  const novelLinkedIds = [...linkedIds].filter(id => !allCandidateIds.has(id));
  const linkageFieldCount = successfulGames.reduce((n, g) => n + g.summary.linkageHints.length, 0);

  const hashInput = {
    schema: 'goquest-readonly-linkage-plan-v1',
    accounts: args.goquestAccounts,
    gtypes: args.goquestGtypes,
    profiles: probes.map(p => ({ account: p.account, gtype: p.gtype, status: p.status, error: p.error, profile: p.profile ? {
      returnedId: p.profile.returnedId, returnedName: p.profile.returnedName, played: p.profile.played, lastGame: p.profile.lastGame,
      candidateGameIds: p.profile.candidateGameIds, rawResponseSha256: p.profile.rawResponseSha256,
    } : null })),
    games: games.map(g => ({ gameId: g.gameId, expectedGtype: g.expectedGtype, status: g.status, error: g.error, summary: g.summary ? {
      returnedGameId: g.summary.returnedGameId, gtype: g.summary.gtype, players: g.summary.players,
      created: g.summary.created, started: g.summary.started, finished: g.summary.finished, moveCount: g.summary.moveCount,
      candidateLinkedGameIds: g.summary.candidateLinkedGameIds, rawPayloadSha256: g.summary.rawPayloadSha256,
    } : null })),
    identifierDiagnostics,
  };
  const probeHash = crypto.createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 12);
  const completeHistoryVerified = false;
  const linkagePlan = {
    ...hashInput,
    generatedAt,
    readOnly: true,
    aiSenseiUploadCapability: false,
    completeHistoryVerified,
    knownCandidateGameIds: [...allCandidateIds],
    candidateLinkedGameIds: [...linkedIds],
    novelCandidateLinkedGameIds: novelLinkedIds,
    successfulProfileProbeCount: successful.length,
    failedProfileProbeCount: failed.length,
    successfulGamePayloadCount: successfulGames.length,
    failedGamePayloadCount: failedGames.length,
    linkageFieldCount,
    probeHash,
    auditFiles: {
      normalizedProfileJson: GOQUEST_IMPORT_PLAN_JSON,
      profileCsv: GOQUEST_IMPORT_PLAN_CSV,
      rawProfiles: GOQUEST_PROFILE_RAW_JSON,
      linkageJson: GOQUEST_LINKAGE_JSON,
      linkageCsv: GOQUEST_LINKAGE_CSV,
      rawGamePayloads: GOQUEST_GAME_RAW_JSON,
    },
    nextGate: novelLinkedIds.length
      ? 'Candidate linkage IDs were observed. Review their exact fields before any recursive traversal is implemented; this tool deliberately does not follow them.'
      : 'No verified backward-history traversal has been established. Do not brute-force opaque game IDs or implement GoQuest upload.',
  };

  const profilePlan = {
    schema: 'goquest-readonly-discovery-plan-v2', accounts: args.goquestAccounts, gtypes: args.goquestGtypes,
    probes, generatedAt, readOnly: true, aiSenseiUploadCapability: false, completeHistoryVerified: false,
    uniqueCandidateGameIds: [...allCandidateIds], successfulProbeCount: successful.length, failedProbeCount: failed.length,
    identifierDiagnostics, probeHash,
    auditFiles: { normalizedJson: GOQUEST_IMPORT_PLAN_JSON, csv: GOQUEST_IMPORT_PLAN_CSV, rawResponses: GOQUEST_PROFILE_RAW_JSON },
    nextGate: 'See goquest-linkage-plan.json. This tool does not upload or recursively follow unverified game references.',
  };

  await fs.writeFile(GOQUEST_PROFILE_RAW_JSON, JSON.stringify(raw, null, 2));
  await fs.writeFile(GOQUEST_IMPORT_PLAN_JSON, JSON.stringify(profilePlan, null, 2));
  await fs.writeFile(GOQUEST_IMPORT_PLAN_CSV, goQuestImportCsv(profilePlan));
  await fs.writeFile(GOQUEST_GAME_RAW_JSON, JSON.stringify(rawGames, null, 2));
  await fs.writeFile(GOQUEST_LINKAGE_JSON, JSON.stringify(linkagePlan, null, 2));
  await fs.writeFile(GOQUEST_LINKAGE_CSV, goQuestLinkageCsv(linkagePlan));

  console.log('\nGOQUEST V28 READ-ONLY PAYLOAD/LINKAGE SUMMARY');
  console.log(`  successful account/gtype probes:       ${successful.length}/${probes.length}`);
  console.log(`  failed profile probes:                  ${failed.length}`);
  console.log(`  known category lastGame IDs:            ${allCandidateIds.size}`);
  console.log(`  game payloads captured:                 ${successfulGames.length}/${games.length}`);
  console.log(`  game payload capture failures:          ${failedGames.length}`);
  console.log(`  linkage-shaped fields observed:         ${linkageFieldCount}`);
  console.log(`  candidate linked game IDs observed:     ${linkedIds.size}`);
  console.log(`  novel linked IDs beyond known set:      ${novelLinkedIds.length}`);
  console.log('  complete history verified:              NO');
  console.log(`  probe hash:                             ${probeHash}`);
  console.log(`  linkage audit:                          ${GOQUEST_LINKAGE_JSON}`);
  console.log(`  linkage CSV:                            ${GOQUEST_LINKAGE_CSV}`);
  console.log(`  raw game payloads:                      ${GOQUEST_GAME_RAW_JSON}`);
  console.log(`  raw profile responses:                  ${GOQUEST_PROFILE_RAW_JSON}`);
  console.log('\nREAD-ONLY GATE: there is no GoQuest-to-AI-Sensei upload path and unverified linked IDs are not followed.');
  if (novelLinkedIds.length) console.log('Novel candidate linked IDs were found. Review the exact fields before implementing any recursive traversal.');
  else console.log('No verified historical traversal was found in the captured payloads; do not infer or brute-force opaque IDs.');
  if (failed.length || failedGames.length) console.log('Some probes/captures failed. The raw diagnostics preserve the evidence; do not infer completeness from partial results.');
}


// ------------------------------ OGS import stage ------------------------------

function normalizeBoardDimensions(width, height = width) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 52 || h > 52) return null;
  return { width: w, height: h };
}

function boardDimensionsLabel(width, height = width) {
  const dims = normalizeBoardDimensions(width, height);
  return dims ? `${dims.width}x${dims.height}` : 'unknown-size';
}

function isBelowMinAnalysisBoard(width, height = width) {
  const dims = normalizeBoardDimensions(width, height);
  return !!dims && (dims.width < MIN_OGS_ANALYSIS_BOARD_SIZE || dims.height < MIN_OGS_ANALYSIS_BOARD_SIZE);
}

function normalizeSgfCoord(value, boardWidth = 19, boardHeight = boardWidth) {
  const dims = normalizeBoardDimensions(boardWidth, boardHeight);
  if (!dims) return null;
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '<pass>';
  // Old SGF writers sometimes encoded a pass as tt on boards where tt cannot
  // be a legal point. FF[4] uses an empty value.
  if (v === 'tt' && dims.width <= 19 && dims.height <= 19) return '<pass>';
  if (!/^[a-z]{2}$/.test(v)) return null;
  const x = v.charCodeAt(0) - 97;
  const y = v.charCodeAt(1) - 97;
  if (x < 0 || y < 0 || x >= dims.width || y >= dims.height) return null;
  return v;
}

function expandSgfPoint(value, boardWidth, boardHeight = boardWidth) {
  const dims = normalizeBoardDimensions(boardWidth, boardHeight);
  if (!dims) return [];
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw.includes(':')) {
    const p = normalizeSgfCoord(raw, dims.width, dims.height);
    return p && p !== '<pass>' ? [p] : [];
  }
  const [a, b] = raw.split(':', 2);
  if (!/^[a-z]{2}$/.test(a) || !/^[a-z]{2}$/.test(b)) return [];
  const ax = a.charCodeAt(0) - 97, ay = a.charCodeAt(1) - 97;
  const bx = b.charCodeAt(0) - 97, by = b.charCodeAt(1) - 97;
  if (ax < 0 || bx < 0 || ay < 0 || by < 0 || ax >= dims.width || bx >= dims.width || ay >= dims.height || by >= dims.height) return [];
  const out = [];
  for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
      out.push(String.fromCharCode(97 + x, 97 + y));
    }
  }
  return out;
}

function parseSgfMainLine(sgfBytes) {
  const text = Buffer.isBuffer(sgfBytes) ? sgfBytes.toString('utf8') : String(sgfBytes ?? '');
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const propValue = () => {
    if (text[i] !== '[') throw new Error(`SGF expected [ at ${i}`);
    i++;
    let out = '';
    while (i < text.length) {
      const ch = text[i++];
      if (ch === ']') return out;
      if (ch === '\\') {
        if (i >= text.length) break;
        let next = text[i++];
        // SGF line continuation removes the escaped newline entirely.
        if (next === '\r' && text[i] === '\n') { i++; continue; }
        if (next === '\r' || next === '\n') continue;
        out += next;
      } else out += ch;
    }
    throw new Error('Unterminated SGF property value');
  };
  const node = () => {
    if (text[i] !== ';') throw new Error(`SGF expected ; at ${i}`);
    i++;
    const props = {};
    while (i < text.length) {
      ws();
      const start = i;
      while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
      if (i === start) break;
      const id = text.slice(start, i).toUpperCase();
      ws();
      const vals = [];
      while (text[i] === '[') { vals.push(propValue()); ws(); }
      if (!vals.length) throw new Error(`SGF property ${id} missing value`);
      (props[id] ??= []).push(...vals);
    }
    return props;
  };
  const tree = () => {
    ws();
    if (text[i] !== '(') throw new Error(`SGF expected ( at ${i}`);
    i++;
    const sequence = [];
    ws();
    while (text[i] === ';') { sequence.push(node()); ws(); }
    const children = [];
    while (text[i] === '(') { children.push(tree()); ws(); }
    if (text[i] !== ')') throw new Error(`SGF expected ) at ${i}`);
    i++;
    return { sequence, children };
  };
  ws();
  const rootTree = tree();
  const nodes = [];
  let t = rootTree;
  while (t) {
    nodes.push(...t.sequence);
    t = t.children[0] ?? null; // SGF main line = first variation.
  }
  if (!nodes.length) throw new Error('SGF has no nodes');

  const root = nodes[0];
  const szRaw = String(root.SZ?.[0] ?? '19').trim();
  const szParts = szRaw.split(':').map(Number);
  let boardWidth, boardHeight;
  if (szParts.length === 1) {
    boardWidth = boardHeight = szParts[0];
  } else if (szParts.length === 2) {
    [boardWidth, boardHeight] = szParts;
  } else {
    throw new Error(`Unsupported SGF board size: ${szRaw}`);
  }
  const dims = normalizeBoardDimensions(boardWidth, boardHeight);
  if (!dims) throw new Error(`Unsupported SGF board size: ${szRaw}`);
  boardWidth = dims.width;
  boardHeight = dims.height;

  const blackSetup = new Set();
  const whiteSetup = new Set();
  const moves = [];
  let sawMove = false;
  for (const n of nodes) {
    for (const v of n.AB ?? []) {
      if (sawMove) throw new Error('SGF has AB setup stones after play began');
      for (const p of expandSgfPoint(v, boardWidth, boardHeight)) blackSetup.add(p);
    }
    for (const v of n.AW ?? []) {
      if (sawMove) throw new Error('SGF has AW setup stones after play began');
      for (const p of expandSgfPoint(v, boardWidth, boardHeight)) whiteSetup.add(p);
    }
    const moveProps = [];
    for (const color of ['B', 'W']) for (const v of n[color] ?? []) moveProps.push({ color, value: v });
    if (moveProps.length > 1) throw new Error('SGF node contains multiple moves');
    if (moveProps.length === 1) {
      sawMove = true;
      const p = normalizeSgfCoord(moveProps[0].value, boardWidth, boardHeight);
      if (!p) throw new Error(`Invalid SGF move coordinate: ${moveProps[0].value}`);
      moves.push(p);
    }
  }
  return {
    boardWidth,
    boardHeight,
    boardSize: boardWidth === boardHeight ? boardWidth : null,
    blackSetup: [...blackSetup].sort(),
    whiteSetup: [...whiteSetup].sort(),
    moves,
  };
}

function canonicalAiMove(value, boardWidth, boardHeight = boardWidth) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === '<pass>') return '<pass>';
  return normalizeSgfCoord(v, boardWidth, boardHeight);
}

function gameRecordFingerprint(record) {
  const width = Number(record.boardWidth ?? record.boardSize);
  const height = Number(record.boardHeight ?? record.boardSize ?? width);
  const canonical = {
    boardWidth: width,
    boardHeight: height,
    blackSetup: [...new Set(record.blackSetup ?? [])].sort(),
    whiteSetup: [...new Set(record.whiteSetup ?? [])].sort(),
    moves: record.moves ?? [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function aiGameFingerprint(game) {
  if (!game || !Number.isInteger(game.boardSize) || !Array.isArray(game.moves)) return null;
  const raw = game.raw ?? {};
  const blackSetup = [...(Array.isArray(raw[':handicap']) ? raw[':handicap'] : []),
    ...(Array.isArray(raw[':initial-black-stones']) ? raw[':initial-black-stones'] : [])]
    .map(x => canonicalAiMove(x, game.boardSize)).filter(x => x && x !== '<pass>');
  const whiteSetup = (Array.isArray(raw[':initial-white-stones']) ? raw[':initial-white-stones'] : [])
    .map(x => canonicalAiMove(x, game.boardSize)).filter(x => x && x !== '<pass>');
  const moves = game.moves.map(x => canonicalAiMove(x, game.boardSize));
  if (moves.some(x => !x)) return null;
  return gameRecordFingerprint({ boardWidth: game.boardSize, boardHeight: game.boardSize, blackSetup, whiteSetup, moves });
}

function aiTitleMatchesOgsPlayers(aiName, ogsGame) {
  const parts = String(aiName ?? '').split(/\s+vs\s+/i);
  if (parts.length !== 2) return false;
  const ogs = ogsGamePlayers(ogsGame);
  // AI Sensei-generated titles are White vs Black.
  return stripTrailingRank(parts[0]) === normalizeName(ogs.white) &&
    stripTrailingRank(parts[1]) === normalizeName(ogs.black);
}

function aiGameRecordFromNodeDoc(game, nodeDoc) {
  if (!game || !nodeDoc) return null;
  const parsed = parseGameNodeDoc(nodeDoc);
  if (!parsed.nodes.length) return null;

  // The :node-array is a tree. AI Sensei's played game follows :down from the
  // root; variations hang elsewhere in the tree and must not enter the fingerprint.
  let current = parsed.byId.get(0) ?? parsed.nodes.find(n => !Number.isInteger(n?.[':up'])) ?? null;
  if (!current) return null;

  const raw = game.raw ?? {};
  const rootHandicap = Array.isArray(current[':handicap-positions']) ? current[':handicap-positions'] : [];
  const blackSetup = [
    ...(Array.isArray(raw[':handicap']) ? raw[':handicap'] : []),
    ...(Array.isArray(raw[':initial-black-stones']) ? raw[':initial-black-stones'] : []),
    ...rootHandicap,
  ].map(x => canonicalAiMove(x, game.boardSize)).filter(x => x && x !== '<pass>');
  const whiteSetup = (Array.isArray(raw[':initial-white-stones']) ? raw[':initial-white-stones'] : [])
    .map(x => canonicalAiMove(x, game.boardSize)).filter(x => x && x !== '<pass>');

  const moves = [];
  const visited = new Set();
  while (current) {
    const id = current[':id'];
    if (Number.isInteger(id)) {
      if (visited.has(id)) return null;
      visited.add(id);
    }
    if (Object.prototype.hasOwnProperty.call(current, ':move')) {
      const move = canonicalAiMove(current[':move'], game.boardSize);
      if (!move) return null;
      moves.push(move);
    }
    const down = current[':down'];
    if (!Number.isInteger(down)) break;
    const next = parsed.byId.get(down);
    if (!next) return null; // incomplete main-line chain: fail open to the UI.
    current = next;
  }

  // A node-document fallback is useful only when it reconstructed an actual
  // played main line. Setup-only records stay unresolved and go to the UI.
  if (!moves.length) return null;
  return { boardWidth: game.boardSize, boardHeight: game.boardSize, boardSize: game.boardSize, blackSetup, whiteSetup, moves };
}

function recoverImportedGameFromUpload(uploadDoc, nodeDoc) {
  if (!uploadDoc) return { ok: false, reason: 'MISSING_GAME_DOCUMENT' };
  const fields = decodeFsFields(uploadDoc.fields);
  const metadata = importedGameMetadataFromUploadFields(fields, {
    id: docId(uploadDoc.name),
    docName: uploadDoc.name,
    updateTime: uploadDoc.updateTime ?? null,
  });
  if (!metadata.ok) return metadata;
  if (!nodeDoc) return { ok: false, reason: 'NO_ANALYSIS_NODE_DOCUMENT' };
  const record = aiGameRecordFromNodeDoc(metadata.game, nodeDoc);
  if (!record) return { ok: false, reason: 'UPLOAD_NODE_MAIN_LINE_UNUSABLE' };
  return {
    ok: true,
    game: {
      ...metadata.game,
      moves: record.moves,
      metadataSource: 'UPLOAD_SGF_INFO+GAME_DATA_NODE_CHAIN',
    },
    record,
  };
}

async function buildAiSenseiFingerprintIndex(fsClient, uid) {
  console.log('Building local AI Sensei game fingerprint index...');
  const uploads = await fsClient.allUploads(uid);
  const uploadsById = new Map(uploads.map(d => [docId(d.name), d]));
  const ids = [...new Set(uploads.map(d => docId(d.name)).filter(Boolean))];
  const names = ids.map(id => `${FIRESTORE_ROOT}/:games/${id}`);
  const docs = await fsClient.batchGetChunked(names);
  const index = new Map();
  const unresolved = [];
  let directUsable = 0;

  const add = (fp, row) => {
    if (!index.has(fp)) index.set(fp, []);
    index.get(fp).push(row);
  };

  for (const id of ids) {
    const doc = docs.get(`${FIRESTORE_ROOT}/:games/${id}`);
    if (!doc) {
      const uploadDoc = uploadsById.get(id);
      const fields = uploadDoc ? decodeFsFields(uploadDoc.fields) : null;
      const metadata = fields ? importedGameMetadataFromUploadFields(fields, {
        id,
        docName: uploadDoc.name,
        updateTime: uploadDoc.updateTime ?? null,
      }) : { ok: false };
      unresolved.push({ id, game: metadata.ok ? metadata.game : null });
      continue;
    }
    const game = parseGameDoc(doc);
    const fp = aiGameFingerprint(game);
    if (!fp) {
      unresolved.push({ id, game });
      continue;
    }
    directUsable++;
    add(fp, { aiGameId: id, name: game.name, moveCount: game.moves.length, fingerprintSource: 'GAMES_DOC' });
  }

  let nodeRecovered = 0;
  if (unresolved.length) {
    console.log(`  ${unresolved.length} games lack a usable :games move record; reconstructing main lines from :game-data/:nodes...`);
    const nodeNames = unresolved.map(({ id }) => `${FIRESTORE_ROOT}/:game-data/${uid}/:nodes/${id}`);
    const nodeDocs = await fsClient.batchGetChunked(nodeNames);
    for (const { id, game } of unresolved) {
      if (!game) continue; // without game metadata we cannot safely establish board size/name.
      const nodeDoc = nodeDocs.get(`${FIRESTORE_ROOT}/:game-data/${uid}/:nodes/${id}`);
      if (!nodeDoc) continue;
      const record = aiGameRecordFromNodeDoc(game, nodeDoc);
      if (!record) continue;
      const fp = gameRecordFingerprint(record);
      nodeRecovered++;
      add(fp, { aiGameId: id, name: game.name, moveCount: record.moves.length, fingerprintSource: 'GAME_DATA_NODE_CHAIN' });
    }
  }

  const usable = directUsable + nodeRecovered;
  console.log(`  indexed ${usable}/${ids.length} AI Sensei games by exact board record`);
  console.log(`    direct :games records:              ${directUsable}`);
  console.log(`    reconstructed from :game-data:      ${nodeRecovered}`);
  console.log(`    unresolved locally:                 ${ids.length - usable}`);
  return { index, ids: new Set(ids), directUsable, nodeRecovered, unresolvedCount: ids.length - usable };
}

function resolveLocalAiDuplicate(index, ogsGame, sgfRecord) {
  const fp = gameRecordFingerprint(sgfRecord);
  const candidates = index.get(fp) ?? [];
  if (!candidates.length) return { match: null, fingerprint: fp, candidates: 0 };
  if (candidates.length === 1 && sgfRecord.moves.length >= 8) {
    return { match: candidates[0], fingerprint: fp, candidates: 1 };
  }
  const playerMatches = candidates.filter(c => aiTitleMatchesOgsPlayers(c.name, ogsGame));
  if (playerMatches.length === 1) return { match: playerMatches[0], fingerprint: fp, candidates: candidates.length };
  // Fail open: ambiguous/very-short matches still go through AI Sensei's own duplicate checker.
  return { match: null, fingerprint: fp, candidates: candidates.length, ambiguous: true };
}

class OgsClient {
  constructor({ requestDelayMs = OGS_REQUEST_DELAY_MS } = {}) {
    this.requestDelayMs = requestDelayMs;
    this.lastRequestAt = 0;
    this.userAgent = 'auto-ai-sensei/1.0 (+OGS game import; rate-limited)';
  }

  async request(url, { binary = false } = {}) {
    const parsed = new URL(url, OGS_BASE);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'online-go.com') {
      throw new Error(`Refusing unexpected OGS URL: ${parsed}`);
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const since = Date.now() - this.lastRequestAt;
      if (since < this.requestDelayMs) await sleep(this.requestDelayMs - since);
      this.lastRequestAt = Date.now();

      let res;
      try {
        res = await fetch(parsed, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': binary ? 'application/x-go-sgf,text/plain,*/*' : 'application/json',
          },
        });
      } catch (err) {
        if (attempt >= 7) throw err;
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }

      if (res.status === 429) {
        const retryHeader = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader * 1000
          : Math.min(10 * 60_000, 30_000 * 2 ** attempt);
        console.log(`  OGS rate limit (429); waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 7) {
        const waitMs = Math.min(60_000, 2_000 * 2 ** attempt);
        console.log(`  OGS ${res.status}; retrying in ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OGS ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      }
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
    }
    throw new Error(`OGS request retry budget exhausted: ${parsed}`);
  }

  async resolvePlayer(username) {
    const data = await this.request(`${OGS_API_BASE}/players/?username=${encodeURIComponent(username)}&page_size=100`);
    const rows = Array.isArray(data) ? data : (data?.results ?? []);
    const exact = rows.filter(r => normalizeName(r?.username) === normalizeName(username));
    if (exact.length !== 1) {
      throw new Error(`Could not resolve OGS username ${JSON.stringify(username)} exactly (matches=${exact.length}).`);
    }
    return { id: Number(exact[0].id), username: String(exact[0].username) };
  }

  async completedGames(player) {
    let url = `${OGS_API_BASE}/players/${player.id}/games/?source=play&ended__isnull=false&annulled=false&ordering=-ended&page_size=${OGS_PAGE_SIZE}`;
    const out = [];
    const seenPages = new Set();
    while (url) {
      if (seenPages.has(url)) throw new Error(`OGS pagination loop for ${player.username}`);
      seenPages.add(url);
      const data = await this.request(url);
      for (const g of data?.results ?? []) {
        if (!Number.isInteger(Number(g?.id))) continue;
        if (g?.annulled === true) continue;
        out.push(g);
      }
      url = data?.next ?? null;
    }
    return out;
  }

  async sgf(gameId) {
    const buf = await this.request(`${OGS_API_BASE}/games/${encodeURIComponent(gameId)}/sgf`, { binary: true });
    const text = buf.toString('utf8').trimStart();
    if (!text.startsWith('(') || !text.includes(';')) {
      throw new Error(`OGS game ${gameId} did not return recognizable SGF data.`);
    }
    return buf;
  }
}

function ogsGamePlayers(game) {
  const black = game?.players?.black?.username ?? game?.black?.username ?? game?.black_name ?? '';
  const white = game?.players?.white?.username ?? game?.white?.username ?? game?.white_name ?? '';
  return { black: String(black || ''), white: String(white || '') };
}

function ogsGameDisplayName(game) {
  const p = ogsGamePlayers(game);
  if (p.white || p.black) return `${p.white || '?'} vs ${p.black || '?'}`;
  return String(game?.name ?? game?.game_name ?? `OGS game ${game?.id ?? '?'}`);
}

function ogsGameEnded(game) {
  return String(game?.ended ?? game?.ended_at ?? game?.end_time ?? '');
}

function ogsImportHash(plan) {
  const minimal = {
    minAnalysisBoardSize: MIN_OGS_ANALYSIS_BOARD_SIZE,
    accounts: plan.accounts.map(a => ({ requested: a.requested, id: a.id, username: a.username })),
    games: plan.games.map(g => ({
      id: g.id,
      ended: g.ended,
      accounts: g.accounts,
      boardSize: g.boardSize ?? '',
    })).sort((a, b) => a.id - b.id),
  };
  return crypto.createHash('sha256').update(JSON.stringify(minimal)).digest('hex').slice(0, 12);
}

function ogsImportCsv(plan) {
  const cols = ['ogsGameId', 'ended', 'accounts', 'white', 'black', 'name', 'boardWidth', 'boardHeight', 'boardSize', 'importPolicy', 'outcome'];
  const lines = [cols.join(',')];
  for (const g of plan.games) {
    const row = {
      ogsGameId: g.id,
      ended: g.ended,
      accounts: g.accounts.join('|'),
      white: g.white,
      black: g.black,
      name: g.name,
      boardWidth: g.boardWidth ?? '',
      boardHeight: g.boardHeight ?? '',
      boardSize: g.boardSize ?? '',
      importPolicy: g.importPolicy ?? '',
      outcome: g.outcome ?? '',
    };
    lines.push(cols.map(c => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function buildOgsImportPlan(args) {
  console.log('Fetching OGS account histories...');
  const client = new OgsClient();
  const accountRows = [];
  const byGame = new Map();

  for (const requested of args.ogsAccounts) {
    const player = await client.resolvePlayer(requested);
    console.log(`  ${requested} -> ${player.username} (player ${player.id})`);
    const games = await client.completedGames(player);
    console.log(`    completed, non-annulled games: ${games.length}`);
    accountRows.push({ requested, ...player, gameCount: games.length });
    for (const game of games) {
      const id = Number(game.id);
      let entry = byGame.get(id);
      if (!entry) {
        const players = ogsGamePlayers(game);
        const width = Number(game?.width ?? game?.size ?? game?.board_size);
        const height = Number(game?.height ?? game?.size ?? game?.board_size);
        entry = {
          id,
          ended: ogsGameEnded(game),
          accounts: [],
          white: players.white,
          black: players.black,
          name: String(game?.name ?? game?.game_name ?? ogsGameDisplayName(game)),
          boardWidth: Number.isFinite(width) && width > 0 ? width : '',
          boardHeight: Number.isFinite(height) && height > 0 ? height : '',
          boardSize: Number.isFinite(width) && Number.isFinite(height) && width === height ? width : '',
          importPolicy: Number.isFinite(width) && Number.isFinite(height) && isBelowMinAnalysisBoard(width, height)
            ? 'SKIP_SMALL_BOARD'
            : 'CHECK_LOCAL_OR_UPLOAD',
          outcome: String(game?.outcome ?? game?.result ?? ''),
        };
        byGame.set(id, entry);
      }
      if (!entry.accounts.includes(player.username)) entry.accounts.push(player.username);
    }
  }

  let games = [...byGame.values()].sort((a, b) => {
    const at = Date.parse(a.ended) || 0;
    const bt = Date.parse(b.ended) || 0;
    return bt - at || b.id - a.id;
  });
  const totalUnique = games.length;
  if (Number.isFinite(args.maxOgsGames)) games = games.slice(0, args.maxOgsGames);

  const plan = {
    generatedAt: new Date().toISOString(),
    accounts: accountRows,
    totalUniqueGames: totalUnique,
    selectedGameCount: games.length,
    selectedSmallBoardCount: games.filter(g => isBelowMinAnalysisBoard(g.boardWidth, g.boardHeight)).length,
    minAnalysisBoardSize: MIN_OGS_ANALYSIS_BOARD_SIZE,
    duplicateAcrossAccounts: accountRows.reduce((s, a) => s + a.gameCount, 0) - totalUnique,
    games,
  };
  plan.planHash = ogsImportHash(plan);
  return plan;
}

async function writeOgsImportPlan(plan) {
  await fs.writeFile(OGS_IMPORT_PLAN_JSON, JSON.stringify(plan, null, 2));
  await fs.writeFile(OGS_IMPORT_PLAN_CSV, ogsImportCsv(plan));
}

async function loadOgsImportState() {
  try {
    const parsed = JSON.parse(await fs.readFile(OGS_IMPORT_STATE_JSON, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.games && typeof parsed.games === 'object') return parsed;
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`WARNING: could not read ${OGS_IMPORT_STATE_JSON}: ${err.message}`);
  }
  return { version: 1, games: {} };
}

async function saveOgsImportState(state) {
  state.updatedAt = new Date().toISOString();
  const temp = `${OGS_IMPORT_STATE_JSON}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, OGS_IMPORT_STATE_JSON);
}

class BrowserDisconnectedError extends Error {
  constructor(message = 'Attached Chromium browser disconnected during OGS import.') {
    super(message);
    this.name = 'BrowserDisconnectedError';
    this.code = 'BROWSER_DISCONNECTED';
  }
}

class UploadPageLifecycleError extends Error {
  constructor(message = 'AI Sensei upload page was closed during OGS import.') {
    super(message);
    this.name = 'UploadPageLifecycleError';
    this.code = 'UPLOAD_PAGE_LIFECYCLE_ERROR';
  }
}

function isUploadPageLifecycleError(err) {
  if (err?.code === 'UPLOAD_PAGE_LIFECYCLE_ERROR') return true;
  const message = String(err?.message ?? err ?? '');
  return /Target page, context or browser has been closed|Target closed|page has been closed|Page closed|UPLOAD_PAGE_CLOSED/i.test(message);
}

class UploadPageStateError extends Error {
  constructor(message = 'AI Sensei upload page is alive but not in a usable upload state.') {
    super(message);
    this.name = 'UploadPageStateError';
    this.code = 'UPLOAD_PAGE_STATE_ERROR';
  }
}

function isUploadPageStateError(err) {
  if (err?.code === 'UPLOAD_PAGE_STATE_ERROR') return true;
  const message = String(err?.message ?? err ?? '');
  return /UPLOAD_PAGE_STATE_ERROR|waiting for locator\('input\[type=[\"']file[\"']\]'\)|input\[type=[\"']file[\"']\].*Timeout/i.test(message);
}

function isUploadPageHealthError(err) {
  return isUploadPageLifecycleError(err) || isUploadPageStateError(err);
}

function transientCooldownMs(level) {
  if (level <= 0) return 0;
  return OGS_TRANSIENT_COOLDOWN_STEPS_MS[Math.min(level - 1, OGS_TRANSIENT_COOLDOWN_STEPS_MS.length - 1)];
}

function isGenuineServiceFailure(result) {
  return result?.status === 'UPLOAD_FAILED' && result?.serviceFailure === true;
}

function browserSessionIsConnected(auth) {
  if (!auth) return false;
  if (auth.browser && typeof auth.browser.isConnected === 'function') return auth.browser.isConnected();
  try {
    auth.context.pages();
    return true;
  } catch {
    return false;
  }
}

async function ensureUploadBrowserSession(auth) {
  if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
  try {
    auth.context.pages();
  } catch (err) {
    if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
    throw err;
  }
}

async function ensureLiveAiSenseiUploadPage(auth, { forceNew = false } = {}) {
  await ensureUploadBrowserSession(auth);
  let page = auth.uploadPage;
  if (forceNew || !page || page.isClosed()) {
    try {
      // Use a dedicated upload tab. This keeps Firestore-token refresh/navigation on
      // auth.page from disrupting a long-running upload attempt.
      page = await auth.context.newPage();
      auth.uploadPage = page;
    } catch (err) {
      if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
      throw err;
    }
  }
  try {
    await ensureAiSenseiUploadPage(page);
    return page;
  } catch (err) {
    if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
    if (isUploadPageLifecycleError(err) || page.isClosed()) {
      throw new UploadPageLifecycleError(String(err?.message ?? err));
    }
    if (isUploadPageStateError(err)) throw err;
    throw err;
  }
}

async function recreateAiSenseiUploadPage(auth) {
  // auth.uploadPage is always script-created, so it is safe to close a surviving
  // unhealthy copy before replacing it. Never touch the user's pre-existing tabs.
  const stale = auth.uploadPage;
  auth.uploadPage = null;
  if (stale && !stale.isClosed()) await stale.close().catch(() => {});
  return ensureLiveAiSenseiUploadPage(auth, { forceNew: true });
}

function aiSenseiGameIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'ai-sensei.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('game');
    if (i < 0 || parts.length <= i + 1) return null;
    // Current game URLs are /game/<uid>/<game-id>. Fall back to the final segment.
    return decodeURIComponent(parts.at(-1));
  } catch {
    return null;
  }
}

async function visibleText(page, text) {
  const loc = page.getByText(text, { exact: true }).first();
  try { return await loc.isVisible(); } catch { return false; }
}

async function ensureAiSenseiUploadPage(page) {
  if (!page || page.isClosed()) throw new UploadPageLifecycleError('UPLOAD_PAGE_CLOSED before navigation.');
  try {
    if (!page.url().startsWith('https://ai-sensei.com/upload')) {
      await page.goto('https://ai-sensei.com/upload', { waitUntil: 'domcontentloaded' });
    }
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 30_000 });
    return input;
  } catch (err) {
    if (isUploadPageLifecycleError(err) || page.isClosed()) {
      throw new UploadPageLifecycleError(String(err?.message ?? err));
    }
    const message = String(err?.message ?? err ?? '');
    if (/Timeout .*exceeded|waiting for locator\('input\[type="file"\]'\)/i.test(message)) {
      let title = '';
      try { title = await page.title(); } catch {}
      throw new UploadPageStateError(`UPLOAD_PAGE_STATE_ERROR: upload file input unavailable at ${page.url()}${title ? ` (${title})` : ''}.`);
    }
    throw err;
  }
}

async function findSubmitGameControl(page) {
  // Current AI Sensei preview UI labels the final action "Upload". Older/localized
  // builds have also used "Analyze Game", so accept both without matching Select File.
  const candidates = [
    page.getByRole('button', { name: 'Upload', exact: true }).first(),
    page.getByRole('button', { name: /Analyze Game/i }).first(),
    page.getByRole('link', { name: /Analyze Game/i }).first(),
    page.locator('input[type="submit"][value="Upload" i]').first(),
    page.locator('input[type="submit"][value*="Analyze" i]').first(),
    page.locator('button, [role="button"], a').filter({ hasText: /^\s*Upload\s*$/i }).first(),
    page.locator('button, [role="button"], a').filter({ hasText: /Analyze Game/i }).first(),
    page.getByText('Analyze Game', { exact: true }).first(),
  ];
  for (const loc of candidates) {
    try {
      if (await loc.isVisible()) return loc;
    } catch {}
  }
  return null;
}

async function saveOgsUploadDiagnostic(page, game, extra = {}) {
  const base = path.resolve(`ogs-upload-diagnostic-${game.id}`);
  const buttons = await page.locator('button, [role="button"], input[type="submit"], a').evaluateAll(els =>
    els.slice(0, 200).map(el => ({
      tag: el.tagName,
      text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 300),
      disabled: !!el.disabled,
      ariaDisabled: el.getAttribute('aria-disabled'),
      href: el.getAttribute('href'),
    }))
  ).catch(() => []);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const payload = {
    ogsGameId: game.id,
    at: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    buttons,
    bodyText: bodyText.slice(0, 50000),
    ...extra,
  };
  await fs.writeFile(`${base}.json`, JSON.stringify(payload, null, 2)).catch(() => {});
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  return { json: `${base}.json`, screenshot: `${base}.png` };
}

async function uploadOgsSgfToAiSensei(page, fsClient, uid, game, sgfBuffer, knownAiIds, timeoutMs) {
  const input = await ensureAiSenseiUploadPage(page);
  await input.setInputFiles({
    name: `ogs-${game.id}.sgf`,
    mimeType: 'application/x-go-sgf',
    buffer: sgfBuffer,
  });

  const started = Date.now();
  let submitClicked = false;
  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) throw new UploadPageLifecycleError('UPLOAD_PAGE_CLOSED while waiting for AI Sensei upload outcome.');
    if (await visibleText(page, 'Game Already Analyzed')) {
      const go = page.getByRole('button', { name: 'Go to game', exact: true }).first();
      if (await go.isVisible().catch(() => false)) {
        await go.click({ timeout: 10_000 }).catch(() => null);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(500);
      }
      const duplicateId = aiSenseiGameIdFromUrl(page.url());
      if (duplicateId) return { status: 'ALREADY_ANALYZED', aiGameId: duplicateId };
      return { status: 'UPLOAD_FAILED', error: 'DUPLICATE_NAVIGATION_TIMEOUT', retryable: true };
    }

    const currentId = aiSenseiGameIdFromUrl(page.url());
    if (currentId && !knownAiIds.has(currentId)) {
      knownAiIds.add(currentId);
      return { status: 'UPLOADED_NEW', aiGameId: currentId };
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');

    // The generic upload error screen is transient in practice. Return immediately so
    // the outer per-game retry can restart from /upload with the same SGF. Retrying is
    // idempotent: if the server accepted the first attempt, the next attempt becomes a
    // normal "Game Already Analyzed" result.
    if (bodyText.includes('Oops, something went wrong!')) {
      return { status: 'UPLOAD_FAILED', error: 'AI_SENSEI_TRANSIENT_UPLOAD_ERROR', retryable: true, serviceFailure: true };
    }

    if (!submitClicked) {
      const submit = await findSubmitGameControl(page);
      if (submit) {
        const enabled = await submit.isEnabled().catch(() => true);
        if (enabled) {
          await submit.click({ timeout: 10_000 }).catch(() => null);
          submitClicked = true;
          await sleep(800);
          continue;
        }
      }
    }

    const knownError = [
      'This game is too long to analyze.',
      'Illegal move',
    ].find(t => bodyText.includes(t));
    if (knownError) return { status: 'UPLOAD_FAILED', error: knownError, retryable: false };

    if (bodyText.includes('Too many requests')) {
      return { status: 'UPLOAD_FAILED', error: 'Too many requests', retryable: true, serviceFailure: true };
    }

    await sleep(400);
  }

  if (page.isClosed()) throw new UploadPageLifecycleError('UPLOAD_PAGE_CLOSED before upload outcome reconciliation.');
  // UI route changes are the normal success signal. If the UI was slow/unusual,
  // use the authenticated history index as a safe fallback before declaring failure.
  const after = await fsClient.allUploads(uid);
  const ids = after.map(d => docId(d.name)).filter(id => !knownAiIds.has(id));
  if (ids.length === 1) {
    knownAiIds.add(ids[0]);
    return { status: 'UPLOADED_NEW', aiGameId: ids[0], source: 'FIRESTORE_HISTORY_DIFF' };
  }
  const diag = await saveOgsUploadDiagnostic(page, game, {
    submitClicked,
    unseenFirestoreIds: ids,
  });
  return { status: 'UPLOAD_FAILED', error: 'UPLOAD_OUTCOME_TIMEOUT', retryable: true, diagnostic: diag };
}

async function analysisReady(fsClient, uid, gameId) {
  if (!gameId) return false;
  const nodeName = `${FIRESTORE_ROOT}/:game-data/${uid}/:nodes/${gameId}`;
  const found = await fsClient.batchGet([nodeName]);
  if (!found.has(nodeName)) return false;
  const docs = await fsClient.analysisNodes(gameId);
  return docs.length > 0;
}

async function waitForImportedAnalyses(fsClient, uid, ids, minutes) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length || minutes <= 0) return { complete: [], pending: unique };
  const deadline = Date.now() + minutes * 60_000;
  const pending = new Set(unique);
  const complete = new Set();
  while (pending.size && Date.now() < deadline) {
    for (const id of [...pending]) {
      try {
        if (await analysisReady(fsClient, uid, id)) {
          pending.delete(id);
          complete.add(id);
        }
      } catch {}
    }
    process.stdout.write(`\rNew AI Sensei analyses ready: ${complete.size}/${unique.length}`);
    if (pending.size && Date.now() < deadline) await sleep(Math.min(OGS_ANALYSIS_POLL_MS, deadline - Date.now()));
  }
  if (unique.length) process.stdout.write('\n');
  return { complete: [...complete], pending: [...pending] };
}

async function runOgsImportStage(auth, fsClient, args) {
  const plan = await buildOgsImportPlan(args);
  await writeOgsImportPlan(plan);

  console.log('\nOGS IMPORT PLAN');
  for (const a of plan.accounts) console.log(`  ${a.username}: ${a.gameCount} completed, non-annulled games`);
  console.log(`  unique games across accounts:          ${plan.totalUniqueGames}`);
  console.log(`  duplicates between OGS accounts:       ${plan.duplicateAcrossAccounts}`);
  console.log(`  games selected for this run:           ${plan.selectedGameCount}`);
  console.log(`  known boards below ${MIN_OGS_ANALYSIS_BOARD_SIZE}x${MIN_OGS_ANALYSIS_BOARD_SIZE} (will skip): ${plan.selectedSmallBoardCount}`);
  console.log(`  plan hash:                             ${plan.planHash}`);
  console.log(`  audit files:                           ${OGS_IMPORT_PLAN_JSON}, ${OGS_IMPORT_PLAN_CSV}`);
  console.log('  Exact local board-record matches are skipped before upload; AI Sensei duplicate detection is the fallback authority. The importer never clicks "Reupload game".');
  console.log(`  pacing: local/no-upload ${args.ogsDelayMs} ms; upload-UI ${args.ogsUploadDelayMs} ms; adaptive transient cooldown 30s/60s/120s`);

  if (!args.allowOgsUpload) {
    const extras = [];
    if (Number.isFinite(args.maxOgsGames)) extras.push('--max-ogs-games', String(args.maxOgsGames));
    for (const account of args.ogsAccounts) {
      if (!DEFAULT_OGS_ACCOUNTS.some(x => normalizeName(x) === normalizeName(account))) extras.push('--ogs-account', shellQuote(account));
    }
    if (args.ogsDelayMs !== OGS_LOCAL_DELAY_MS) extras.push('--ogs-delay-ms', String(args.ogsDelayMs));
    if (args.ogsUploadDelayMs !== OGS_UPLOAD_DELAY_MS) extras.push('--ogs-upload-delay-ms', String(args.ogsUploadDelayMs));
    if (args.waitAnalysisMinutes !== 10) extras.push('--wait-analysis-minutes', String(args.waitAnalysisMinutes));
    if (args.ogsUploadTimeoutMs !== OGS_UPLOAD_TIMEOUT_MS) extras.push('--ogs-upload-timeout-seconds', String(Math.round(args.ogsUploadTimeoutMs / 1000)));
    if (args.ogsUploadAttempts !== OGS_UPLOAD_ATTEMPTS) extras.push('--ogs-upload-attempts', String(args.ogsUploadAttempts));
    const scriptName = invokedScriptPath();
    console.log(`\nDRY RUN ONLY. No OGS game was uploaded.\nReviewed import command:\n  node ${shellQuote(scriptName)}${args.cdpUrl ? ` --cdp ${shellQuote(args.cdpUrl)}` : ''} --ogs-import${extras.length ? ` ${extras.join(' ')}` : ''} --allow-ogs-upload --confirm-ogs ${plan.planHash}\n`);
    return;
  }

  if (args.confirmOgs !== plan.planHash) {
    die(`OGS import hash mismatch. Current plan is ${plan.planHash}, but --confirm-ogs was ${args.confirmOgs}. Review the regenerated OGS plan before uploading.`);
  }

  const state = await loadOgsImportState();
  state.planHash = plan.planHash;
  state.accounts = plan.accounts;
  const localLibrary = await buildAiSenseiFingerprintIndex(fsClient, auth.uid);
  const initialUploads = await fsClient.allUploads(auth.uid);
  const knownAiIds = new Set(initialUploads.map(d => docId(d.name)));
  const ogsClient = new OgsClient();

  const counts = { SKIP_SMALL_BOARD: 0, LOCAL_DUPLICATE: 0, ALREADY_ANALYZED: 0, UPLOADED_NEW: 0, UPLOAD_FAILED: 0, BROWSER_DISCONNECTED: 0, SKIPPED_CHECKPOINT: 0, UPLOAD_PAGE_RECOVERIES: 0, ADAPTIVE_COOLDOWNS: 0 };
  const newlyUploadedAiIds = [];
  let consecutiveServiceFailures = 0;
  let transientFailurePressure = 0;
  let adaptiveCooldownTotalMs = 0;
  let examinedThisRun = 0;
  let uiUploadGamesThisRun = 0;
  let stoppedEarly = false;
  let stopReason = null;
  console.log(`\nSubmitting ${plan.games.length} OGS games through AI Sensei's normal upload UI...`);
  for (let i = 0; i < plan.games.length; i++) {
    const game = plan.games[i];
    const key = String(game.id);
    const prior = state.games[key];
    if (prior?.status === 'SKIP_SMALL_BOARD') {
      const pw = Number(prior.boardWidth ?? prior.boardSize);
      const ph = Number(prior.boardHeight ?? prior.boardSize ?? pw);
      if (isBelowMinAnalysisBoard(pw, ph)) {
        counts.SKIPPED_CHECKPOINT++;
        console.log(`  [${i + 1}/${plan.games.length}] OGS ${game.id}: checkpoint SKIP_SMALL_BOARD (${boardDimensionsLabel(pw, ph)})`);
        continue;
      }
    }
    if (prior && ['LOCAL_DUPLICATE', 'ALREADY_ANALYZED', 'UPLOADED_NEW'].includes(prior.status) && prior.aiGameId && knownAiIds.has(prior.aiGameId)) {
      counts.SKIPPED_CHECKPOINT++;
      console.log(`  [${i + 1}/${plan.games.length}] OGS ${game.id}: checkpoint ${prior.status}`);
      continue;
    }

    examinedThisRun++;
    const plannedBoardWidth = Number(game.boardWidth ?? game.boardSize);
    const plannedBoardHeight = Number(game.boardHeight ?? game.boardSize ?? plannedBoardWidth);
    if (isBelowMinAnalysisBoard(plannedBoardWidth, plannedBoardHeight)) {
      counts.SKIP_SMALL_BOARD++;
      state.games[key] = {
        ogsGameId: game.id,
        ended: game.ended,
        accounts: game.accounts,
        status: 'SKIP_SMALL_BOARD',
        aiGameId: null,
        error: null,
        boardWidth: plannedBoardWidth,
        boardHeight: plannedBoardHeight,
        boardSize: plannedBoardWidth === plannedBoardHeight ? plannedBoardWidth : null,
        minAnalysisBoardSize: MIN_OGS_ANALYSIS_BOARD_SIZE,
        updatedAt: new Date().toISOString(),
      };
      consecutiveServiceFailures = 0;
      console.log(`  [${i + 1}/${plan.games.length}] OGS ${game.id}: SKIP_SMALL_BOARD (${boardDimensionsLabel(plannedBoardWidth, plannedBoardHeight)}; minimum ${MIN_OGS_ANALYSIS_BOARD_SIZE}x${MIN_OGS_ANALYSIS_BOARD_SIZE})`);
      await saveOgsImportState(state);
      if (i + 1 < plan.games.length) await sleep(args.ogsDelayMs);
      continue;
    }

    let touchedUploadUi = false;
    try {
      console.log(`  [${i + 1}/${plan.games.length}] OGS ${game.id}: downloading SGF...`);
      const sgf = await ogsClient.sgf(game.id);
      const sgfRecord = parseSgfMainLine(sgf);
      if (isBelowMinAnalysisBoard(sgfRecord.boardWidth, sgfRecord.boardHeight)) {
        counts.SKIP_SMALL_BOARD++;
        state.games[key] = {
          ogsGameId: game.id,
          ended: game.ended,
          accounts: game.accounts,
          status: 'SKIP_SMALL_BOARD',
          aiGameId: null,
          error: null,
          boardWidth: sgfRecord.boardWidth,
          boardHeight: sgfRecord.boardHeight,
          boardSize: sgfRecord.boardSize,
          minAnalysisBoardSize: MIN_OGS_ANALYSIS_BOARD_SIZE,
          updatedAt: new Date().toISOString(),
        };
        consecutiveServiceFailures = 0;
        console.log(`    SKIP_SMALL_BOARD (${boardDimensionsLabel(sgfRecord.boardWidth, sgfRecord.boardHeight)}; minimum ${MIN_OGS_ANALYSIS_BOARD_SIZE}x${MIN_OGS_ANALYSIS_BOARD_SIZE}; no upload attempted)`);
        await saveOgsImportState(state);
        if (i + 1 < plan.games.length) await sleep(args.ogsDelayMs);
        continue;
      }
      const local = resolveLocalAiDuplicate(localLibrary.index, game, sgfRecord);
      if (local.match) {
        const result = { status: 'LOCAL_DUPLICATE', aiGameId: local.match.aiGameId, source: 'LOCAL_EXACT_BOARD_RECORD' };
        counts.LOCAL_DUPLICATE++;
        state.games[key] = {
          ogsGameId: game.id,
          ended: game.ended,
          accounts: game.accounts,
          status: result.status,
          aiGameId: result.aiGameId,
          error: null,
          fingerprint: local.fingerprint,
          updatedAt: new Date().toISOString(),
        };
        consecutiveServiceFailures = 0;
        console.log(`    LOCAL_DUPLICATE -> AI Sensei ${result.aiGameId} (exact board record; no upload attempted)`);
        await saveOgsImportState(state);
        if (i + 1 < plan.games.length) await sleep(args.ogsDelayMs);
        continue;
      }
      if (local.ambiguous) console.log(`    local fingerprint collision/short-game ambiguity (${local.candidates} candidate${local.candidates === 1 ? '' : 's'}); falling back to AI Sensei duplicate check`);

      uiUploadGamesThisRun++;
      touchedUploadUi = true;
      let result = null;
      let uploadPageHealthRecoveryRemaining = 1;
      for (let attempt = 1; attempt <= args.ogsUploadAttempts; attempt++) {
        // Validate the dedicated upload page immediately before every real UI
        // submission. Long checkpoint/local-duplicate stretches cannot leave us
        // holding a stale or live-but-broken upload page.
        while (true) {
          try {
            const uploadPage = await ensureLiveAiSenseiUploadPage(auth);
            result = await uploadOgsSgfToAiSensei(uploadPage, fsClient, auth.uid, game, sgf, knownAiIds, args.ogsUploadTimeoutMs);
            break;
          } catch (err) {
            if (!isUploadPageHealthError(err)) throw err;
            if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
            if (uploadPageHealthRecoveryRemaining > 0) {
              uploadPageHealthRecoveryRemaining--;
              counts.UPLOAD_PAGE_RECOVERIES++;
              const reason = isUploadPageStateError(err) ? 'upload page is alive but unusable' : 'upload page closed/detached';
              console.log(`    ${reason}; recreating a fresh AI Sensei upload tab and retrying this game once...`);
              try {
                await recreateAiSenseiUploadPage(auth);
              } catch (recreateErr) {
                if (!browserSessionIsConnected(auth)) throw new BrowserDisconnectedError();
                throw recreateErr;
              }
              continue;
            }
            result = {
              status: 'UPLOAD_FAILED',
              error: isUploadPageStateError(err) ? 'UPLOAD_PAGE_STATE_ERROR' : 'UPLOAD_PAGE_LIFECYCLE_ERROR',
              retryable: false,
              infrastructureFailure: true,
              serviceFailure: false,
            };
            break;
          }
        }
        if (result.status !== 'UPLOAD_FAILED' || !result.retryable || attempt >= args.ogsUploadAttempts) break;
        console.log(`    transient ${result.error}; retrying (${attempt + 1}/${args.ogsUploadAttempts})...`);
        // Regular per-game retries stay short. If the game still ends in a genuine
        // transient service failure, the adaptive cross-game cooldown below applies.
        await sleep(result.error === 'Too many requests' ? 15_000 * attempt : 2_000 * attempt);
      }

      counts[result.status] = (counts[result.status] ?? 0) + 1;
      state.games[key] = {
        ogsGameId: game.id,
        ended: game.ended,
        accounts: game.accounts,
        status: result.status,
        aiGameId: result.aiGameId ?? null,
        error: result.error ?? null,
        updatedAt: new Date().toISOString(),
      };
      if (result.status === 'UPLOADED_NEW' && result.aiGameId) {
        newlyUploadedAiIds.push(result.aiGameId);
        const fp = gameRecordFingerprint(sgfRecord);
        if (!localLibrary.index.has(fp)) localLibrary.index.set(fp, []);
        localLibrary.index.get(fp).push({ aiGameId: result.aiGameId, name: game.name, moveCount: sgfRecord.moves.length });
      }
      let adaptiveCooldownMs = 0;
      if (isGenuineServiceFailure(result)) {
        consecutiveServiceFailures++;
        transientFailurePressure++;
        adaptiveCooldownMs = transientCooldownMs(transientFailurePressure);
      } else if (result.status === 'UPLOADED_NEW' || result.status === 'ALREADY_ANALYZED') {
        consecutiveServiceFailures = 0;
        transientFailurePressure = 0;
      } else if (result.infrastructureFailure || result.status === 'UPLOAD_FAILED') {
        // Page-health/game-specific failures are not service failures and do not
        // bridge the five-consecutive-service-failures breaker.
        consecutiveServiceFailures = 0;
      }
      console.log(`    ${result.status}${result.aiGameId ? ` -> AI Sensei ${result.aiGameId}` : ''}${result.error ? ` (${result.error})` : ''}`);
      if (result.diagnostic) console.log(`      diagnostic: ${result.diagnostic.json} ; ${result.diagnostic.screenshot}`);
      if (adaptiveCooldownMs > 0) {
        counts.ADAPTIVE_COOLDOWNS++;
        adaptiveCooldownTotalMs += adaptiveCooldownMs;
        console.log(`      adaptive service cooldown: ${Math.round(adaptiveCooldownMs / 1000)}s before the next real upload attempt`);
      }
      await saveOgsImportState(state);
      if (consecutiveServiceFailures >= OGS_FAILURE_CIRCUIT_BREAKER) {
        console.log(`\nStopping import after ${OGS_FAILURE_CIRCUIT_BREAKER} consecutive genuine AI Sensei service failures. Check site status before retrying.`);
        stoppedEarly = true;
        stopReason = 'service-circuit-breaker';
        break;
      }
      if (adaptiveCooldownMs > 0 && i + 1 < plan.games.length) {
        await sleep(Math.max(args.ogsUploadDelayMs, adaptiveCooldownMs));
        touchedUploadUi = false; // adaptive wait already subsumed the normal post-game UI delay
      }
    } catch (err) {
      if (err?.code === 'BROWSER_DISCONNECTED' || !browserSessionIsConnected(auth)) {
        counts.BROWSER_DISCONNECTED++;
        state.games[key] = {
          ogsGameId: game.id,
          ended: game.ended,
          accounts: game.accounts,
          status: 'BROWSER_DISCONNECTED',
          aiGameId: null,
          error: 'BROWSER_DISCONNECTED',
          updatedAt: new Date().toISOString(),
        };
        consecutiveServiceFailures = 0;
        await saveOgsImportState(state);
        console.log('    BROWSER_DISCONNECTED (attached Chromium session is no longer available; stopping immediately)');
        stoppedEarly = true;
        stopReason = 'browser-disconnected';
        break;
      }

      if (isUploadPageHealthError(err)) {
        counts.UPLOAD_FAILED++;
        const code = isUploadPageStateError(err) ? 'UPLOAD_PAGE_STATE_ERROR' : 'UPLOAD_PAGE_LIFECYCLE_ERROR';
        state.games[key] = {
          ogsGameId: game.id,
          ended: game.ended,
          accounts: game.accounts,
          status: 'UPLOAD_FAILED',
          aiGameId: null,
          error: code,
          updatedAt: new Date().toISOString(),
        };
        // Infrastructure/page-health failures are not service failures and must
        // not advance or bridge the five-game AI Sensei service circuit breaker.
        consecutiveServiceFailures = 0;
        await saveOgsImportState(state);
        console.log(`    UPLOAD_FAILED (${code}: ${err.message})`);
      } else {
        counts.UPLOAD_FAILED++;
        state.games[key] = {
          ogsGameId: game.id,
          ended: game.ended,
          accounts: game.accounts,
          status: 'UPLOAD_FAILED',
          aiGameId: null,
          error: err.message,
          updatedAt: new Date().toISOString(),
        };
        // Unexpected/game-specific exceptions are not automatically classified as
        // AI Sensei service failures. Preserve them for retry without poisoning the
        // service-failure circuit breaker.
        consecutiveServiceFailures = 0;
        await saveOgsImportState(state);
        console.log(`    UPLOAD_FAILED (${err.message})`);
      }
    }
    if (i + 1 < plan.games.length) {
      await sleep(touchedUploadUi ? args.ogsUploadDelayMs : args.ogsDelayMs);
    }
  }

  let analysis = { complete: [], pending: [...new Set(newlyUploadedAiIds)] };
  if (stopReason !== 'browser-disconnected') {
    // Reconcile any new AI Sensei IDs that the UI did not expose directly.
    const finalUploads = await fsClient.allUploads(auth.uid);
    const finalIds = new Set(finalUploads.map(d => docId(d.name)));
    const initialIds = new Set(initialUploads.map(d => docId(d.name)));
    const diffIds = [...finalIds].filter(id => !initialIds.has(id));
    for (const id of diffIds) if (!newlyUploadedAiIds.includes(id)) newlyUploadedAiIds.push(id);
    analysis = await waitForImportedAnalyses(fsClient, auth.uid, newlyUploadedAiIds, args.waitAnalysisMinutes);
  } else {
    console.log('\nBrowser disconnected; skipping final Firestore reconciliation/analysis polling so the importer stops immediately.');
  }
  console.log('\nOGS IMPORT SUMMARY');
  console.log(`  selected scope:                        ${plan.games.length}`);
  console.log(`  skipped from verified checkpoint:      ${counts.SKIPPED_CHECKPOINT}`);
  console.log(`  examined this run:                     ${examinedThisRun}`);
  console.log(`  games sent to AI Sensei upload UI:     ${uiUploadGamesThisRun}`);
  console.log(`  pacing used:                          local ${args.ogsDelayMs} ms / upload-UI ${args.ogsUploadDelayMs} ms + adaptive 30s/60s/120s`);
  console.log(`    boards below ${MIN_OGS_ANALYSIS_BOARD_SIZE}x${MIN_OGS_ANALYSIS_BOARD_SIZE} skipped:             ${counts.SKIP_SMALL_BOARD}`);
  console.log(`    local exact duplicates (no upload):  ${counts.LOCAL_DUPLICATE}`);
  console.log(`    already analyzed via AI Sensei UI:   ${counts.ALREADY_ANALYZED}`);
  console.log(`    newly uploaded:                      ${counts.UPLOADED_NEW}`);
  console.log(`    final upload failures:               ${counts.UPLOAD_FAILED}`);
  console.log(`    upload-page health recoveries:       ${counts.UPLOAD_PAGE_RECOVERIES}`);
  console.log(`    adaptive cooldown events:            ${counts.ADAPTIVE_COOLDOWNS}`);
  console.log(`    adaptive cooldown time:              ${Math.round(adaptiveCooldownTotalMs / 1000)} s`);
  console.log(`    browser disconnect stops:            ${counts.BROWSER_DISCONNECTED}`);
  console.log(`  stopped early:                         ${stoppedEarly ? 'yes' : 'no'}${stopReason ? ` (${stopReason})` : ''}`);
  console.log(`  new AI Sensei game IDs observed:       ${newlyUploadedAiIds.length}`);
  if (stopReason === 'browser-disconnected') {
    console.log('    analysis complete:                   not checked (browser disconnected)');
    console.log(`    analysis pending/unchecked:          ${analysis.pending.length}`);
  } else {
    console.log(`    analysis complete:                   ${analysis.complete.length}`);
    console.log(`    analysis pending:                    ${analysis.pending.length}`);
  }
  console.log(`  checkpoint:                            ${OGS_IMPORT_STATE_JSON}`);
  console.log('\nDo not execute the cleanup plan generated before this import. Once pending analyses reach zero (or after they finish later), rerun the tool without --ogs-import to regenerate the full-history practice plan.');
}

function deterministicBackfillMemoId(uid, gameId, moveNumber) {
  return 'B' + crypto.createHash('sha256').update(`${uid}\0${gameId}\0${moveNumber}`).digest('hex').slice(0, 19);
}

function firestoreSolutionString(move) {
  return move === '<pass>' ? '' : move;
}

function firestoreSolutionsForFirstMove(move) {
  return {
    mapValue: {
      fields: {
        '0': { arrayValue: { values: [{ stringValue: firestoreSolutionString(move) }] } },
      },
    },
  };
}

function initialDueDate(now) {
  const hour = 60 * 60 * 1000;
  const t = now.getTime() + hour;
  return new Date(Math.ceil(t / hour) * hour).toISOString();
}

function describeMetric(candidate) {
  return {
    pointLoss: candidate?.pointLoss ?? '',
    myWinrateBefore: Number.isFinite(candidate?.myWinrateBefore) ? (candidate.myWinrateBefore * 100).toFixed(2) : '',
    myWinrateAfter: Number.isFinite(candidate?.myWinrateAfter) ? (candidate.myWinrateAfter * 100).toFixed(2) : '',
    winrateDrop: Number.isFinite(candidate?.winrateDrop) ? (candidate.winrateDrop * 100).toFixed(2) : '',
  };
}

function makeBaseRow(g, m = null) {
  return {
    gameId: g.gameId,
    gameName: g.game?.name ?? '',
    myColor: g.myColor ?? '',
    memoId: m?.id ?? '',
    moveNumber: m?.moveNumber ?? '',
    problemColor: m?.problemColor ?? '',
    problemColorSource: m?.problemColorSource ?? '',
    solutionKey: m?.solutionKey ?? '',
    solutionMove: '',
    solutionSource: '',
    pointLoss: '', myWinrateBefore: '', myWinrateAfter: '', winrateDrop: '',
    qualifiesFloor: '', top3DistinctSolution: '', action: '', reason: '', keeperMemoId: '',
    analysisStatus: '', updateTime: m?.updateTime ?? '', gameUpdateTime: g.game?.updateTime ?? '',
  };
}

function analyzeSavedSolutionValidation(gameMemos, solutionIndex, gameLength) {
  let checked = 0, matched = 0, mismatched = 0, unavailable = 0;
  const mismatches = [];
  for (const m of gameMemos) {
    if (!Number.isInteger(m.moveNumber) || m.moveNumber < 1 || m.moveNumber > gameLength) continue;
    if (!m.primarySolutionMoves?.length) continue;
    const derived = solutionIndex.get(m.moveNumber - 1);
    if (!derived?.firstMove) { unavailable++; continue; }
    checked++;
    if (m.primarySolutionMoves.includes(derived.firstMove)) matched++;
    else {
      mismatched++;
      if (mismatches.length < 10) mismatches.push({ moveNumber: m.moveNumber, saved: m.primarySolutionMoves, derived: derived.firstMove });
    }
  }
  return { checked, matched, mismatched, unavailable, mismatches };
}

async function buildPlan(fsClient, uid, args) {
  console.log('Fetching full problem library...');
  const memoDocs = await fsClient.allMemos(uid);
  const parsedMemos = memoDocs.map(parseMemo);
  console.log(`Problems found: ${parsedMemos.length}`);

  console.log('Fetching game history index...');
  const uploadDocs = await fsClient.allUploads(uid);
  const uploadDocsById = new Map(uploadDocs.map(d => [docId(d.name), d]));
  const memoGameIds = parsedMemos.filter(m => m.gameId).map(m => m.gameId);
  const historyIds = [...new Set([...uploadDocs.map(d => docId(d.name)), ...memoGameIds])].sort();
  console.log(`Historical games discovered: ${historyIds.length}`);

  let selectedIds = historyIds;
  if (Number.isFinite(args.maxGames)) selectedIds = selectedIds.slice(0, args.maxGames);
  console.log(`Historical games in selected scope: ${selectedIds.length}`);

  const selectedSet = new Set(selectedIds);
  const memoGroups = groupBy(parsedMemos.filter(m => m.gameId && selectedSet.has(m.gameId)), m => m.gameId);

  console.log('Fetching game metadata and analysis-node documents...');
  const gameDocNames = selectedIds.map(gid => `${FIRESTORE_ROOT}/:games/${gid}`);
  const gameNodeDocNames = selectedIds.map(gid => `${FIRESTORE_ROOT}/:game-data/${uid}/:nodes/${gid}`);
  const [gameDocsByName, gameNodeDocsByName] = await Promise.all([
    fsClient.batchGetChunked(gameDocNames),
    fsClient.batchGetChunked(gameNodeDocNames),
  ]);

  const prepared = [];
  let recoveredImportedGames = 0;
  for (const gameId of selectedIds) {
    const gameMemos = memoGroups.get(gameId) ?? [];
    const gameDoc = gameDocsByName.get(`${FIRESTORE_ROOT}/:games/${gameId}`);
    const nodeDoc = gameNodeDocsByName.get(`${FIRESTORE_ROOT}/:game-data/${uid}/:nodes/${gameId}`);
    let game = gameDoc ? parseGameDoc(gameDoc) : null;
    const gameNodes = nodeDoc ? parseGameNodeDoc(nodeDoc) : null;
    if (!game) {
      const recovered = recoverImportedGameFromUpload(uploadDocsById.get(gameId), nodeDoc);
      if (recovered.ok) {
        game = recovered.game;
        recoveredImportedGames++;
      } else {
        prepared.push({ gameId, gameMemos, game, gameNodes, fatal: recovered.reason ?? 'MISSING_GAME_DOCUMENT' });
        continue;
      }
    }
    const who = playerColorFromGameName(game.name, args.me);
    if (!who.color) {
      prepared.push({ gameId, gameMemos, game, gameNodes, myColor: null, fatal: who.reason });
      continue;
    }
    if (!gameNodes) {
      prepared.push({ gameId, gameMemos, game, gameNodes, myColor: who.color, fatal: 'NO_ANALYSIS_NODE_DOCUMENT' });
      continue;
    }
    if (!Array.isArray(game.moves) || game.moves.length === 0) {
      prepared.push({ gameId, gameMemos, game, gameNodes, myColor: who.color, fatal: 'EMPTY_GAME_MOVE_RECORD' });
      continue;
    }

    const alternatingColorMap = inferAlternatingColorMap(game, gameNodes);
    const colorByMove = new Map();
    let unresolvedMove = null;
    for (let n = 1; n <= game.moves.length; n++) {
      const c = resolveProblemColor(n, game, gameNodes, alternatingColorMap);
      if (!c.color) { unresolvedMove = { moveNumber: n, source: c.source }; break; }
      colorByMove.set(n, c);
    }
    if (unresolvedMove) {
      prepared.push({ gameId, gameMemos, game, gameNodes, myColor: who.color, fatal: `INCOMPLETE_MOVE_COLOR_SERIES@${unresolvedMove.moveNumber}:${unresolvedMove.source}` });
      continue;
    }

    const annotatedMemos = gameMemos.map(m => {
      const c = Number.isInteger(m.moveNumber) ? resolveProblemColor(m.moveNumber, game, gameNodes, alternatingColorMap) : { color: null, source: 'INVALID_MOVE_NUMBER' };
      return { ...m, problemColor: c.color, problemColorSource: c.source };
    });

    prepared.push({
      gameId, gameMemos: annotatedMemos, game, gameNodes, myColor: who.color,
      colorByMove, alternatingColorMap, fatal: null,
    });
  }

  if (recoveredImportedGames) {
    console.log(`Recovered ${recoveredImportedGames} imported games from completed upload metadata + node chains.`);
  }

  const toAnalyze = prepared.filter(g => !g.fatal);
  console.log(`Eligible games requiring full-history comparison: ${toAnalyze.length}`);
  let analyzedCount = 0;
  await mapLimit(toAnalyze, ANALYSIS_CONCURRENCY, async g => {
    try {
      const docs = await fsClient.analysisNodes(g.gameId);
      const plainDocs = docs.map(doc => augmentDocWithCompressedAnalysis(doc, args.verbose, 'analysis-collection'));
      const collectionAdapter = buildAnalysisAdapterFromPlainDocs(plainDocs, g.gameNodes.byId, args.verbose, 'analysis-collection');
      const gameNodeAdapter = buildAnalysisAdapterFromGameNodeDoc(g.gameNodes, args.verbose);
      const adapter = mergeAnalysisAdapters(collectionAdapter, gameNodeAdapter);
      if (!adapter.ok) {
        g.analysisError = adapter.reason ?? 'NO_USABLE_ANALYSIS';
        g.analysisMeta = adapter.meta ?? null;
        return;
      }
      const solutionIndex = buildSolutionIndexFromPlainDocs(plainDocs, g.game.boardSize ?? 19);
      g.analysis = adapter;
      g.solutionIndex = solutionIndex;
      g.solutionValidation = analyzeSavedSolutionValidation(g.gameMemos, solutionIndex, g.game.moves.length);

      const mine = [];
      const metricFailures = [];
      for (let n = 1; n <= g.game.moves.length; n++) {
        const c = g.colorByMove.get(n);
        if (c?.color !== g.myColor) continue;
        const ev = evaluateCandidate({ moveNumber: n, problemColor: c.color }, adapter, g.gameNodes.byId, g.myColor);
        if (!ev.ok) metricFailures.push({ moveNumber: n, reason: ev.reason });
        else mine.push({ moveNumber: n, problemColor: c.color, problemColorSource: c.source, ...ev });
      }
      if (metricFailures.length) {
        const sample = metricFailures.slice(0, 5).map(x => `${x.moveNumber}:${x.reason}`).join(',');
        g.analysisError = `INCOMPLETE_POINT_LOSS_SERIES:${metricFailures.length}:${sample}`;
        g.metricFailures = metricFailures;
        return;
      }
      if (!mine.length) {
        g.analysisError = 'NO_USER_MOVES_IN_GAME';
        return;
      }

      const candidatesWithSolutions = mine.map(c => {
        const sol = solutionIndex.get(c.moveNumber - 1);
        return {
          ...c,
          solutionMove: sol?.firstMove ?? null,
          solutionSource: sol?.source ?? null,
          pv: sol?.pv ?? null,
        };
      });
      const distinct = selectTopDistinctByFirstSolutionMove(candidatesWithSolutions);
      if (distinct.error) {
        g.analysisError = distinct.error;
        return;
      }
      const top3 = distinct.top;
      if (!top3.length) {
        g.analysisError = 'NO_DISTINCT_SOLUTION_CANDIDATES';
        return;
      }
      g.allMyMoves = mine;
      g.top3 = top3;
      g.selection = chooseCanonicalFromTop3(top3);
    } catch (err) {
      g.analysisError = `ANALYSIS_QUERY_FAILED:${err.message}`;
    } finally {
      analyzedCount++;
      process.stdout.write(`\rAnalyzed games ${analyzedCount}/${toAnalyze.length}`);
    }
  });
  if (toAnalyze.length) process.stdout.write('\n');

  const rows = [];
  const deletionMemos = [];
  const createMemos = [];
  const skippedGames = [];
  const gameSummaries = [];
  const totals = {
    eligibleGames: 0, qualifyingGames: 0, existingProblemKeptGames: 0, replacementCreateGames: 0,
    newCreateGames: 0, belowFloorGames: 0, skippedGames: 0,
    staleCanonicalSolutionReplacementGames: 0,
    validationChecked: 0, validationMatched: 0, validationMismatched: 0, validationUnavailable: 0,
  };

  for (const g of prepared) {
    const gameName = g.game?.name ?? '';
    const fatal = g.fatal ?? g.analysisError ?? null;
    if (fatal) {
      totals.skippedGames++;
      skippedGames.push({ gameId: g.gameId, gameName, reason: fatal });
      if (g.gameMemos.length) {
        for (const m of g.gameMemos) {
          const row = makeBaseRow(g, m);
          row.action = 'SKIP'; row.reason = fatal; row.analysisStatus = fatal;
          rows.push(row);
        }
      } else {
        const row = makeBaseRow(g);
        row.action = 'SKIP'; row.reason = fatal; row.analysisStatus = fatal;
        rows.push(row);
      }
      gameSummaries.push({ gameId: g.gameId, gameName, myColor: g.myColor ?? null, reason: fatal });
      continue;
    }

    totals.eligibleGames++;
    const sv = g.solutionValidation ?? {};
    totals.validationChecked += sv.checked ?? 0;
    totals.validationMatched += sv.matched ?? 0;
    totals.validationMismatched += sv.mismatched ?? 0;
    totals.validationUnavailable += sv.unavailable ?? 0;

    const top3 = g.top3 ?? [];
    const selected = g.selection?.keeper ?? null;
    const top3Moves = new Set(top3.map(x => x.moveNumber));
    if (!selected) {
      totals.belowFloorGames++;
      for (const m of g.gameMemos) {
        const row = makeBaseRow(g, m);
        const metric = g.allMyMoves?.find(x => x.moveNumber === m.moveNumber);
        Object.assign(row, describeMetric(metric));
        row.top3DistinctSolution = top3Moves.has(m.moveNumber) ? 'YES' : '';
        row.action = 'DELETE';
        row.reason = 'NO_QUALIFYING_PRACTICE_POSITION';
        row.analysisStatus = 'OK_BELOW_FLOOR';
        rows.push(row);
        deletionMemos.push(m);
      }
      if (!g.gameMemos.length) {
        const row = makeBaseRow(g);
        row.action = 'NONE'; row.reason = 'NO_QUALIFYING_PRACTICE_POSITION'; row.analysisStatus = 'OK_BELOW_FLOOR';
        rows.push(row);
      }
      gameSummaries.push({
        gameId: g.gameId, gameName, myColor: g.myColor, reason: 'NO_QUALIFYING_PRACTICE_POSITION', top3,
        solutionValidation: sv,
      });
      continue;
    }

    totals.qualifyingGames++;
    // A canonical saved problem is current only if today's analysis still accepts
    // the derived best first move as one of its saved solution moves. If the same
    // position exists but its saved solution disagrees with current analysis, plan
    // a replacement using today's solution. Execution creates+verifies replacements
    // before deleting the stale memo.
    const matchingPosition = g.gameMemos.filter(m =>
      m.moveNumber === selected.moveNumber &&
      m.problemColor === g.myColor
    );
    const matchingCurrentSolution = matchingPosition.filter(m =>
      (m.primarySolutionMoves ?? []).includes(selected.solutionMove)
    );
    const keeperMemo = matchingCurrentSolution.length ? chooseRepresentativeMemo(matchingCurrentSolution) : null;
    const staleCanonicalPosition = matchingPosition.length > 0 && !keeperMemo;
    if (staleCanonicalPosition) totals.staleCanonicalSolutionReplacementGames++;
    const needsCreate = !keeperMemo;
    let proposedId = null;
    if (needsCreate) {
      proposedId = deterministicBackfillMemoId(uid, g.gameId, selected.moveNumber);
      const c = {
        memoId: proposedId,
        gameId: g.gameId,
        moveNumber: selected.moveNumber,
        solutionMove: selected.solutionMove,
        solutionKey: selected.solutionKey,
        gameDocName: g.game.docName,
        gameUpdateTime: g.game.updateTime,
      };
      createMemos.push(c);
      const row = makeBaseRow(g);
      Object.assign(row, describeMetric(selected));
      row.memoId = proposedId;
      row.moveNumber = selected.moveNumber;
      row.problemColor = g.myColor;
      row.problemColorSource = selected.problemColorSource ?? '';
      row.solutionKey = selected.solutionKey;
      row.solutionMove = selected.solutionMove;
      row.solutionSource = selected.solutionSource;
      row.qualifiesFloor = 'YES'; row.top3DistinctSolution = 'YES';
      row.action = 'CREATE';
      row.reason = g.gameMemos.length ? 'CREATE_CANONICAL_REPLACEMENT' : 'CREATE_CANONICAL_NEW';
      row.keeperMemoId = proposedId;
      row.analysisStatus = 'OK';
      rows.push(row);
      if (g.gameMemos.length) totals.replacementCreateGames++; else totals.newCreateGames++;
    } else {
      totals.existingProblemKeptGames++;
    }

    for (const m of g.gameMemos) {
      const row = makeBaseRow(g, m);
      const metric = g.allMyMoves?.find(x => x.moveNumber === m.moveNumber);
      Object.assign(row, describeMetric(metric));
      row.top3DistinctSolution = top3Moves.has(m.moveNumber) ? 'YES' : '';
      row.qualifiesFloor = metric && qualifiesPracticeFloor(metric) ? 'YES' : '';
      row.keeperMemoId = keeperMemo?.id ?? proposedId ?? '';
      row.analysisStatus = 'OK';

      if (keeperMemo && m.id === keeperMemo.id) {
        row.action = 'KEEP';
        row.reason = 'CANONICAL_EXISTING_PROBLEM';
        row.solutionMove = selected.solutionMove;
        row.solutionSource = selected.solutionSource;
      } else {
        row.action = 'DELETE';
        if (m.problemColor && m.problemColor !== g.myColor) row.reason = 'OPPONENT_PROBLEM';
        else if (m.moveNumber === selected.moveNumber) row.reason = keeperMemo ? 'SAME_POSITION_DUPLICATE' : 'STALE_SOLUTION_AT_CANONICAL_POSITION';
        else if ((m.primarySolutionMoves ?? []).includes(selected.solutionMove)) row.reason = 'REPEATED_SOLUTION_OTHER_TURN';
        else row.reason = needsCreate ? 'REPLACED_BY_CANONICAL_CREATE' : 'OTHER_MY_MISTAKE';
        deletionMemos.push(m);
      }
      rows.push(row);
    }

    gameSummaries.push({
      gameId: g.gameId, gameName, myColor: g.myColor,
      reason: needsCreate
        ? (staleCanonicalPosition ? 'CREATE_CANONICAL_REPLACEMENT_STALE_SOLUTION' : (g.gameMemos.length ? 'CREATE_CANONICAL_REPLACEMENT' : 'CREATE_CANONICAL_NEW'))
        : 'CANONICAL_EXISTING_PROBLEM',
      keeperMemoId: keeperMemo?.id ?? proposedId,
      keeperMoveNumber: selected.moveNumber,
      solutionMove: selected.solutionMove,
      pointLoss: selected.pointLoss,
      myWinrateBefore: selected.myWinrateBefore,
      myWinrateAfter: selected.myWinrateAfter,
      winrateDrop: selected.winrateDrop,
      top3,
      solutionValidation: sv,
    });
  }

  rows.sort((a, b) => `${a.gameId}/${String(a.moveNumber).padStart(5, '0')}/${a.action}/${a.memoId}`.localeCompare(`${b.gameId}/${String(b.moveNumber).padStart(5, '0')}/${b.action}/${b.memoId}`));

  return {
    generatedAt: new Date().toISOString(), uid, myNames: args.me,
    problemCount: parsedMemos.length,
    historicalGameCount: historyIds.length,
    selectedGameCount: selectedIds.length,
    selectedExistingMemoCount: parsedMemos.filter(m => m.gameId && selectedSet.has(m.gameId)).length,
    rows, deletionMemos, createMemos, skippedGames, gameSummaries, totals,
    rawMemoDocs: memoDocs,
  };
}

async function writePlan(plan) {
  const hash = stablePlanHash(plan.rows);
  const summary = {
    generatedAt: plan.generatedAt,
    myNames: plan.myNames,
    problemCount: plan.problemCount,
    historicalGameCount: plan.historicalGameCount,
    selectedGameCount: plan.selectedGameCount,
    selectedExistingMemoCount: plan.selectedExistingMemoCount,
    totals: plan.totals,
    keepCount: plan.rows.filter(r => r.action === 'KEEP').length,
    createCount: plan.rows.filter(r => r.action === 'CREATE').length,
    deleteCount: plan.rows.filter(r => r.action === 'DELETE').length,
    skipCount: plan.rows.filter(r => r.action === 'SKIP').length,
    noneCount: plan.rows.filter(r => r.action === 'NONE').length,
    skippedGameCount: plan.skippedGames.length,
    planHash: hash,
    games: plan.gameSummaries,
    skippedGames: plan.skippedGames,
    rows: plan.rows,
  };
  await fs.writeFile(PLAN_JSON, JSON.stringify(summary, null, 2));
  await fs.writeFile(PLAN_CSV, planToCsv(plan.rows));
  return hash;
}

function printSummary(plan, hash) {
  const count = a => plan.rows.filter(r => r.action === a).length;
  const delReason = reason => plan.rows.filter(r => r.action === 'DELETE' && r.reason === reason).length;
  const t = plan.totals;
  const pct = t.validationChecked ? (100 * t.validationMatched / t.validationChecked).toFixed(2) : 'n/a';

  console.log(`Historical saved-problem first moves compared with current analysis (diagnostic only): ${t.validationChecked}`);
  console.log(`  matched: ${t.validationMatched} (${pct}${pct === 'n/a' ? '' : '%'})`);
  console.log(`  mismatched: ${t.validationMismatched}`);
  console.log(`  unavailable: ${t.validationUnavailable}`);
  console.log('  NOTE: a mismatch at the selected canonical position causes replacement with today\'s derived solution.');

  console.log('\nFULL-HISTORY PLAN SUMMARY');
  console.log(`  historical games discovered:          ${plan.historicalGameCount}`);
  console.log(`  games in selected scope:              ${plan.selectedGameCount}`);
  console.log(`  eligible games analyzed:              ${t.eligibleGames}`);
  console.log(`  games with qualifying practice move:  ${t.qualifyingGames}`);
  console.log(`    existing canonical problem kept:    ${t.existingProblemKeptGames}`);
  console.log(`    replacement problem to create:      ${t.replacementCreateGames}`);
  console.log(`    new problem to create:              ${t.newCreateGames}`);
  console.log(`  games below 1pt / 2% floor:           ${t.belowFloorGames}`);
  console.log(`  ambiguous/unsupported games skipped:  ${t.skippedGames}`);
  console.log('');
  console.log(`  KEEP rows:                            ${count('KEEP')}`);
  console.log(`  CREATE rows:                          ${count('CREATE')}`);
  console.log(`  DELETE rows:                          ${count('DELETE')}`);
  console.log(`    opponent problems:                  ${delReason('OPPONENT_PROBLEM')}`);
  console.log(`    repeated same solution:             ${delReason('REPEATED_SOLUTION_OTHER_TURN')}`);
  console.log(`    same-position duplicates:           ${delReason('SAME_POSITION_DUPLICATE')}`);
  console.log(`    stale canonical solutions:          ${delReason('STALE_SOLUTION_AT_CANONICAL_POSITION')}`);
  console.log(`    other/replaced/below-floor:         ${count('DELETE') - delReason('OPPONENT_PROBLEM') - delReason('REPEATED_SOLUTION_OTHER_TURN') - delReason('SAME_POSITION_DUPLICATE') - delReason('STALE_SOLUTION_AT_CANONICAL_POSITION')}`);
  console.log(`  games replacing stale canonical solution: ${t.staleCanonicalSolutionReplacementGames}`);
  console.log(`  SKIP rows:                            ${count('SKIP')}`);
  console.log(`  NONE rows (correctly zero problems):  ${count('NONE')}`);
  console.log(`  plan hash:                            ${hash}`);
  console.log(`  audit files:                          ${PLAN_JSON}, ${PLAN_CSV}`);
  console.log(`  practice floor:                       ${MIN_POINT_LOSS.toFixed(1)} point OR ${(MIN_WR_DROP * 100).toFixed(0)} percentage-point win-rate loss`);
}

async function writeMemoBackup(plan) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const file = path.resolve(`memos-backup-${stamp}.json`);
  await fs.writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), memoCount: plan.rawMemoDocs.length, documents: plan.rawMemoDocs }, null, 2));
  return file;
}

async function verifyCreates(fsClient, creates, uid) {
  if (!creates.length) return;
  const names = creates.map(c => `${FIRESTORE_ROOT}/:users/${uid}/:memos/${c.memoId}`);
  const found = await fsClient.batchGetChunked(names);
  const problems = [];
  for (const c of creates) {
    const name = `${FIRESTORE_ROOT}/:users/${uid}/:memos/${c.memoId}`;
    const doc = found.get(name);
    if (!doc) { problems.push(`${c.gameId}@${c.moveNumber}:missing`); continue; }
    const m = parseMemo(doc);
    if (m.gameId !== c.gameId || m.moveNumber !== c.moveNumber || !(m.primarySolutionMoves ?? []).includes(c.solutionMove)) {
      problems.push(`${c.gameId}@${c.moveNumber}:field-mismatch`);
    }
  }
  if (problems.length) throw new Error(`CREATE verification failed for ${problems.slice(0, 10).join(', ')}`);
}

async function executePlan(fsClient, plan, hash, confirmHash, args) {
  if (hash !== confirmHash) {
    die(`Plan hash mismatch. Current plan is ${hash}, but --confirm was ${confirmHash}. Review the newly generated CSV before executing.`);
  }
  if (plan.createMemos.length && !args.allowCreate) {
    die(`This plan contains ${plan.createMemos.length} CREATE rows. Re-run with --allow-create only after reviewing the current-analysis first-move diagnostic and CREATE rows in cleanup-plan.csv.`);
  }

  const backup = await writeMemoBackup(plan);
  console.log(`Pre-change memo backup written: ${backup}`);

  if (plan.createMemos.length) {
    console.log(`Creating ${plan.createMemos.length} canonical practice problems before any deletions...`);
    let done = 0;
    for (let i = 0; i < plan.createMemos.length; i += CREATE_BATCH_SIZE) {
      const batch = plan.createMemos.slice(i, i + CREATE_BATCH_SIZE);
      await fsClient.commitCreates(batch, plan.uid);
      done += batch.length;
      console.log(`  created ${done}/${plan.createMemos.length}`);
    }
    console.log('Verifying all created problems before deleting anything...');
    await verifyCreates(fsClient, plan.createMemos, plan.uid);
    console.log('CREATE verification passed.');
  }

  if (plan.deletionMemos.length) {
    console.log(`Deleting ${plan.deletionMemos.length} superseded problems with updateTime preconditions...`);
    let done = 0;
    for (let i = 0; i < plan.deletionMemos.length; i += DELETE_BATCH_SIZE) {
      const batch = plan.deletionMemos.slice(i, i + DELETE_BATCH_SIZE);
      await fsClient.commitDeletes(batch);
      done += batch.length;
      console.log(`  deleted ${done}/${plan.deletionMemos.length}`);
    }
  }

  console.log('Re-reading problem library for verification...');
  const remainingDocs = await fsClient.allMemos(plan.uid);
  const expected = plan.problemCount + plan.createMemos.length - plan.deletionMemos.length;
  console.log(`  expected remaining: ${expected}`);
  console.log(`  actual remaining:   ${remainingDocs.length}`);
  if (remainingDocs.length !== expected) throw new Error('Final memo count does not match the reviewed plan. Stop and inspect the backup/audit files.');
  console.log('Verification count matches.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.goquestImport) {
    await runGoQuestImportStage(args);
    return;
  }
  const auth = await captureAuth(args);
  try {
    console.log(`Authenticated Firebase user: ${auth.uid.slice(0, 6)}…${auth.uid.slice(-4)}`);
    const fsClient = new FirestoreClient(auth);
    if (args.ogsImport) {
      await runOgsImportStage(auth, fsClient, args);
      return;
    }
    const plan = await buildPlan(fsClient, auth.uid, args);
    const hash = await writePlan(plan);
    printSummary(plan, hash);

    if (!args.execute) {
      const replay = replayCliArgs(args);
      const scriptName = invokedScriptPath();
      const createNote = plan.createMemos.length
        ? `\nCREATE execution is intentionally gated. After validating the derived first moves, execution additionally requires --allow-create.`
        : '';
      console.log(`\nDRY RUN ONLY. Nothing was changed.${createNote}\nReviewed-plan command (do not run until validation is complete):\n  node ${shellQuote(scriptName)}${replay ? ` ${replay}` : ''} --execute${plan.createMemos.length ? ' --allow-create' : ''} --confirm ${hash}\n`);
      return;
    }
    await executePlan(fsClient, plan, hash, args.confirm, args);
  } finally {
    if (auth.externalBrowser) {
      // The importer creates a dedicated upload tab in the user's attached browser; close only
      // that script-owned tab on normal exit, never the user's pre-existing tabs.
      if (auth.uploadPage && !auth.uploadPage.isClosed()) await auth.uploadPage.close().catch(() => {});
    } else {
      await auth.context.close();
    }
  }
}

main().then(() => {
  // A Playwright CDP attachment keeps its transport referenced even after all
  // CLI work is complete. Exit the CLI without closing the externally-owned
  // Chromium instance.
  process.exit(0);
}).catch(err => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
