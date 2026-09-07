# Implementation Checklist -- Playback Backend Migration

Complete checklist for migrating the Playback prototype from a Vite-only SPA with mock data to a Fastify backend with real database, Azure Blob Storage, Entra ID SSO, and GCP VM hosting.

Each phase produces a working app. Phases are sequential -- don't skip ahead.

---

## Phase 1: Local Environment Setup

### 1.1 Initialize Backend Project

- [x] Create `src/server/` directory (monorepo alongside existing `src/`)
- [x] Keep existing `package.json` and add backend deps
- [x] Install core dependencies:
  ```
  fastify @fastify/static @fastify/multipart @fastify/secure-session @fastify/rate-limit
  mongodb zod pino dotenv
  ```
- [x] Install dev dependencies:
  ```
  typescript tsx @types/node vitest
  ```
- [x] Create `tsconfig.json` for the backend
- [x] Create directory structure:
  ```
  src/
  +-- server/
  |   +-- app.ts           # Fastify bootstrap
  |   +-- routes/          # API routes
  |   +-- db/              # MongoDB connection + queries
  |   +-- config.ts        # Env validation with Zod
  ```
- [x] Create `src/server/app.ts` -- Fastify server with @fastify/static to serve Vite build
- [x] Create `src/server/config.ts` -- Zod-validated env config
- [x] Add npm scripts: `"dev:server"`, `"build:server"`, `"start:server"`
- [x] Verify: `npm run build && npm run start:server` -> serves the SPA at `localhost:3000`

### 1.2 Docker + Local MongoDB

- [x] Create `docker-compose.dev.yml` (MongoDB 7)
- [x] Create `.env.development` with MONGO_URI
- [x] Add `.env.development` to `.gitignore` (keep `.env.development.example` tracked)
- [x] `docker compose -f docker-compose.dev.yml up -d` -> MongoDB running
- [x] Verify: connect to `mongodb://localhost:27017`

---

## Phase 2: Database Schema & Seed

### 2.1 MongoDB Collections

- [x] Create `src/server/db/connection.ts` -- MongoClient singleton with `maxPoolSize: 10`
- [x] Create `src/server/db/collections.ts` -- typed collection accessors
- [x] Create `src/server/db/indexes.ts` -- function to ensure indexes

### 2.2 Seed Script

- [x] Create `scripts/seed.ts` with mulberry32 PRNG for deterministic data
- [x] Generate: 6 agents, 100 customers, 7 tags, 160 conversations, transcript segments, audio records, metrics
- [x] Add npm scripts:
  - `npm run db:seed` -- drop + reseed + rebuild indexes
  - `npm run db:indexes` -- drop + recreate indexes only
  - `npm run db:clear` -- delete all data, preserve indexes
- [x] Verify: 160 conversations seeded

---

## Phase 3: Backend API -- Conversations

### 3.1 API Routes

- [x] `GET /api/conversations` -- list with filters (from, to, agent, channel, sentiment, tag, keyword, minDuration, page, limit)
- [x] `GET /api/conversations/:id` -- full detail with populated relations
- [x] `GET /api/analytics/volume` -- contact volume by day/hour with channel breakdown
- [x] `GET /api/analytics/kpis` -- dashboard KPIs with period-over-period delta
- [x] `GET /api/analytics/sentiment` -- positive/neutral/negative counts
- [x] `GET /api/analytics/top-agents` -- agents ranked by volume
- [x] `GET /api/audio/:conversationId` -- stream audio file with Range request support
- [x] `GET /health` -- health check
- [x] Register all route plugins in `app.ts`
- [x] `@fastify/rate-limit`: 100 req/min global

### 3.2 Update Frontend to Use API

- [x] Create `src/lib/api.js` -- fetch wrapper
- [x] Update Dashboard, ConversationSearch, ConversationDetail to use API
- [x] Verify: full app works at `localhost:3000` with real DB data

### 3.3 Import API

- [x] `POST /api/import` -- single conversation import (JSON or multipart with audio file)
  - Customer resolved by phone number (upsert)
  - Agent resolved by email (upsert)
  - Tags auto-created by label
  - Audio: inline url or file upload
  - external_id for idempotent re-imports (latest replaces)
- [x] `POST /api/import/bulk` -- up to 10k conversations, async background processing (chunks of 500)
- [x] `GET /api/import/jobs/:jobId` -- poll bulk job progress
- [x] Multipart support via @fastify/multipart for audio file upload
- [x] Zod validation schemas for all import payloads
- [x] `docs/IMPORT.md` documentation
- [x] Example scripts in `examples/import/`

### 3.4 Search Improvements

