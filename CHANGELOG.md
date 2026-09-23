# Changelog

## 0.2.0 — 2026-09-23

- Add guided one-command workflows for uploading all completed OGS games and reconciling the practice-problem library after explicit plan confirmation.
- Add a compatibility self-test for Node.js, the attached browser/login, Firestore access, and the AI Sensei memo/upload schema.
- Preserve an existing saved problem whenever its move remains in the distinct top-three point-loss set, keeping its training history.
- Correct AI Sensei alternative-solution encoding so each accepted first move is stored as its own numbered solution line.
- Add GitHub Actions CI and automated tagged GitHub releases with a downloadable source package.

## 0.1.0

- Initial dry-run-first AI Sensei cleanup and OGS import tooling.
