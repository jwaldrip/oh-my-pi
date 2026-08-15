# Web console + Universal Link association files for app.ompctl.ai.
# Deploys run in CI only, never from a workstation.
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
# See hub/deploy/Dockerfile for why the full repo is copied: bun's workspace
# resolution needs every package.json the root manifest's `workspaces` globs
# match, not just this package's own.
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /app/control-plane/packages/web
RUN bun run build

FROM oven/bun:1.3.14-alpine
WORKDIR /srv
COPY --from=build /app/control-plane/packages/web/dist ./dist
COPY control-plane/packages/web/deploy/server.ts ./server.ts
ENV NODE_ENV=production
EXPOSE 8080
USER bun
CMD ["bun", "server.ts"]
