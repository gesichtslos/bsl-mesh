FROM node:24.22.0-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY docs/08-CLIENT-SECURITY-MANIFEST.md ./docs/08-CLIENT-SECURITY-MANIFEST.md
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN pnpm build && chmod 755 /app/docker/entrypoint.sh && chown -R node:node /app

USER node

EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
