# Architecture and safety invariants

Auto AI Sensei grew from a personal cleanup/import script. This document records the behavior that should remain stable while the implementation is refactored.

## Curation policy

For every eligible game, the planner keeps at most one practice problem from the user's own moves.

1. Rank mistakes by point loss.
2. De-duplicate candidates by the first move of the AI solution.
3. Keep the top three distinct candidates.
4. A candidate qualifies at `>= 1.0` point loss **or** `>= 2` percentage points of win-rate loss.
5. Among qualifying top-three candidates, prefer larger win-rate loss, then larger point loss, then earlier move number.

If no candidate qualifies, the desired state is zero saved problems for that game.

## Identity handling

AI Sensei generated game titles are interpreted as `White vs Black`. User aliases are never built into the repository; callers provide them with repeated `--me NAME` arguments.

The planner also recognizes AI Sensei's teaching-game human label as the user's side, and recognizes its normal-game human label only when the opponent clearly looks like an AI/bot. Ambiguous identity is skipped rather than guessed.

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

When the selected canonical problem differs from what is saved, execution creates and verifies the replacement before deleting the old memo. Deletes use Firestore `updateTime` preconditions. A raw memo backup is written before mutation.

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

## GoQuest status

GoQuest support is intentionally read-only. It probes public profile/game data and writes audit files, but there is no GoQuest-to-AI-Sensei upload flag. Do not add an upload path until historical enumeration and payload semantics are positively validated.

## Sensitive data

Never commit browser profiles, cookies, bearer/refresh tokens, authenticated HAR files, raw authorization headers, or generated backups/audit files containing private account data. The repository `.gitignore` covers the standard outputs, but new diagnostics must be reviewed before commit.
