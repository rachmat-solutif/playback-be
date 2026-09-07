# Playback BE

Backend API for **Playback** -- database of customer service conversations (search, filtering, playback audio).

> Split from the `playback` monolith. Frontend lives in `playback-fe` and runs as a separate service/repo. This repo is API-only: no Vite, React, or Tailwind.

## Tech Stack

- **Fastify 4** + TypeScript (strict) -- API server
- **MongoDB 7** -- Docker locally, Atlas M0 for staging/prod
- **Azure Blob Storage** -- private audio blobs with SAS URLs
- **Microsoft Entra ID** -- SSO via `@azure/msal-node` + `@fastify/secure-session`
- **Pino** -- structured JSON logging with PII redaction and per-request `transactionId`
- **Pulumi (GCP)** -- infra in `infra-gcloud/` (e2-micro VM + Caddy + systemd)

## Project Structure

```
playback-be/
+-- src/server/               # Fastify app (TypeScript)
|   +-- app.ts                # Bootstrap + routes + health check
|   +-- config.ts             # Zod-validated env (dotenv)
|   +-- auth/                 # Entra + bypass + session + guard
|   +-- db/                   # Mongo connection, collections, indexes
|   +-- routes/               # conversations, analytics, audio, import, agents
|   +-- storage/              # Azure Blob helpers + audio policy
|   +-- plugins/              # logger
|   +-- lib/                  # transaction-id
|   `-- __tests__/            # vitest suite (65 tests)
+-- scripts/                  # seed, export/import snapshot, indexes, clear
+-- infra-gcloud/             # Pulumi GCP (VM, VPC, Caddy, systemd)
+-- examples/import/          # Sample import payloads + shell scripts
+-- docs/                     # Backend docs (schema, backup, runbooks, HLD)
+-- docker-compose.dev.yml    # Mongo 7 for local dev
+-- Dockerfile                # Production image (API only, no frontend build)
+-- vitest.server.config.ts   # Test runner
`-- tsconfig.json
```

Frontend assets (`index.html`, `vite.config.js`, `tailwind.config.js`, `src/components`, `src/routes`, `src/hooks`, etc.) are intentionally **not** in this repo.

## Prerequisites

- Node.js `>=22` (see `.nvmrc` -- `24.19.0`)
- Docker (for MongoDB)
- MongoDB Atlas connection string for staging/prod, or local Mongo via compose
- Azure Storage account + container for audio (or local `public/audio` fallback)
- Entra ID app registration for `staging`/`production`

## Quick Start

```bash
# 1. Prepare MongoDB
#    Local MongoDB (Docker) -- required if MONGO_URI points to localhost:
sudo docker compose -f docker-compose.dev.yml up -d
#    Atlas / staging / cloud MongoDB -- skip this step and set MONGO_URI to
#    your remote connection string instead.

# 2. Install
npm install

# 3. Configure env -- copy example and edit
cp .env.development.example .env.development
# Edit .env.development. Minimal local setup:
#   MONGO_URI=mongodb://localhost:27017/childapp  # or Atlas URI if you skipped step 1
#   AUTH_BYPASS=true            # offline dev, no Entra needed (dev/test only)
#   # Audio works without Azure -- uses public/audio/sample-call.wav fallback
#
# For full local parity with staging/prod, also configure:
#   # Auth -- Microsoft Entra ID SSO
#   AUTH_PROVIDER=entra
#   ENTRA_CLIENT_ID=...
#   ENTRA_TENANT_ID=...
#   ENTRA_CLIENT_SECRET=...
#   ENTRA_REDIRECT_URI=http://localhost:3000/auth/callback
#   ENTRA_LOGOUT_URI=http://localhost:3000/login
#   SESSION_KEY=...             # openssl rand -hex 32
#   SESSION_PASSWORD=...        # openssl rand -base64 32
#   # Audio -- Azure Blob Storage (private container, SAS URLs)
#   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
#   AZURE_STORAGE_ACCOUNT_NAME=...
#   AZURE_STORAGE_CONTAINER=audio
#   # Optional tuning: AUDIO_SAS_EXPIRY_MINUTES, AUDIO_SAS_CLOCK_SKEW_MINUTES,
#   # REMOTE_AUDIO_TIMEOUT_SECONDS, REMOTE_AUDIO_MAX_REDIRECTS, APP_ORIGINS
# See docs/LOCAL-AZURE-AUDIO-CHECKLIST.md for container/CORS setup and
# docs/DEVOPS-AZURE-AUDIO.md for Entra app registration.

# 4. Seed database (1 dummy conversation via phone +62, guarded)
#    Requires MongoDB from step 1 (or remote URI). Guard password: SAYASADAR.
#    With Azure Blob configured, seed uploads public/audio/sample-call.wav as
#    <conversation_id>.wav to the private container; without it, seed keeps
#    local file reference. Legacy 160-row seed is available as `npm run db:seed:dummy`.
SEED_GUARD=SAYASADAR npm run db:seed
# Dummy login (AUTH_PROVIDER=dummy): POST /auth/login {username:"user", password:"123456"}

# 5. Run API with hot reload
npm run dev
# -> http://localhost:3000
#    GET /health
#    GET /api/conversations
#    GET /api/audio/:conversationId  # local file or Azure SAS URL depending on env

# 6. Run tests (requires MongoDB)
npm run test:server
```

