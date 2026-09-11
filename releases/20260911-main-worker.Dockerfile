# Preserve the already verified CLI/toolchain; replace only worker policy code.
FROM gba-bug-host-worker:codex-0.154.0-20260910
COPY --chown=node:node server/codex-worker.js server/release-worker.js /app/server/
