# Pastebin as one container: build the SPA (and the downloadable CLI binaries)
# with the full workspace, then run the server with production deps only.

# ---- Stage 1: build ----------------------------------------------------------
FROM oven/bun:1 AS builder
WORKDIR /app

# Manifests before source, so editing a .ts doesn't invalidate the install layer.
COPY package.json bun.lock ./
COPY apps/server/package.json       apps/server/
COPY apps/client/package.json       apps/client/
COPY apps/cli/package.json          apps/cli/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile

COPY . .

# -> apps/client/dist, which is exactly where the server looks for it.
RUN bun run build

# The /cli/<file> downloads. Cross-compiling the five targets makes Bun fetch
# each foreign runtime once, so this step needs working outbound internet and
# adds ~400 MB to the image (five self-contained Bun binaries, 60-99 MB each).
# BUILD_CLI=0 skips it: the server hides
# the download section when apps/cli/dist is empty, rather than 404ing.
ARG BUILD_CLI=1
RUN if [ "$BUILD_CLI" = "1" ]; then bun run build:cli; else mkdir -p apps/cli/dist; fi

# ---- Stage 2: runtime --------------------------------------------------------
FROM oven/bun:1
WORKDIR /app

# The same manifests, installed in place at /app. Bun 1.3 uses the isolated
# linker for workspaces: packages land in node_modules/.bun and are symlinked
# into each workspace by ABSOLUTE path, so the install has to happen at the
# path the app will actually run from. --production drops vite/svelte/tsc.
COPY package.json bun.lock ./
COPY apps/server/package.json       apps/server/
COPY apps/client/package.json       apps/client/
COPY apps/cli/package.json          apps/cli/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile --production

# The server imports @pastebin/protocol straight from TypeScript source
# (its package.json exports ./src/index.ts), so the source ships as-is.
COPY apps/server/src       apps/server/src
COPY packages/protocol/src packages/protocol/src
COPY --from=builder /app/apps/client/dist apps/client/dist
COPY --from=builder /app/apps/cli/dist    apps/cli/dist

ENV NODE_ENV=production
ENV PORT=3000
# On the volume, not in the image: SQLite holds the rooms *and* every uploaded
# image, so this one file is the entire persistent state.
ENV DB_PATH=/data/pastebin.sqlite
VOLUME /data
EXPOSE 3000

# app.ts resolves the client and CLI dirs relative to its own source file, so
# the process has to start from apps/server for ../../client/dist to land right.
WORKDIR /app/apps/server
CMD ["bun", "src/index.ts"]