Production build:

```bash
npm run build        # tsc -> src/dist-server
npm run prod         # node src/dist-server/app.js
# or
npm start            # node --import tsx src/server/app.ts
```

Docker:

```bash
docker build -t playback-be .
docker run -p 3000:3000 --env-file .env.development playback-be
```

## Environment

Copy `.env.development.example` to `.env.development` (also `.env.staging`, `.env.production` per `NODE_ENV`). Validated by `src/server/config.ts` (Zod).

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `NODE_ENV` | -- | `development` | `development` / `staging` / `production` / `test` |
| `PORT` | -- | `3000` | Fastify listen port |
| `MONGO_URI` | yes | -- | `mongodb://localhost:27017/childapp` locally |
| `AUTH_PROVIDER` | -- | `none` | `entra` or `dummy` in staging/production (`dummy` = local user/123456, no Entra) |
| `AUTH_BYPASS` | -- | `false` | `true` allows offline dev (blocked in staging/prod) |
| `ENTRA_CLIENT_ID / TENANT_ID / CLIENT_SECRET / REDIRECT_URI` | when `AUTH_PROVIDER=entra` | -- | See `docs/DEVOPS-AZURE-AUDIO.md` |
| `ENTRA_LOGOUT_URI` | -- | -- | Post-logout redirect |
| `SESSION_KEY` | when entra or dummy | -- | `openssl rand -hex 32` (64 hex chars) |
| `SESSION_PASSWORD` | when entra or dummy | -- | `openssl rand -base64 32` |
| `AZURE_STORAGE_CONNECTION_STRING` | -- | -- | Private container; app never creates it |
| `AZURE_STORAGE_ACCOUNT_NAME` | -- | -- | Needed for SAS generation |
| `AZURE_STORAGE_CONTAINER` | -- | `audio` | Blob container name |
| `AUDIO_SAS_EXPIRY_MINUTES` | -- | `60` | 5-60 |
| `AUDIO_SAS_CLOCK_SKEW_MINUTES` | -- | `5` | 1-15, backdates SAS `st` |
| `REMOTE_AUDIO_TIMEOUT_SECONDS` | -- | `300` | 5-600 |
| `REMOTE_AUDIO_MAX_REDIRECTS` | -- | `3` | 0-5 |
| `IMPORT_API_KEY` | -- | -- | `Bearer` token for `POST /api/import` scripts |
| `LOG_LEVEL` | -- | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `SERVICE_NAME` | -- | `playback-server` | Pino base binding |

`AUTH_PROVIDER` must be `entra` or `dummy` in `staging`/`production`; `AUTH_BYPASS=true` is rejected there. See `docs/LOCAL-AZURE-AUDIO-CHECKLIST.md` for local Azure audio. Seeds are guarded: `SEED_GUARD=SAYASADAR` required for `npm run db:seed` (1-row) and `npm run db:seed:dummy` (160).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | API with `tsx watch` on port 3000 |
| `npm run build` | Compile `src/server` -> `src/dist-server` |
| `npm run prod` | Run compiled build |
| `npm test` / `npm run test:server` | Vitest suite |
| `npm run db:seed` | Drop + reseed 1 dummy via phone +62 (Agent Dummy, Customer Dummy `+628123456789`, `user/123456`) + indexes -- requires `SEED_GUARD=SAYASADAR` |
| `npm run db:seed:dummy` | Legacy 160 conversations (archived) -- requires `SEED_GUARD=SAYASADAR` |
| `npm run db:export` | Snapshot schema + indexes + data (Extended JSON) |
| `npm run db:import` | Validate/import snapshot (replace mode is destructive) |
| `npm run db:indexes` | Recreate indexes only |
| `npm run db:clear` | Delete data, preserve indexes |
| `npm run gcloud:install` | Install Pulumi deps |
| `npm run gcloud:preview` | `pulumi preview --stack staging` |
| `npm run gcloud:up` | `pulumi up --stack staging` |
| `npm run gcloud:deploy` | rsync + restart on GCP VM |
| `npm run gcloud:destroy` | Tear down GCP stack |

