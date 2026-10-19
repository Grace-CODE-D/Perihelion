# Multi-stage build for the Perihelion relayer, solver and mempool containers.
# Usage:
#   docker build --build-arg PACKAGE=relayer -t perihelion-relayer .
#   docker build --build-arg PACKAGE=solver  -t perihelion-solver .
#   docker build --build-arg PACKAGE=mempool -t perihelion-mempool .

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base

WORKDIR /app

# Root and workspace manifests only, so the dependency layers are cached
# independently of source changes.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY relayer/package.json relayer/
COPY solver/package.json solver/
COPY mempool/package.json mempool/
COPY test/package.json test/

# ─── Build stage: full dependency tree, compile every workspace ─────────────
FROM base AS build

ARG PACKAGE=relayer

RUN npm ci

# Copy only what the target image needs. Other workspaces are not compiled,
# so a broken package cannot block this image and unrelated edits do not
# invalidate the cache. The sdk is a shared dependency of every service.
COPY tsconfig.base.json ./
COPY sdk ./sdk
COPY ${PACKAGE} ./${PACKAGE}
RUN npm run build -w @perihelion/sdk -w @perihelion/${PACKAGE}

# ─── Production dependencies only (no typescript, tsx, c8, @types/*) ────────
FROM base AS prod-deps

RUN npm ci --omit=dev && npm cache clean --force

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime

ARG PACKAGE=relayer
RUN case "$PACKAGE" in relayer|solver|mempool) ;; \
      *) echo "PACKAGE must be one of relayer, solver, mempool (got '$PACKAGE')" >&2; exit 1 ;; \
    esac

# Build args are not visible at runtime; promote it so CMD and HEALTHCHECK
# can select the right entrypoint and port.
ENV PACKAGE=${PACKAGE} \
    NODE_ENV=production

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/sdk/package.json ./sdk/
COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/${PACKAGE}/package.json ./${PACKAGE}/
COPY --from=build /app/${PACKAGE}/dist ./${PACKAGE}/dist
COPY docker/healthcheck.cjs /usr/local/lib/perihelion/healthcheck.cjs

# Writable state directory for the relayer checkpoint and dead-letter files.
# /app is root-owned, so state must live here; compose mounts a volume over it.
RUN mkdir -p /var/lib/perihelion && chown node:node /var/lib/perihelion

# Run as the non-root `node` user (uid 1000) the base image already ships.
# Creating another account named `node` collides with it and fails the build.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/usr/local/lib/perihelion/healthcheck.cjs"]

# Shell form is required for $PACKAGE to expand; exec keeps node as PID 1 so
# it receives SIGTERM directly. Each package's bin/start entry is dist/cli.js.
CMD ["sh", "-c", "exec node \"/app/$PACKAGE/dist/cli.js\""]