- [x] Conversation ID search in keyword filter (hex substring match)
- [x] Short ID display in frontend (strip leading zeros, min 5 chars)

---

## Phase 4: Unit Tests for Backend API

### 4.1 Test Setup

- [x] Create `vitest.server.config.ts`
- [x] Create test helpers (connect to test DB, seed, build Fastify app)
- [x] Add `.env.test` with separate test database
- [x] Add script: `"test:server": "vitest run --config vitest.server.config.ts"`

### 4.2 Test Cases (34 passing)

- [x] GET /api/conversations -- filters, pagination, AND logic, empty results
- [x] GET /api/conversations/:id -- populated relations, 404, 400
- [x] GET /api/analytics/volume -- daily, hourly, channel breakdown
- [x] GET /api/analytics/kpis -- values + deltas
- [x] GET /api/analytics/sentiment -- counts
- [x] GET /api/analytics/top-agents -- sorted, limit
- [x] GET /api/audio/:conversationId -- 200, 404, 400
- [x] Rate limiting -- 429
- [x] Unauthenticated API request -- 401
- [x] GET /auth/me -- unauthenticated 401 and valid-session 200
- [x] GET /auth/logout -- clears the session cookie
- [x] Import API key -- missing/invalid/valid bearer token behavior
- [x] Bulk import validation -- rejects more than 10000 conversations

---

## Phase 5: Staging on GCP VM

### Key Tech Decisions

| Choice | Why |
|--------|-----|
| Fastify over Express | Lower memory (~30 MB less), critical on 1 GB RAM VM |
| Native MongoDB driver (not Mongoose) | 3-5x less memory, no ODM overhead |
| MongoDB Atlas M0 (not CosmosDB) | Full MongoDB compatibility: text indexes with stemming/scoring, $lookup, $facet all work correctly |
| GCP e2-micro (not Azure App Service F1) | Always-on, full SSH access, no 60 CPU-min/day limit |
| Caddy (not nginx) | Automatic HTTPS via Let's Encrypt, zero config |
| Azure Blob Storage (audio) | Private container, SAS tokens for time-limited access, stream multipart (never touch disk) |
| Pulumi (not Terraform) | TypeScript (matches project), free tier for state |

### Multi-Environment Database

| Environment | Database | Provisioned by | Data |
|-------------|----------|----------------|------|
| Local dev | Docker MongoDB 7 (localhost:27017) | docker-compose.dev.yml | Seeded mock |
| Staging | MongoDB Atlas M0 (512 MB, free) | Manual (Atlas console) | Seeded/prod-like |
| Production | MongoDB Atlas M0 (or paid tier) | Manual (Atlas console) | Real data |

### Free/Low-Cost Tier Limits

| Service | Limit | Mitigation |
|---------|-------|------------|
| GCP e2-micro | 1 GB RAM, 0.25 vCPU | Fastify + native driver (low memory); sufficient for staging |
| MongoDB Atlas M0 | 512 MB, shared, 100 connections | Sufficient for staging; full text search with stemming |
| Azure Blob Storage | 5 GB LRS, 2M reads/month, 15 GB egress | Fine for ~500 short voice clips |
| Entra ID | Unlimited users/apps | Sufficient for SSO |
| **Total cost** | **~$7/month** (VM + disk) | |

### 5.1 Prerequisites

- [x] Install Pulumi CLI: `curl -fsSL https://get.pulumi.com | sh`
- [x] Install gcloud CLI: `curl -fsSL https://sdk.cloud.google.com | bash`
- [x] `gcloud auth login` (authenticates your local machine)
- [x] `pulumi login` (use Pulumi Cloud free tier or `pulumi login --local` for local state)
- [x] Generate SSH key for VM access: `ssh-keygen -t ed25519 -f ~/.ssh/gcp_key`

### 5.1.2 MongoDB Atlas (manual -- free tier not automatable)

- [x] Create Atlas account / project: `childapp-staging`
- [x] Create M0 Sandbox cluster (Azure, Southeast Asia)
- [x] Create DB user with strong password
- [x] Network Access: allow all (0.0.0.0/0) for free tier
- [x] Get connection string, set in Pulumi config (step 5.2 below)

### 5.2 GCP Resources (via Pulumi)

Infrastructure is defined in `infra-gcloud/` as TypeScript (Pulumi):
- VPC network + subnet (asia-southeast1)
- Firewall rules: HTTP/HTTPS/SSH/port 3000
- Static external IP
- e2-micro VM (Ubuntu 24.04 LTS)
- Startup script: Node.js 20, Caddy, systemd service, deploy user

