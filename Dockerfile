# Playback Backend -- API only (no frontend build)
FROM node:22-alpine AS production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy backend source
COPY src/server ./src/server
COPY tsconfig.json ./

# Copy audio samples for local fallback (production uses Azure Blob Storage)
COPY public/audio ./public/audio

# Install tsx for TypeScript execution
RUN npm install tsx

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "--import", "tsx", "src/server/app.ts"]
