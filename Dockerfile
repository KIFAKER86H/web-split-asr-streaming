# Simple production image for the split-display app.
#
# `.env` is deliberately never copied in — every setting this app reads
# (ASSEMBLYAI_*, TEXT_*, CAPTION_*) is read at request time (see
# `src/lib/server/config.ts`), not baked in at build time, so the same image
# works for any deployment: pass real values with `docker run -e` / `--env-file`
# or the `environment:`/`env_file:` keys in docker-compose.yml. Nothing here
# needs rebuilding when `.env` changes — only the running container needs a
# restart.
#
# This runs the same `next start` as `npm start` does outside Docker — see
# the note in `next.config.ts` on why `output: "standalone"` (a smaller image,
# but a different start command) isn't used here.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies too — the build below needs TypeScript and Tailwind, both
# devDependencies. They're pruned back out after the build, before this
# node_modules is copied into the runtime image.
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Binds inside the container to all interfaces, not just localhost — without
# this the port mapping below has nothing to reach.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN groupadd --system nodejs && useradd --system --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs
EXPOSE 3000
CMD ["npm", "start"]
