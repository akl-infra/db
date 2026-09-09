# db/drill/Dockerfile -- the Fly restore drill (design/layout-db/
# 12-implementation-phase5.md §3 X4 "the drill on Fly", LDB-D5). One image,
# single stage: the drill's job IS to run `wrangler` (`d1 migrations
# apply`/`d1 execute`/`dev`, all --local) and `db/scripts/*.mjs`, so --
# unlike `bot/Dockerfile`'s build/runtime split, whose bundled `dist/`
# needs nothing at runtime -- this image needs the full `db/` tree
# (src/, formats/, migrations/, scripts/, wrangler.toml) plus every
# devDependency (wrangler itself) at runtime, not just production deps.
#
# Build context is `db/` (NOT the repo root): the drill only ever touches
# `db/`'s own code and formats (`db/formats` builds via `npm run
# build:formats`, no reach into `web/` or `bot/` the way `bot/Dockerfile`
# needs to for its inlined imports) -- see db/README.md § Drill for the
# exact `docker build`/`flyctl deploy` invocations (run from `db/`).
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json wrangler.toml ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
COPY drill ./drill
COPY formats ./formats
RUN npm run build:formats

# `wrangler d1`/`dev --local` write their sqlite state under
# `.wrangler/state` relative to cwd (db/scripts/*.mjs and drill/run.sh
# both cd there) -- ephemeral, container-local, never a volume: every
# drill run starts from a fresh migrated database on purpose (drill-
# restore.mjs's own header).
ENV NODE_ENV=production
ENTRYPOINT ["sh", "drill/run.sh"]
