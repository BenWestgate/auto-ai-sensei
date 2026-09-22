# Architecture and safety invariants

Auto AI Sensei grew from a personal cleanup/import script. This document records the behavior that should remain stable while the implementation is refactored.

## Curation policy

For every eligible game, the planner keeps at most one practice problem from the user's own moves.

1. Resolve the normal student rank in this order: game-time SGF/rank metadata, current OGS rank for the exactly identified player identity when available (otherwise the configured aliases), then `10k`. AI Rank Prediction is not used for this decision.
2. Reproduce AI Sensei's current point-loss mistake classification locally from the stored KataGo `moveInfos`, using the same rank interpolation and Mistake/Blunder thresholds as the frontend.
3. If the normal rank exposes fewer than three qualifying mistakes, strengthen one Student Level at a time in the same order as the current slider (30k through 8d, then 1p through 9p). Stop at the first level with at least three distinct first-solution mistakes; if the strongest level still exposes one or two, use those. The broken +/- controls are never used.
4. Keep the top three distinct first-solution candidates by point loss. `--validate-browser` is a validation-only path that drives the real Student Level slider and Quiz UI and fails if live browser curation disagrees with the local result.
5. If an existing user-side saved problem is one of those top three positions, preserve that position ahead of automatic ranking. For a loss this preservation does not require a normal-rank bad label. For a win/draw/unknown result, preserve it only when point mode still calls it Inaccuracy/Mistake/Blunder or win-rate mode calls it Mistake/Blunder.
6. If no qualifying existing saved position is preserved, rank the remaining candidates by largest positive win-rate loss. If all win-rate losses are zero/unavailable, use point loss. Ties use larger point loss, then earlier move number.
7. A loss with zero Quiz problems at the strongest level falls back to the user's worst own move by the same impact ranking.

The local classifier is intentionally derived from the current AI Sensei frontend semantics so full-library planning does not require thousands of browser round trips. Missing or incomplete `moveInfos` fails closed for that game. Targeted `--validate-browser` runs are used as reconciliation evidence before destructive cleanup.

The accepted solution set is also rank-aware. At the normal rank, reproduce AI Sensei's current `filter-good-moves` behavior from KataGo `moveInfos`: remove pass, retain alternatives with at least 4% of non-symmetry playouts or one of the first three engine suggestions, take every point-good first move, veto only alternatives that win-rate mode explicitly marks Mistake or Blunder, and always include the KataGo best first move. AI Sensei stores each alternative solution line under its own numeric `:solutions` map key; the array under a key is that line's move sequence. The cleanup writer therefore stores each accepted first move as its own one-move line (`0:[moveA]`, `1:[moveB]`, ...), never as multiple moves inside one line. If solution enumeration is incomplete, fail closed with `RETRY_SOLUTION_SYNC` rather than silently reducing an existing solution set.

For losses, if the played move is itself in the accepted Good set, remove it when a better Good alternative exists. Try the next-ranked candidate if that leaves no teaching solution. The played move may remain only as the final fallback when it is itself the sole best/acceptable move and no alternative position works.

## Identity handling

AI Sensei generated game titles are interpreted as `White vs Black`. User aliases are never built into the repository; callers provide them with repeated `--me NAME` arguments.

The planner also recognizes AI Sensei's teaching-game human label as the user's side, and recognizes its normal-game human label only when the opponent clearly looks like an AI/bot. Ambiguous or unsupported ownership is never guessed and must end with zero saved problems.

Some imported games do not have a `:games/<id>` document even after analysis completes. For those records only, the planner may recover metadata from a completed `:game-data/<uid>/:uploads/<id>` document and reconstruct the played main line from `:game-data/<uid>/:nodes/<id>`. Recovery requires a usable square board size, both player names, a completed upload status, and a valid node-chain main line. If any of those checks fail, the game remains skipped. Unknown rank marker `?` is treated as absent rank metadata, not as part of a player's identity.

## Move indexing

This is a critical invariant:

```text
memo :move-number N = actual target move N
problem color       = color of move N
loss for move N     = analysis transition N-1 -> N
```

Do not introduce a `+1` offset when refactoring this logic.

## Replacement ordering

