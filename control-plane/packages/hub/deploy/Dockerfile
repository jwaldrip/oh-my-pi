# Deploys run in CI on this project, never from a workstation.
FROM oven/bun:1.3.14-alpine

WORKDIR /app

# bun's workspace resolution reads every package.json the root manifest's
# `workspaces` globs match (packages/*, python/robomp/web,
# control-plane/packages/*) to build the dependency graph, even with
# `--frozen-lockfile` and even though only two of those packages are ever
# executed here. A partial copy (just tunnel + hub) fails install outright:
# "Workspace not found". So the full source tree is present in this image's
# build layer -- the boundary this Dockerfile actually holds is that no
# daemon/agent CODE ever RUNS here, not that the source is physically
# absent. CMD below is the only thing that ever executes.
COPY . .

RUN bun install --frozen-lockfile --production

# Cloud Run supplies PORT.
ENV NODE_ENV=production
EXPOSE 8080

USER bun
CMD ["bun", "control-plane/packages/hub/src/main.ts"]
