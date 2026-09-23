# Auto AI Sensei

Auto AI Sensei is a dry-run-first Node.js tool for people who use [AI Sensei](https://ai-sensei.com/) for Go/Baduk study. It can:

- curate an existing AI Sensei practice library to at most one high-value problem per eligible game;
- import completed OGS games while avoiding known duplicates;
- inspect public GoQuest history data in a read-only mode.

There are no built-in usernames or account IDs. You provide your own AI Sensei aliases, OGS accounts, and GoQuest accounts on the command line.

> This project automates AI Sensei's current web application and Firestore data model; it is not an official AI Sensei API client. Site/schema changes can break it. Always run and review the dry-run plan before allowing changes.

## Quick start for non-technologists

For normal use, there are now three commands to remember:

```bash
npm run self-test
npm run upload-games
npm run update-problems
```

- `npm run self-test` checks your setup without changing anything.
- `npm run upload-games` finds all completed games from the OGS account name(s) you enter, shows the upload plan, asks you to type `YES`, and only then uploads/reconciles that exact hash-checked plan.
- `npm run update-problems` checks all eligible AI Sensei games, shows the proposed practice changes, asks you to type `YES`, and only then applies the exact hash-checked plan.

Both guided commands run the self-test first. They default to the browser on `http://127.0.0.1:9222`, prompt for your OGS/player names if you did not supply them, and stop without changes unless you explicitly confirm.

The underlying safety model is intentionally two-stage even though each guided workflow is one command:

1. **Preview first.** The program reads your AI Sensei account and produces a plan. It does not change anything.
2. **Apply only after review.** If the plan looks right, copy the exact confirmation command printed by the program.

If anything looks unexpected, stop after step 1. A dry run is safe to repeat.

### 1. Install the prerequisites

You need:

- Linux or another environment where Playwright/Chromium works
- Node.js 20+
- npm
- Git
- Chrome or Chromium
- an AI Sensei account

If `node --version`, `npm --version`, `git --version`, and either `chromium --version` or `google-chrome --version` all print a version number, you are ready.

### 2. Download Auto AI Sensei

Open a terminal and copy/paste:

```bash
git clone https://github.com/BenWestgate/auto-ai-sensei.git
cd auto-ai-sensei
npm ci
npm test
```

You should see the tests finish without failures. You normally only need to do this installation once.

### 3. Open AI Sensei in a browser the program can use

First try this command:

```bash
chromium \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.ai-sensei-browser" \
  --no-first-run \
  --no-default-browser-check \
  https://ai-sensei.com
```

If your computer calls the browser `google-chrome` instead of `chromium`, replace only the first word.

Sign in to AI Sensei in the browser window that opens and **leave that window open** while Auto AI Sensei is running.

### 4. Preview your practice-library cleanup

For most users, run:

```bash
npm run update-problems
```

It prompts for your player name(s), builds the plan, summarizes it, and asks for confirmation. The lower-level dry-run command below is available when you want to inspect or automate the individual stages yourself.

Replace `YOUR_HANDLE` with your own name as it appears in your games. If you have multiple names, add another `--me YOUR_OTHER_NAME` line.

```bash
node src/ai-sensei.mjs \
  --cdp http://127.0.0.1:9222 \
  --me YOUR_HANDLE
```

This is a **dry run**. It does not change your account. It creates `cleanup-plan.csv` and `cleanup-plan.json`.

Open `cleanup-plan.csv` in a spreadsheet program. The main action words are:

- `KEEP` — already correct; no change.
- `UPDATE` — keep the same problem but fix its accepted solutions.
- `CREATE` — add a selected practice problem.
- `DELETE` — remove a superseded or unwanted problem.
- `NONE` — this game correctly needs no problem.
- `SKIP` — the program could not safely determine what to do, so it leaves the game alone.

### 5. Apply the reviewed plan

At the end of the dry run, Auto AI Sensei prints a **Reviewed-plan command** containing a plan hash. If the CSV looks correct, copy/paste that exact printed command.

Do not reuse an old confirmation command after games, analyses, settings, or code have changed. The safety hash is designed to reject a stale plan.

Before making changes, the program writes a restorable memo backup. It also verifies create/update operations before guarded deletions.

### 6. Updating Auto AI Sensei later

From the `auto-ai-sensei` folder:

```bash
git pull
npm ci
npm test
```

Then repeat the browser + dry-run steps above.

## Detailed usage

The rest of this README explains the same workflow in more detail, including OGS imports, GoQuest inspection, rank-aware curation, and advanced safety behavior.

## Install details

If you want Playwright to launch its own browser, run `npx playwright install chromium`. For the recommended CDP flow above, install Chromium/Chrome through your operating system so you have a browser executable you can launch directly.

Check the CLI:

```bash
npm test
npm run help
```

## Authenticate to AI Sensei

The safest practical workflow is the browser flow from the Quick Start: launch your own Chromium profile with remote debugging, log in to AI Sensei yourself, and let the script attach to that already-authenticated browser.

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

The curation policy follows AI Sensei's own rank-aware Quiz behavior instead of a fixed loss threshold:

1. Resolve the player's teaching rank from the game-time SGF rank, AI Rank Prediction, current OGS rank, then `10k` as a final fallback.
2. Open Start Quiz for the player's color, sort by point loss, enable Avoid same move, and begin at that normal rank.
3. If fewer than three Quiz problems exist, strengthen the student level one step at a time until at least three appear or the slider reaches its maximum.
4. Reconcile the Quiz count against the analyzed moves and take up to the three largest distinct point-loss mistakes.
5. Rank those candidates by positive win-rate loss first; if win-rate loss is unavailable/zero for all of them, use point loss. Ties use point loss, then earlier move number.
6. For wins, draws, and unknown results, a temporary-rank candidate must still be bad at the normal rank: Inaccuracy/Mistake/Blunder in point mode, or Mistake/Blunder in win-rate mode. Losses remain eligible even when the normal-rank label becomes Good.

For the chosen position, the saved solution set contains every normal-rank point-good first move except moves that win-rate mode explicitly marks Mistake or Blunder, plus the KataGo best first move. AI Sensei represents alternatives as separate numbered solution lines, so the script writes each accepted first move under its own numeric `:solutions` key and does not synthesize continuations. If exact Good Move synchronization cannot be read, an existing memo is left unchanged and marked `RETRY_SOLUTION_SYNC`; a new problem may be created with the best move only so the position is not silently lost.

For a lost game, the planner always tries to produce a teaching problem. If the Quiz has zero problems even at the strongest student level, it falls back to the player's worst own move by positive win-rate loss, then point loss. If the played move itself is considered Good at the player's normal rank, it is removed from the teaching solutions when a better Good alternative exists.

Review the CSV before doing anything else. The important actions are:

- `KEEP`: already the desired canonical problem;
- `CREATE`: create the selected canonical problem;
- `UPDATE`: keep the same memo/position and replace only its accepted first-move solution set;
- `DELETE`: remove a superseded/opponent/no-longer-selected problem;
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

`--allow-create` is required only when the reviewed plan contains `CREATE` rows. Execution writes a memo backup, creates replacements and applies same-position solution updates with Firestore preconditions, verifies all creates/updates, and only then performs guarded deletes. Same-position `UPDATE` preserves the memo ID and training fields. If the plan changes, the old hash is rejected.

For a small first pass, add `--max-games 20 --verbose` to the dry run.

## Import your OGS games

### Guided all-games workflow

For normal use, run:

```bash
npm run upload-games
```

Enter one or more OGS usernames when prompted (comma-separated). The command discovers all completed, non-annulled games across those accounts, de-duplicates shared games, performs the compatibility self-test, writes the upload plan, and asks for confirmation. Only after you type `YES` does it rerun the plan and upload games if the hash is unchanged. Existing/checkpointed games and exact local duplicates are skipped rather than reuploaded.

You can also provide account names directly while still using the guided confirmation flow:

```bash
npm run upload-games -- --ogs-account YOUR_OGS_NAME --ogs-account ANOTHER_OGS_NAME
```

The lower-level commands below expose the same planner/executor as separate steps.

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

The importer checkpoints completed work in `ogs-import-state.json`, so interrupted runs can resume. Across all supplied OGS accounts, the merged import plan is globally oldest-to-newest by game end time, then game ID; `--max-ogs-games` is applied after that sort. It fingerprints board records before opening the upload UI, skips boards where either dimension is below 7, and never automates AI Sensei's "Reupload game" choice.

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

The rank/Quiz rules are implemented in `src/cleanup/policy.mjs`, while browser reconciliation is in `src/ai-sensei.mjs`. If you fork the project to use different study criteria, change the policy, run `npm test && npm run check`, generate a fresh dry-run plan, and inspect the resulting `CREATE`/`UPDATE`/`DELETE` rows. Never reuse a plan hash from an older policy or analysis state.

An existing saved problem receives special stability treatment: if its move is still among the three largest distinct point-loss mistakes (the same-move-avoidance set), that position is preserved even if current normal-rank thresholds would otherwise choose a different member of the top three. When only its accepted solutions change, the memo is updated in place so training history remains intact.

## Releases and automated testing

Every push to `master` or `main`, and every pull request, runs the test suite and syntax check in GitHub Actions on Node.js 20 and 22.

Version tags such as `v0.2.0` run the same checks and publish a GitHub Release with generated release notes plus a downloadable `auto-ai-sensei-*.tgz` package. Human-readable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## Generated and sensitive files

Plans, checkpoints, backups, diagnostics, browser profiles, and HAR files are ignored by Git. Treat them as private: they can contain game metadata or authenticated session material.

Do not commit cookies, Firebase tokens, browser user-data directories, OAuth secrets, passwords, or raw `Authorization` headers.

## Design notes

The invariants behind move indexing, player identity, replacement ordering, duplicate detection, and write safety are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

ISC.