- [x] Install infra dependencies: `npm run gcloud:install`
- [x] Initialize stack: `cd infra-gcloud && pulumi stack init staging`
- [x] Set required Pulumi config:
  ```bash
  cd infra-gcloud
  pulumi config set gcp:project YOUR_GCP_PROJECT_ID
  pulumi config set appName playback-staging
  pulumi config set sshPublicKey "$(cat ~/.ssh/gcp_key.pub)"
  pulumi config set --secret mongoUri "mongodb+srv://..."
  
  az storage account show-connection-string \
    --name  childappstagingstor\
    --resource-group rg-childapp-staging \
    --output tsv
  pulumi config set --secret azureStorageConnectionString "DefaultEndpointsProtocol=..."
  ```
- [x] Preview changes: `npm run gcloud:preview`
- [x] Deploy: `npm run gcloud:up`
- [x] Verify: `pulumi stack output externalIp` returns a static IP

### 5.3 Domain Setup

- [x] Get static IP from Pulumi output:
  ```bash
  cd infra-gcloud
  pulumi stack output externalIp --stack staging
  ```
- [x] Provide IP to DNS admin -- they create an A record:
  ```
  playback.rachmat.pro  ->  A  ->  <EXTERNAL_IP>
  ```
- [x] Once DNS propagates, SSH in and configure Caddy for the domain:
  ```bash
  ssh -i ~/.ssh/gcp_key deploy@<EXTERNAL_IP>
  sudo tee /etc/caddy/Caddyfile <<EOF
  playback.rachmat.pro {
    reverse_proxy localhost:3000
  }
  EOF
  sudo systemctl restart caddy
  ```
- [x] Verify: Caddy obtains Let's Encrypt certificate automatically

### 5.4 Deploy Application

- [x] Seed staging database: `NODE_ENV=staging MONGO_URI=<staging-uri> npm run db:seed`
- [x] Deploy app code to GCP VM:
  ```bash
  npm run gcloud:deploy
  ```
  This builds frontend, rsyncs to VM, installs deps, restarts service.
- [ ] Verify: `https://playback.rachmat.pro` loads (or `http://<IP>` before DNS)

### 5.5 CI/CD (GitHub Actions)

- [ ] Add GitHub secrets:
  - `GCP_SSH_PRIVATE_KEY` (content of `~/.ssh/gcp_key`)
  - `GCP_VM_IP` (static IP from Pulumi output)
  - `GCP_DEPLOY_USER` (`deploy`)
- [ ] Create `.github/workflows/deploy-staging.yml`:
  - On push to main: run tests -> build -> rsync to VM -> restart service
- [ ] Push to main -> verify: tests pass -> deploys
- [ ] Verify: staging app serves correctly after deploy

### 5.6 Service Management (on the VM)

```bash
ssh -i ~/.ssh/gcp_key deploy@<IP>
sudo systemctl status playback    # Check status
sudo systemctl restart playback   # Restart
journalctl -u playback -f         # Tail logs
journalctl -u caddy -f            # Caddy logs
```

### 5.7 Tear Down (if needed)

- [ ] `npm run gcloud:destroy` -- removes VM, network, firewall, static IP
- [ ] Atlas M0 cluster: delete manually in Atlas console

---

## Phase 6: Azure Blob Storage (Audio)

### 6.1 Azure Setup

- [x] Create Storage Account
- [x] Create private container: `audio`
- [x] Get connection string
- [x] Upload sample audio for testing

### 6.2 Backend Integration

- [x] Install: `npm install @azure/storage-blob`
- [x] Create `src/server/storage/blob.ts`:
  - `uploadAudio(stream, filename, contentType)` -> blob name
  - `generateSasUrl(blobName, expiresMinutes)` -> time-limited URL
- [x] Update `GET /api/audio/:conversationId` -- return SAS URL (fallback to local streaming for dev)
- [x] Update `POST /api/import` -- upload audio to Blob Storage when configured

### 6.3 Update Frontend

- [x] Update `ConversationDetail.jsx` -- fetch SAS URL asynchronously
- [x] `AudioPlayer` receives resolved URL (SAS or local endpoint)

### 6.4 Tests

- [x] All 34 existing tests pass (blob storage only active when AZURE_STORAGE_CONNECTION_STRING set)

### 6.5 Deploy to Staging

- [x] `AZURE_STORAGE_CONNECTION_STRING` set via Pulumi config
- [x] Deploy + verify audio playback via SAS URL

---

## Phase 7: Real Entra ID SSO (Local Dev)

Multi-site SSO context: Playback is one of several sister websites sharing a
single Entra ID tenant. Sign out at any site = sign out everywhere. Production
Entra ID is managed by client devops. Staging uses your own Azure account with
dummy users.