## API Endpoints

All `/api/*` routes require a valid session cookie (`entra` or `dummy` `POST /auth/login`) or `AUTH_BYPASS=true` in dev. Import routes also accept `Authorization: Bearer <IMPORT_API_KEY>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public) |
| GET/POST | `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me` | Entra SSO, dummy `user/123456`, or bypass |
| GET | `/api/conversations` | List with filters: `from`, `to`, `agent`, `channel`, `sentiment`, `tag`, `keyword`, `minDuration`, `page`, `limit` |
| GET | `/api/conversations/:id` | Detail with agent, customer, tags, transcript, audio, metrics |
| GET | `/api/analytics/volume` | Volume by day/hour + channel breakdown |
| GET | `/api/analytics/kpis` | KPIs with period-over-period delta |
| GET | `/api/analytics/sentiment` | Positive/neutral/negative counts |
| GET | `/api/analytics/top-agents` | Agents ranked by conversation count |
| GET | `/api/agents` | List agents |
| GET | `/api/audio/:conversationId` | SAS URL (Azure) or streamed local audio with Range support |
| POST | `/api/import` | Single conversation (JSON / multipart with file / blob / remote URL) |
| POST | `/api/import/bulk` | Bulk import up to 10k (async) |
| GET | `/api/import/jobs/:jobId` | Poll bulk import job status |

See `docs/IMPORT_API_EXAMPLES.md` for curl samples and `examples/import/` for scripts.

## Database

Collections seeded by `scripts/seed.ts` (new 1-row dummy, guarded `SEED_GUARD=SAYASADAR`):

| Collection | Count | Purpose |
|------------|-------|---------|
| `agents` | 1 | Agent Dummy |
| `customers` | 1 | Customer Dummy `+628123456789` |
| `tags` | 1 | General |
| `users` | 1 | `user` / `123456` (role `user`, `AUTH_PROVIDER=dummy`) |
| `conversations` | 1 | Via phone `call` (`+62`) |
| `transcript_segments` | 2 | Agent + customer |
| `audio_files` | 1 | Metadata + blob key or local `sample-call.wav` |
| `conversation_metrics` | 1 | Sentiment + handle time |

Legacy 160-row seed is available as `SEED_GUARD=SAYASADAR npm run db:seed:dummy` (`scripts/seed-dummy.ts`: 6 agents / 100 customers / 7 tags / 160 conversations / ~1588 segments).

Docs: `docs/DB_SCHEMA.md` and `docs/DB_BACKUP.md`.

## Testing

```bash
npm run test:server
```

65 tests: conversations list/detail, analytics, audio delivery (local + SAS + Range), rate limiting (100 req/min), auth guards, storage and transaction IDs. Requires local MongoDB.

## Serving with the Frontend Separately

The original monolith served the Vite build from `dist/` via `@fastify/static` with an SPA fallback. This BE repo keeps that behavior **only if** `dist/index.html` exists (e.g., legacy single-container deploy). When running split (FE on `playback-fe` / Vercel / separate domain and BE on `playback-be` / GCP / App Service):

- Do **not** build the frontend into the BE image -- `Dockerfile` is API-only.
- Configure the BE to allow the FE origin: set `APP_ORIGINS` and enable CORS with credentials for session cookies. The Vite dev proxy (`/api`, `/auth`, `/health` -> `localhost:3000`) is no longer used; the FE must call `VITE_API_BASE_URL` (or equivalent) pointing at the BE.
- For cross-site cookies, `SESSION` cookie must be `sameSite: none` + `secure: true` (already `secure` in staging/production). Ensure HTTPS on both sides.
- Route topology after split:
  ```
  api.playback.rachmat.pro  -> BE (Fastify, port 3000)
  playback.rachmat.pro      -> FE (Vite build / CDN)
  ```

No CORS plugin is pre-configured; add `@fastify/cors` if FE and BE are on different origins.

## Deployment

### Staging -- Vercel (free, recommended)

Free Hobby staging at `https://playback-be-staging.vercel.app` with Atlas M0 + Entra ID + Azure Blob (SAS). Vercel serverless adapter `api/index.ts` reuses the Fastify app per cold start.

