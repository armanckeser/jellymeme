# syntax=docker/dockerfile:1

# ---- dependencies ----------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 builds a native addon; python3 and a toolchain are needed only here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# better-sqlite3 ships an arm64 prebuild linked against GLIBC 2.38, newer than
# bookworm's 2.36. It loads fine on x86 but dies here with
# "version `GLIBC_2.38' not found", which takes down every route that touches
# the database. Two traps make the obvious fixes silent no-ops:
#
#   1. binding.gyp collapses to a stamp-only target whenever a prebuild file
#      merely *exists* - it never checks that the thing can actually load - so
#      `npm rebuild --build-from-source` compiles nothing at all.
#   2. lib/binding.js prefers prebuilds/ over build/Release unconditionally,
#      so even a correctly compiled addon would still be ignored.
#
# So: force the build past trap 1, then overwrite the bad prebuild with the
# result to get past trap 2. getPrebuildPath() names the file for whatever
# platform this is, so it stays correct if the image is built for another arch.
RUN npm ci \
 && cd node_modules/better-sqlite3 \
 && npm run build-release \
 && node -e "const fs=require('fs'); const p=require('./lib/binding.js').getPrebuildPath(); if (p) fs.copyFileSync('build/Release/better_sqlite3.node', p)"

# ---- build -----------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# fonts-dejavu is required by libass to burn captions.
#
# ffmpeg is installed rather than taken from node_modules, even though
# ffmpeg-static already puts a binary there. That build is statically linked
# against glibc, and a static glibc cannot load the NSS modules getaddrinfo
# needs, so it segfaults on *every* hostname — localhost included — before
# writing a line of stderr. Reading a clip from
# http://host.docker.internal:8096/... is exactly that case, which silently took
# out previews, filmstrips and exports while indexing (Node's own resolver) kept
# working. Debian's ffmpeg is dynamically linked and carries the libass and
# libx264 this needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fonts-dejavu-core fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    JELLYMEME_DATA=/data \
    JELLYMEME_RENDERS=/data/renders \
    JELLYMEME_FFMPEG=/usr/bin/ffmpeg \
    PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/public ./public
# Read at runtime to create the database.
COPY --from=build /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
# Forked at runtime, so it is not part of the Next build graph and has to be
# copied by hand. Without it, embedding fails in the image but not in dev.
COPY --from=build /app/scripts/embed-worker.mjs ./scripts/embed-worker.mjs

RUN mkdir -p /data/renders && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/connection').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
