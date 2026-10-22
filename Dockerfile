# Image for ionic (electron/ionic-kit templates/Dockerfile.node, Node 24 to
# match package.json engines and .nvmrc).

FROM node:24-alpine AS build
WORKDIR /app
# git: the postinstall (scripts/ensure-build-tools.js) fetches
# electron/build-tools at package.json `buildTools.sha` into .build-tools/.
RUN apk add --no-cache git \
 && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ ./.yarn/
COPY scripts/ ./scripts/
RUN yarn install --immutable
COPY tsconfig.json ./
COPY typings/ ./typings/
COPY src/ ./src/
RUN yarn build

# The sandbox image (target `sandbox`, pushed as trop-sandbox): what a sandbox
# Job needs to apply a backport's patches - node, git, the compiled
# entrypoint and build-tools' .patches merge driver - and nothing else. No
# trop server code or dependencies, no credentials. Kept ahead of the server
# stage so a plain `docker build` still builds the server.
FROM node:24-alpine AS sandbox
WORKDIR /app
# git: applies the patches. tini: see the server stage's ENTRYPOINT.
RUN apk add --no-cache git tini
COPY --from=build /app/.build-tools ./.build-tools
# The entrypoint only imports Node built-ins (src/sandbox/entrypoint.ts).
COPY --from=build /app/lib/sandbox/entrypoint.js ./sandbox/entrypoint.js
USER 1000:1000
# The Job mounts emptyDirs at /work and /tmp; the root filesystem is
# read-only.
ENV NODE_ENV=production \
    HOME=/tmp \
    TROP_BUILD_TOOLS_DIR=/app/.build-tools \
    TROP_SANDBOX_WORKDIR=/work
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/sandbox/entrypoint.js"]

# The server image (the default target).
FROM node:24-alpine
WORKDIR /app
# Keep corepack's yarn download in the image so `yarn probot run` doesn't
# fetch it again into $HOME on every pod start.
ENV COREPACK_HOME=/opt/corepack
# git: trop shells out to git for every backport. tini: see ENTRYPOINT.
RUN apk add --no-cache git tini \
 && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ ./.yarn/
COPY scripts/ ./scripts/
# Reuse the build stage's vendored build-tools so the postinstall sees its
# stamp file and skips the re-fetch.
COPY --from=build /app/.build-tools ./.build-tools
# Production deps only; `focus` also works on a single-workspace repo.
RUN yarn workspaces focus --all --production \
 && yarn cache clean
COPY --from=build /app/lib ./lib
# Read from the working directory at runtime (src/operations/init-repo.ts).
COPY config.yml ./

# The cluster runs pods as uid/gid 1000 with a read-only root filesystem and a
# writable emptyDir at /tmp. HOME=/tmp keeps anything that writes to $HOME at
# runtime (git config, npm, corepack) off the read-only layers. Backport clones
# go to $TMPDIR/trop-working.
USER 1000:1000
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp
EXPOSE 8080
# No HEALTHCHECK: Kubernetes probes probot's /ping (set in the overlay).
# tini runs as PID 1 and forwards SIGTERM to yarn/probot; probot installs no
# SIGTERM handler, so without it the kernel ignores the signal and every pod
# waits out the 30s grace period before being SIGKILLed.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["yarn", "probot", "run", "./lib/index.js"]
