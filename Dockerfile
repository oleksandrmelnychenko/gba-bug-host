FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app-runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir -p data public/uploads codex-home && chown -R node:node /app
VOLUME ["/app/data", "/app/public/uploads"]

FROM app-runtime AS worker
ARG CODEX_VERSION=0.145.0
ARG DOTNET_CHANNEL=10.0
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH=$PATH:/usr/share/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates curl libicu72 \
        file unzip ffmpeg poppler-utils \
        python3 python3-openpyxl python3-xlrd \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir "${DOTNET_ROOT}" \
    && ln -sf "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet \
    && rm /tmp/dotnet-install.sh \
    && npm install --global "@openai/codex@${CODEX_VERSION}"
USER node
CMD ["npm", "run", "worker"]

FROM app-runtime AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/voice \
    && /opt/voice/bin/pip install --no-cache-dir faster-whisper==1.2.1
ARG VOICE_TRANSCRIBE_MODEL=base
ENV VOICE_TRANSCRIBE_PYTHON=/opt/voice/bin/python \
    VOICE_TRANSCRIBE_MODEL=${VOICE_TRANSCRIBE_MODEL} \
    VOICE_TRANSCRIBE_DEVICE=cpu \
    VOICE_TRANSCRIBE_COMPUTE_TYPE=int8 \
    WHISPER_CACHE_DIR=/opt/whisper-models
RUN /opt/voice/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('${VOICE_TRANSCRIBE_MODEL}', device='cpu', compute_type='int8', download_root='/opt/whisper-models')" \
    && chown -R node:node /opt/whisper-models
USER node
EXPOSE 4000
CMD ["npm", "start"]
