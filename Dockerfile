# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# argon2 ships a prebuilt binary for musl, but node-gyp fallback needs these if
# a prebuild is unavailable for the platform. Removed again in the final stage.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Reinstall without dev dependencies so only runtime packages ship.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init gives us correct PID 1 signal forwarding, so SIGTERM from Docker
# actually reaches Node and the graceful shutdown handler runs.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migrations are read at runtime, not compiled, so they must be copied verbatim.
COPY migrations ./migrations

# Run unprivileged. `node` (uid 1000) already exists in the base image.
# The uploads volume is chowned so the container can write to it.
RUN mkdir -p /var/lib/edutou/uploads && chown -R node:node /var/lib/edutou
USER node

EXPOSE 4000

# Compose/Dokploy also define a healthcheck; this one covers a bare `docker run`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
