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
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}"
USER node
CMD ["npm", "run", "worker"]

FROM app-runtime AS runtime
USER node
EXPOSE 4000
CMD ["npm", "start"]
