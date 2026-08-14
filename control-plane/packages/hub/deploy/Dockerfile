# NOT BUILT OR PUSHED. Deploys run in CI on this project, never from a
# workstation.
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# The hub needs the workspace root manifest to resolve `@ompd/tunnel`, and the
# tunnel package itself. Nothing else in the monorepo is copied: the relay must
# not carry the daemon, the supervisor, or anything that can execute an agent.
COPY package.json bun.lock ./
COPY control-plane/packages/tunnel ./control-plane/packages/tunnel
COPY control-plane/packages/hub ./control-plane/packages/hub

RUN bun install --frozen-lockfile --production

# Cloud Run supplies PORT.
ENV NODE_ENV=production
EXPOSE 8080

USER bun
CMD ["bun", "control-plane/packages/hub/src/main.ts"]
