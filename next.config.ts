import type { NextConfig } from "next";

/**
 * The SharedWorker hub (`public/workers/caption-hub.js`) is served as a plain
 * static file rather than bundled — see that file's header comment for why.
 *
 * No `output: "standalone"` here on purpose, even though `Dockerfile` would
 * benefit from the smaller image it produces: standalone mode replaces
 * `next start` with `node .next/standalone/server.js`, which would silently
 * break the plain `npm run build && npm start` flow this README documents
 * for anyone running the app outside Docker. `Dockerfile` instead copies the
 * full production `node_modules` (pruned of dev-only packages) — a bigger
 * image, but the same `next start` everywhere.
 *
 * `images.unoptimized` skips the built-in image resizing pipeline, which
 * otherwise needs the native `sharp` package at runtime — a common source of
 * broken builds on Alpine-based Docker images (musl vs. glibc binaries). The
 * only images this app ever serves are the bundled logo and whatever the
 * operator drops in `public/`, already sized for how they're used, so there
 * is nothing worth resizing on the fly.
 */
const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
