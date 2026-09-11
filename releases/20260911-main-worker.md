# Desk worker main policy — 2026-09-11

- Console and server task worktrees resolve the local `refs/heads/main`
  commit, independently of the shared checkout's current branch.
- New task branches and resumed task baselines use the same resolved commit.
- Missing main fails closed, before creating a task worktree.
- The release worker uses main for both repositories. Other project stacks
  keep their existing policy. Task fixes still use isolated `codex/qa-*`
  branches before a checked merge; they do not edit main directly.
- Existing WIP, task commits, and historical failed runs are preserved.

Verification: 142 tests passed, zero failed/skipped; includes both repositories
checked out on development, first and repeated task preparation, and missing
main rejection. Existing WIP/rebase/preservation tests also pass.

Worker-only deployment recipe: `20260911-main-worker.Dockerfile`, based on the
previously verified CLI 0.154.0 image. No database migration or data backup.
Deployment evidence and source-hash checks are recorded separately under
`/root/evidence/desk-main-worker-20260911/`.