```
Browser -- HTTPS --> Vercel Serverless (api/index.ts -> Fastify) -- Atlas M0 / Azure Blob (SAS)
                          +-- Entra ID (PKCE) --> session cookie
```

Full installation guide: `docs/VERCEL_STAGING_SETUP.md` (Atlas free cluster, Blob container + CORS, Entra app registration for `https://playback-be-staging.vercel.app/auth/callback`, Vercel project + env vars, seed, verification). Env template: `.env.staging.example`. Config: `vercel.json` + `api/index.ts`.

Quick connect:

- Vercel: Import `rachmat-solutif/playback-be` (branch `main`), Framework `Other`, Build `npm run build`, Node `22.x`, Domain `playback-be-staging.vercel.app`.
- Env (Production): `NODE_ENV=staging`, `MONGO_URI` (Atlas `.../childapp?...`), `AUTH_PROVIDER=dummy` (or `entra`), `ENTRA_*` only when `entra` (`REDIRECT_URI=https://playback-be-staging.vercel.app/auth/callback`), `SESSION_KEY` (`openssl rand -hex 32`), `SESSION_PASSWORD` (`openssl rand -base64 32`), `AZURE_STORAGE_*` + `AUDIO_SAS_*` + `APP_ORIGINS=https://playback-be-staging.vercel.app`. `AUTH_BYPASS` must not be set in staging. Seed: `SEED_GUARD=SAYASADAR npm run db:seed` (1-row phone) locally against Atlas.
- Deploy on push to `main`; verify `curl -fsS https://playback-be-staging.vercel.app/health` and Entra login flow.

### Staging -- GCP (archival alternative)

GCP e2-micro via Pulumi (`infra-gcloud/`), Caddy reverse proxy, systemd unit, Atlas M0 + Azure Blob Storage (kept for reference; Vercel is the current free staging).

```
Client -> Caddy (443) -> Node.js (3000) -> Atlas M0 / Azure Blob
```

```bash
cd infra-gcloud && npm install
pulumi stack init staging
# edit Pulumi.staging.yaml -> gcp:project
pulumi config set --secret mongoUri "..."
pulumi config set --secret azureStorageConnectionString "..."
pulumi config set --secret sessionKey "$(openssl rand -hex 32)"
pulumi config set --secret sessionPassword "$(openssl rand -base64 32)"
# ... see infra-gcloud/README.md
npm run gcloud:up
npm run gcloud:deploy
sudo systemctl status playback
journalctl -u playback -f
```

See `infra-gcloud/README.md` and `docs/DEVOPS-AZURE-AUDIO.md` for full runbook (Entra registration, secrets, SAS migration, monitoring). For Vercel, see `docs/VERCEL_STAGING_SETUP.md`.

## Docs

| Doc | Contents |
|-----|----------|
| `docs/VERCEL_STAGING_SETUP.md` | **Vercel free staging (Atlas + Entra + Blob) -- start here** |
| `docs/HIGH-LEVEL-DESIGN.md` | System architecture and data flow |
| `docs/DB_SCHEMA.md` | Collection shapes and indexes |
| `docs/DB_BACKUP.md` | Snapshot export/import procedures |
| `docs/DEVOPS-AZURE-AUDIO.md` | Azure Storage + Entra + deployment runbook (GCP + Vercel) |
| `docs/LOCAL-AZURE-AUDIO-CHECKLIST.md` | Local Azure audio setup |
| `docs/IMPORT_API_EXAMPLES.md` | Import API curl examples |
| `docs/LOGGING.md` | Pino logging, redaction, transactionId |
| `docs/DEBUGGING-RUNBOOK-EXAMPLES.md` | Debugging recipes |
| `docs/CHECKLIST.md` | Migration phases |
| `docs/TEST_CASES.md` | Test case catalog |

Source monolith: `~/Projects/playback` (archived). This BE repo is the canonical backend after the split.