### 7.1 Entra ID Setup (staging)

- [x] Azure Portal -> Microsoft Entra ID -> App Registrations
- [x] Either reuse existing app registration or create new one:
  - Name: `childapp-web`
  - Account types: Single tenant
  - Redirect URIs:
    - `http://localhost:3000/auth/callback` (local dev)
    - `https://playback.rachmat.pro/auth/callback` (staging -- add now for Phase 8)
- [x] Create client secret (24 month expiry)
- [x] Enable front-channel logout:
  - Set front-channel logout URL: `https://playback.rachmat.pro/auth/logout/callback` (staging/prod)
  - For local dev: use Hookdeck CLI to receive front-channel logout via HTTPS tunnel:
    ```bash
    hookdeck login
    hookdeck listen 3000 entra-logout --path /auth/logout/callback
    ```
    Then update source to allow GET: `hookdeck gateway source upsert entra-logout --type WEBHOOK --allowed-http-methods "GET,POST,PUT,PATCH,DELETE"`
    Use the generated `https://hkdk.events/...` URL as front-channel logout URL in Entra ID during local testing
- [x] Create 2-3 dummy users in your staging tenant for testing
- [x] Note: client ID, tenant ID, client secret
### 7.2 Auth Infrastructure

- [x] Create `src/server/auth/session.ts`:
  - Register `@fastify/secure-session`
  - Session stores: `userId`, `email`, `name`, `roles`, `expiresAt`
- [x] Create `src/server/auth/guard.ts` -- Fastify preHandler:
  - Checks valid session exists and not expired
  - Returns 401 JSON for unauthenticated API requests
  - Skips: `/auth/*`, `/health`, static files
- [x] Apply guard to all `/api/*` routes

### 7.3 Implement Entra ID Auth Provider

- [x] Install: `npm install @azure/msal-node`
- [x] Create `src/server/auth/entra.ts`:
  - `GET /auth/login` -- generate auth code URL, redirect to Microsoft
  - `GET /auth/callback` -- exchange code for token, extract user info, create session, redirect to `/`
  - `GET /auth/logout` -- destroy local session, redirect to Entra ID logout endpoint (signs out of all sister sites)
  - `GET /auth/logout/callback` -- front-channel logout handler (Microsoft calls this when another sister site triggers logout)
  - `GET /auth/me` -- return current user info from session

- [x] Enable when `AUTH_PROVIDER=entra`
- [x] Add env vars to `.env.development`:
  ```
  AUTH_PROVIDER=entra
  ENTRA_CLIENT_ID=<from-portal>
  ENTRA_TENANT_ID=<from-portal>
  ENTRA_CLIENT_SECRET=<from-portal>
  ENTRA_REDIRECT_URI=http://localhost:3000/auth/callback
  ENTRA_LOGOUT_URI=http://localhost:3000/auth/logout/callback
  SESSION_KEY=<openssl rand -hex 32>
  SESSION_PASSWORD=<openssl rand -base64 32>
  ```

### 7.4 Shared Logout (sign out of all sister sites)

- [x] On logout: redirect to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout?post_logout_redirect_uri=...`
  - This destroys the Microsoft session, triggering front-channel logout on all sister sites
- [x] Front-channel logout endpoint (`/auth/logout/callback`):
  - Receives notification from Microsoft when another site triggers logout
  - Destroys local session
- [x] Register front-channel logout URL in app registration:
  - Staging/prod: `https://playback.rachmat.pro/auth/logout/callback`
  - Local dev: Hookdeck URL (`https://hkdk.events/...`) -- run `hookdeck listen 3000 entra-logout --path /auth/logout/callback`

### 7.5 Update Frontend for Session-Based Auth

- [x] Remove current in-memory dummy auth from `src/context/AuthContext.jsx`
- [x] Replace with:
  - On mount: `GET /auth/me` -- if 200, user is logged in; if 401, redirect to `/auth/login`
  - Login page: redirects to `/auth/login` (which redirects to Microsoft)
  - Logout: navigate to `/auth/logout`
- [x] Update `ProtectedRoute` to use new auth state

### 7.6 Test Locally

- [x] `npm run dev:server` -> open `http://localhost:3000`
- [x] Redirected to Microsoft login
- [x] Login with Entra ID test user -> session created -> dashboard
- [x] Refresh -> still logged in (session persists)
- [x] Logout -> Microsoft session destroyed -> back to login
- [x] API request without session -> 401

### 7.7 Auth Unit Tests

- [x] Unauthenticated `/api/conversations` -> 401
- [x] `GET /auth/me` without session -> 401
- [x] `GET /auth/me` with valid session -> 200 + user info
- [x] `GET /auth/logout` -> clears session

