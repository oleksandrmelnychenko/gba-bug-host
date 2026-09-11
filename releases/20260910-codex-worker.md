# Desk Codex worker repair — 2026-09-10

## Cause

The latest failed runs of BUG-1251 and BUG-1252 received HTTP 400:
the configured `gpt-6-astra` model required a newer Codex CLI. The deployed
worker still used 0.150.1. This was an agent execution failure, not proof that
the Desk website was unavailable.

The error summary also incorrectly preferred stderr's `Reading prompt from
stdin...` over the structured API error on stdout.

## Changes

- Pin Codex CLI 0.154.0 in the normal worker Dockerfile.
- Prefer terminal structured errors, unwrap embedded API error messages, and
  omit the stdin notice from diagnostic fallbacks. Preserve timeout handling
  and full execution logs.
- Deploy only the worker using `20260910-codex-worker.Dockerfile`, retaining
  the existing deployed application/toolchain as the base.

No task statuses, historical agent runs, business data, website containers,
model selection, credentials, or worker concurrency settings were changed.
Failed task runs were not automatically retried.

## Deployed artifact

- Tag: `gba-bug-host-worker:codex-0.154.0-20260910`
- Image ID: `sha256:8e0006c1628d743669f27a5bcdf2d63bd6da677c131ff1207fad3e51c85dbb4a`
- Default Compose tag `gba-bug-host-worker:latest` points to that same image.
- Previous image retained as `gba-bug-host-worker:pre-codex-0.154.0-20260910`:
  `sha256:1fff27b55e12801a4b22fc273998843cddca54782cb7395206f7119d15495c5b`.
- Only `gba-bug-host-worker-1` was recreated, at 20:38:56 UTC.
- Worker source SHA-256, matching repository and running container:
  `df1c5cefc5887b66f9a5d8e9abfec015a97d384a5098fd415b491c23872425b7`.

## Verification

- Full test suite: 139 passed, zero failures or skips.
- Isolated CLI and live-worker probes: GPT-6 Astra, reasoning `high`, exact
  response `DESK_CLI_OK`, exit zero, no error events or tool calls.
- Live probe used the actual worker configuration and shared Codex home.
- Worker heartbeat fresh, zero restarts after replacement.
- Public Desk `/api/health`: HTTP 200.
- All other 52 container IDs unchanged.
- `git diff --check` passed.

Evidence is in `/root/evidence/desk-cli-fix-20260910/`: `tests.log`,
`probe.json`, `live-probe.json`, `before.json`, `deploy.json`, `status.json`.

## Rollback

Run `rtk proxy node /root/evidence/desk-cli-fix-20260910/deploy.mjs rollback`.
The helper refuses rollback if tasks are running/queued or the worker image
has changed since this release. It restores only the previous worker image;
the website and data volumes are retained. Rolling back restores the old CLI
compatibility problem, so use only if a regression requires it.

CLI update guidance was checked against the
[official OpenAI documentation](https://learn.chatgpt.com/docs/codex/cli).
Compatibility was established by the actual probes, not inferred from the
version number alone.
