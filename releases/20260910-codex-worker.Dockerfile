# Surgical worker-only update, retaining the deployed toolchain and app build.
# The normal Dockerfile pins the same CLI for subsequent full rebuilds.
# Local rollback tag must resolve to image ID
# sha256:1fff27b55e12801a4b22fc273998843cddca54782cb7395206f7119d15495c5b.
FROM gba-bug-host-worker:pre-codex-0.154.0-20260910
USER root
RUN npm install --global @openai/codex@0.154.0 && codex --version
COPY --chown=node:node server/codex-worker.js /app/server/codex-worker.js
USER node
