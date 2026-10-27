FROM node:24.22.0-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

COPY package.json pnpm-lock.yaml ./
COPY scripts/install-git-hooks.mjs scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY releases/cursor-adapter ./releases/cursor-adapter
COPY scripts/pack-tool-release.mjs scripts/pack-tool-release.mjs
COPY scripts/verify-tool-release.mjs scripts/verify-tool-release.mjs
COPY docs/08-CLIENT-SECURITY-MANIFEST.md ./docs/08-CLIENT-SECURITY-MANIFEST.md
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/production-migrate.sh /app/docker/production-migrate.sh
RUN pnpm build && node scripts/pack-tool-release.mjs && chmod 755 /app/docker/entrypoint.sh /app/docker/production-migrate.sh && chown -R node:node /app

USER node

EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
