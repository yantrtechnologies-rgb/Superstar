FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.10.0
RUN install -d -o node -g node /app
WORKDIR /app
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile && pnpm db:generate && pnpm build