---

## Phase 8: Deploy Entra ID SSO to Staging

### 8.1 Configure Staging Environment

- [x] Add Entra ID env vars to VM (`/opt/playback/.env`) via Pulumi config:
  ```
  AUTH_PROVIDER=entra
  ENTRA_CLIENT_ID=<from-portal>
  ENTRA_TENANT_ID=<from-portal>
  ENTRA_CLIENT_SECRET=<from-portal>
  ENTRA_REDIRECT_URI=https://playback.rachmat.pro/auth/callback
  ENTRA_LOGOUT_URI=https://playback.rachmat.pro/auth/logout/callback
  SESSION_KEY=<same key as local>
  SESSION_PASSWORD=<same password as local>
  ```
- [x] Store Entra ID values and session credentials as Pulumi secrets for the `staging` stack
- [x] Add `IMPORT_API_KEY` as a Pulumi secret for non-browser bulk imports
- [x] Update the VM startup script to write Entra ID, session, and import credentials to `/opt/playback/.env`
- [x] Replace the VM to apply the updated startup script; static IP remained `34.34.223.20`

### 8.2 Deploy and Verify

- [x] Deploy: `npm run gcloud:deploy`
- [x] Verify: `https://playback.rachmat.pro/health` returns HTTP 200
- [x] Verify: `/auth/me` returns HTTP 401 without a session
- [x] Verify: `/auth/login` redirects to Microsoft with the staging callback URI
- [x] Verify: `/api/import/bulk` rejects requests without `IMPORT_API_KEY` with HTTP 401
- [x] Verify: `/api/import/bulk` accepts the configured import key and reaches payload validation
- [x] Update bulk importer to send the bearer key and split files into requests of at most 10,000 items
- [x] Test: full login flow on staging (https://playback.rachmat.pro)
- [x] Test: silent auth (already logged in at Microsoft = no prompt)
- [x] Test: logout from Playback -> check session destroyed
- [x] Test: front-channel logout (simulate another site triggering logout)

### 8.3 Production Handoff

- [ ] Provide client devops with:
  - Playback redirect URI: `https://<production-domain>/auth/callback`
  - Front-channel logout URL: `https://<production-domain>/auth/logout/callback`
  - Required scopes: `openid profile email`
- [ ] Client devops adds these to their existing app registration
- [ ] Client devops provides: client ID, tenant ID, client secret for production
- [ ] Set production env vars with their credentials

---

## Phase 9: Monitoring

- [ ] Set up structured logging (pino already in use)
- [ ] Configure log rotation on VM (journald handles this)
- [ ] Set up uptime monitoring (external ping to /health)
- [ ] Optional: Application Insights or GCP Cloud Monitoring
- [ ] Set up alert: service down or >50 errors in 5 min

---

## Phase 10: Production Deployment

- [ ] Create production Atlas cluster (or upgrade M0)
- [ ] Create production GCP VM (upgrade to e2-small for 2 GB RAM) or promote staging
- [ ] Set up custom domain + HTTPS (Caddy handles automatically)
- [ ] Entra ID production setup:
  - Client devops adds Playback redirect URI + front-channel logout URL to their app registration
  - Receive client ID, tenant ID, client secret from client devops
  - Set `AUTH_PROVIDER=entra` + Entra env vars for production
- [ ] Set all production env vars
- [ ] Seed production database
- [ ] Upload production audio to Blob Storage
- [ ] Create production deploy workflow
- [ ] Smoke test: login -> SSO across sister sites -> conversations -> audio -> dashboard -> logout (all sites)
- [ ] Decommission old VPS `playback.service`

---

## Summary: What Each Phase Delivers

| Phase | Status | Result |
|-------|--------|--------|
| 1 | Done | Fastify serves existing SPA, Docker MongoDB running |
| 2 | Done | Database seeded with 160 conversations + transcripts + audio |
| 3 | Done | API routes working, frontend uses real DB, import API ready |
| 4 | Done | 34 backend unit tests pass |
| 5 | Done | Staging live on GCP VM (playback.rachmat.pro), HTTPS via Caddy |
| 6 | Done | Audio in Azure Blob Storage, SAS URL playback working |
| 7 | Done | Real Entra ID SSO working on localhost |
| 8 | Done | Entra ID SSO deployed to staging; endpoint and import authentication verified, full browser/logout tests pending |
| 9 | -- | Monitoring and alerting active |
| 10 | -- | Production live |

---

*Created: July 2026 | Reference: `../infra-gcloud/README.md`, `DB_SCHEMA.md`, `IMPORT.md`*
