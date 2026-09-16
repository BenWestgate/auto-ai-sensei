# Auto AI Sensei

Auto AI Sensei is a dry-run-first Node.js tool for people who use [AI Sensei](https://ai-sensei.com/) for Go/Baduk study. It can:

- curate an existing AI Sensei practice library to at most one high-value problem per eligible game;
- import completed OGS games while avoiding known duplicates;
- inspect public GoQuest history data in a read-only mode.

There are no built-in usernames or account IDs. You provide your own AI Sensei aliases, OGS accounts, and GoQuest accounts on the command line.

> This project automates AI Sensei's current web application and Firestore data model; it is not an official AI Sensei API client. Site/schema changes can break it. Always run and review the dry-run plan before allowing changes.

## Requirements

- Linux or another environment where Playwright/Chromium works
- Node.js 20+
- npm
- an AI Sensei account
- a system Chromium/Chrome executable if you use the recommended CDP login flow

## Install

```bash
git clone <repository-url>
cd auto-ai-sensei
npm ci
```

If you want Playwright to launch its own browser, also run `npx playwright install chromium`. For the recommended CDP flow below, install Chromium/Chrome through your operating system so you have a browser executable you can launch directly.

Check the CLI:

```bash
npm test
npm run help
```

## Authenticate to AI Sensei

The safest practical workflow is to launch your own Chromium profile with remote debugging, log in to AI Sensei yourself, and let the script attach to that already-authenticated browser.

```bash
chromium \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.ai-sensei-browser" \
  --no-first-run \
  --no-default-browser-check \
  https://ai-sensei.com
```

Leave that browser running. `.ai-sensei-browser/` is ignored by Git and must never be committed.

You can also omit `--cdp` and let Playwright use `.ai-sensei-playwright-profile/`, but interactive sign-in from an automated browser can be less reliable.

## Curate your practice problems

Tell the planner every name/handle that may identify you in imported game titles. Repeat `--me` for aliases from different servers.

At least one `--me` value is required for cleanup. This is deliberate: the tool refuses to guess which side of an ordinary game is yours.

```bash
node src/ai-sensei.mjs \
  --cdp http://127.0.0.1:9222 \
  --me YOUR_HANDLE \
  --me YOUR_OTHER_ALIAS
```

This is a dry run. It writes:

```text
cleanup-plan.json
cleanup-plan.csv
```

The current policy considers only your moves, de-duplicates mistakes by the AI's first solution move, looks at the top three distinct mistakes by point loss, and selects at most one problem when it loses at least 1 point or 2 percentage points of win rate. Ambiguous games are skipped rather than guessed.

Review the CSV before doing anything else. The important actions are:

- `KEEP`: already the desired canonical problem;
- `CREATE`: create the selected canonical problem;
- `DELETE`: remove a superseded/opponent/below-floor problem;
- `SKIP`: identity or analysis was not safe to infer;
- `NONE`: the game correctly needs no saved problem.

The dry run prints a plan hash and a ready-to-copy execution command. Use that exact hash only after reviewing the newly generated plan. A typical mutation command looks like:

```bash
node src/ai-sensei.mjs \
  --cdp http://127.0.0.1:9222 \
  --me YOUR_HANDLE \
  --execute \
  --allow-create \
  --confirm PLAN_HASH_FROM_DRY_RUN
```

`--allow-create` is required only when the reviewed plan contains `CREATE` rows. Execution writes a memo backup, creates and verifies replacements first, then performs guarded deletes. If the plan changes, the old hash is rejected.

For a small first pass, add `--max-games 20 --verbose` to the dry run.

## Import your OGS games

OGS accounts are also explicit; repeat `--ogs-account` if you have more than one.

First generate and review the import plan:

```bash
node src/ai-sensei.mjs \
  --cdp http://127.0.0.1:9222 \
  --ogs-import \
  --ogs-account YOUR_OGS_HANDLE
```

This writes `ogs-import-plan.json` and `ogs-import-plan.csv` and prints an OGS plan hash. To test only a few games, add `--max-ogs-games 20`.

After review, use the command printed by the dry run. Its mutation gates are:

```text
--allow-ogs-upload
--confirm-ogs PLAN_HASH
```

The importer checkpoints completed work in `ogs-import-state.json`, so interrupted runs can resume. It fingerprints board records before opening the upload UI, skips boards where either dimension is below 7, and never automates AI Sensei's "Reupload game" choice.

After imported games finish analysis, run the normal curation dry run again so they can contribute practice problems.

## Inspect GoQuest data

The GoQuest stage is deliberately read-only and does not open an authenticated AI Sensei session:

```bash
node src/ai-sensei.mjs \
  --goquest-import \
  --goquest-account YOUR_GOQUEST_HANDLE
```

It probes `go9`, `go13`, and `go19` public data and writes JSON/CSV audit files. On systems where Chromium is elsewhere, pass `--goquest-chromium /path/to/chromium`.

GoQuest upload is not implemented.

## Customize the curation policy

The policy is intentionally code-defined rather than silently configurable. The main constants near the top of `src/ai-sensei.mjs` are:

```js
const MIN_POINT_LOSS = 1.0;
const MIN_WR_DROP = 0.02;
const TOP_POINT_LOSS_CANDIDATES = 3;
```

If you fork the project to use different study criteria, change those constants, run `npm test`, generate a fresh dry-run plan, and inspect the resulting `CREATE`/`DELETE` rows. Never reuse a plan hash from an older policy or analysis state.

## Generated and sensitive files

Plans, checkpoints, backups, diagnostics, browser profiles, and HAR files are ignored by Git. Treat them as private: they can contain game metadata or authenticated session material.

Do not commit cookies, Firebase tokens, browser user-data directories, OAuth secrets, passwords, or raw `Authorization` headers.

## Design notes

The invariants behind move indexing, player identity, replacement ordering, duplicate detection, and write safety are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

ISC.
