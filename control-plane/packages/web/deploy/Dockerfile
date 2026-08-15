# Web console + Universal Link association files for app.ompctl.ai.
# Deploys run in CI only, never from a workstation.
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY control-plane/packages/core ./control-plane/packages/core
COPY control-plane/packages/web ./control-plane/packages/web
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
