# ============================================================
# Stage 1: Builder
# ============================================================
# This stage installs everything we need to build the app —
# node_modules (including devDependencies like tsx and prisma CLI)
# and the generated Prisma client. We do all the "install stuff"
# work here so we can throw it away in the next stage and only
# keep what's needed to actually RUN the app. Result: smaller
# final image, faster deploys, faster cold starts on Cloud Run.
# ============================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package files first, install, THEN copy source code.
# Why this order? Docker caches each step. If your source code changes
# but package.json didn't, Docker reuses the cached node_modules
# instead of reinstalling everything — saves minutes on every rebuild.
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

# Copy the rest of the source (src, prisma schema, config files, etc.)
COPY . .

# Generate the Prisma client.
# prisma.config.ts reads DIRECT_URL from process.env directly (you already
# decoupled it from env.ts for this exact reason). But Prisma still requires
# the env var to *exist* during generation — it doesn't actually connect.
# We pass a placeholder so the build works without any real secrets baked in.
RUN DIRECT_URL="postgresql://placeholder" npx prisma generate


# ============================================================
# Stage 2: Runtime
# ============================================================
# Fresh, minimal image. We copy over only what the running app
# needs — node_modules, source, prisma schema, package.json.
# Everything else (build tools, caches, docs) gets left behind.
# ============================================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Copy production artifacts from the builder stage.
# node_modules already includes the generated Prisma client
# because `npx prisma generate` writes into node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# ----- Runtime env -----
# NODE_ENV=production tells Express and other libraries to skip
# dev-only work (verbose error pages, extra logging, etc.).
ENV NODE_ENV=production

# ----- Port -----
# Cloud Run injects a PORT env variable (usually 8080) and expects
# your app to listen on it. Your env.ts should already be reading
# process.env.PORT. EXPOSE is documentation-only — doesn't actually
# open the port — but keeps things clear.
EXPOSE 8080

# ----- Start the app -----
# Same as before: runs `tsx src/server.ts` under the hood via your
# "start" script in package.json.
CMD ["npm", "start"]