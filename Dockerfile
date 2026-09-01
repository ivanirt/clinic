# ─────────────────────────────────────────────────────────────────────────
# FHIR Patient Manager — Docker image
#
# Runtime: Node.js 22 (Alpine, slim).
#
# IMPORTANT: the FHIR Base URL and Bearer token are NOT baked into the
# image. Pass them at runtime so secrets never leave your machine:
#   - docker run  --env-file .env -p 3000:3000 fhir-patient-manager
#   - docker compose up --build -d      (compose reads ./env_file: .env)
# ─────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# Copy the application source (secrets live in .env on the host, not here).
COPY server.js ./
COPY public ./public

# Run as a non-root user (provided by the node image).
USER node

EXPOSE 3000

# Health check against the local config endpoint (busybox wget ships with Alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/config >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