When the selected canonical position is unchanged but its accepted solution set changes, execution performs an in-place `UPDATE` of `:solutions` plus `:updated-at`, guarded by the memo's Firestore `updateTime`. Memo ID, due date, level, variation, upload date, and other training fields are preserved.

When the selected canonical position changes, execution creates and verifies the replacement before deleting the old memo. Deletes use Firestore `updateTime` preconditions. A raw memo backup is written before any mutation. All CREATE/UPDATE verification completes before any superseded memo is deleted.

Ownership takes precedence over `--remove-player`. The planner resolves the user's side first; an exact `--remove-player NAME` match becomes a removal target only when neither side can be identified as one of the repeated `--me NAME` aliases (or another explicitly supported user-side label). Thus a user's own game against a removal-listed opponent remains an ordinary owned game and is curated normally. AI Sensei's My Games `delete-upload` action removes the user's `:game-data/{uid}/:uploads/{gameId}` document; the same upload identity and `updateTime` participate in the reviewed plan hash. Execution verifies those preconditions, backs up the known Firestore records, removes all associated saved problems, rechecks the preconditions, then deletes the reviewed upload documents with optimistic `updateTime` preconditions and verifies that no target upload or memo remains.

Raw `games-removal-backup-*.json` snapshots can selectively restore mistakenly removed owned games with repeated `--restore-game-removal-backup PATH`, repeated `--me NAME`, and `--restore-player NAME`. Restore planning accepts only targets whose removed-player evidence matches the requested restore player and whose title identifies exactly one user-owned side. Foreign or ambiguous games remain absent. The planner requires the original upload snapshot plus unchanged game/node `updateTime` preconditions, hashes the dry-run plan, and creates only the per-user upload membership document with `exists:false`; it never rewrites the global game, node, or analysis records. Execution verifies restored upload fields and verifies that skipped foreign/ambiguous uploads remain absent.

## Memo backup restore

Raw `memos-backup-*.json` snapshots are restorable with `--restore-memos-backup PATH`. Restore is dry-run first and writes `memo-restore-plan.json`; execution requires `--execute --confirm HASH` for the freshly generated plan.

Backups are validated before planning: their memo count must match, document names must be unique and confined to the authenticated user's `:memos` collection, and any recorded Firebase UID / Firestore root must match the active account. Legacy backups without the newer metadata remain valid when their document paths prove the same user and database.

Restore reconciles raw Firestore fields exactly. Missing and changed backed-up documents are created/replaced first with optimistic Firestore preconditions. The library is then re-read, and no post-backup document is deleted unless every backed-up document is already present with the exact backed-up fields. Deletes use the freshly observed `updateTime` preconditions. A final full re-read must produce zero restore mutations and the exact backed-up memo count.

## Dry-run gates

Cleanup and OGS import are dry-run first. A plan hash is generated from the current plan and must be supplied back to the mutation command. A stale hash must fail after the plan changes.

Creating new practice problems has an additional `--allow-create` gate. OGS uploading has an additional `--allow-ogs-upload` gate.

## OGS duplicate detection

The OGS importer fingerprints the board record using board dimensions, sorted setup stones, and the full ordered main-line move sequence. Player names, comments, ranks, and results are deliberately excluded from the fingerprint.

Unique fingerprints with at least eight moves are treated as local duplicates. Short games and fingerprint collisions require stricter player/title agreement; otherwise AI Sensei's duplicate dialog remains the fallback authority. The automation never chooses "Reupload game".

Boards with either dimension below 7 are skipped before upload.

After merging games from every requested OGS account, import planning sorts globally by `ended` ascending and game ID ascending. This means old games are uploaded first. `--max-ogs-games` is applied after the oldest-first sort. Already imported AI Sensei games are not reordered; this rule only controls new import planning.

## GoQuest status

GoQuest support is intentionally read-only. It probes public profile/game data and writes audit files, but there is no GoQuest-to-AI-Sensei upload flag. Do not add an upload path until historical enumeration and payload semantics are positively validated.

## Sensitive data

Never commit browser profiles, cookies, bearer/refresh tokens, authenticated HAR files, raw authorization headers, or generated backups/audit files containing private account data. The repository `.gitignore` covers the standard outputs, but new diagnostics must be reviewed before commit.
