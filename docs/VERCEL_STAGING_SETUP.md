# Vercel Staging Setup -- Free Hosting

Deploy `playback-be` to **Vercel (Hobby, free)** at `https://playback-be-staging.vercel.app` with **MongoDB Atlas (M0 free)**, **Microsoft Entra ID**, and **Azure Blob Storage (private container, SAS URLs)**.

> Archival alternative GCP staging remains in `infra-gcloud/` and `README.md -- Deployment`. This guide is the recommended free staging path when GCP billing is not available.

```
Browser -- HTTPS --> Vercel Serverless (Fastify via api/index.ts) -- Atlas M0 / Azure Blob
                          |
                          +-- Entra ID (PKCE) --> session cookie (secure, httpOnly)
                          +-- SAS URL (60 min, read-only, HTTPS) --> Browser --> Blob
```

Vercel Hobby limits (2026): 100 GB bandwidth/month, 100 GB-hours serverless execution, 10 s function timeout (Hobby), 6000 execution hours. Atlas M0: 512 MB storage, shared RAM, max 500 connections. Audio is not proxied through Vercel -- the API returns a SAS URL and the browser fetches directly from Azure, so Vercel bandwidth is API JSON only.

## Prerequisites

- GitHub repo `rachmat-solutif/playback-be` on branch `main` (push via `git@github-solutif:rachmat-solutif/playback-be.git`)
- Vercel account (Hobby) linked to GitHub `rachmat-solutif` org/user with access to that repo
- Azure subscription with permission to create Storage account + Entra app registration (or ask admin)
- MongoDB Atlas account (free, no credit card for M0)
- Node.js >= 22 locally for verification

## 1. MongoDB Atlas -- M0 Free Cluster

Atlas M0 is free forever; no credit card required. 512 MB is enough for the seed (160 conversations, ~2000 docs).

1. Create Atlas account at https://cloud.mongodb.com -- Sign up (Google/GitHub).
2. Create project: `playback-staging` -- Project > New Project.
3. Create cluster: Build a Database > M0 Free > Provider `AWS` or `GCP` > Region closest to Vercel edge (e.g. `ap-southeast-1` Singapore or `us-east-1` if Entra tenant is US) > Cluster Name `playback-staging` > Create.
4. Create DB user: Database Access > Add New Database User > `playback-staging` + strong password (save it) > Built-in Role `Read and write to any database` > Add User.
5. Allow Vercel IPs: Network Access > Add IP Address > `Allow Access from Anywhere` `0.0.0.0/0` (Vercel uses dynamic IPs; Hobby has no static IP. This is required for serverless. Restrict later with Atlas Private Endpoint if needed).
6. Get connection string: Database > Connect > Drivers > Node.js > Copy string, e.g. `mongodb+srv://playback-staging:<password>@playback-staging.xxxxx.mongodb.net/?retryWrites=true&w=majority`. Add database name `childapp` before `?`: `...mongodb.net/childapp?retryWrites=true&w=majority`. URL-encode password if it contains `@`, `/`, `:`.
7. Test locally (optional):

```bash
MONGO_URI='mongodb+srv://...' npm run db:seed
mongosh 'mongodb+srv://...' --eval 'db.conversations.countDocuments()'
```

Keep this URI secret; it will go into Vercel env `MONGO_URI`.

## 2. Azure Blob Storage -- Private Container + CORS

Reuse the existing runbook in `DEVOPS-AZURE-AUDIO.md` and `LOCAL-AZURE-AUDIO-CHECKLIST.md`. Minimal free-tier storage: Standard LRS Hot, private container `audio`. Blob storage itself has no free tier but cost for staging seed (~160 x ~100 KB = 16 MB) is < $0.01/month; storage + egress from private SAS is pay-per-use. Local account must be separate from staging.

```bash
# Create staging account (globally unique name, e.g. playbackstgxxxxx)
az login
az account set --subscription "<subscription-id>"

az storage account create \
  --resource-group playback-staging-rg \
  --name playbackstgxxxxx \
  --location southeastasia \
  --sku Standard_LRS \
  --kind StorageV2 \
  --access-tier Hot \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

az storage container create \
  --account-name playbackstgxxxxx \
  --name audio \
  --public-access off \
  --auth-mode login

# Verify private
az storage container show --account-name playbackstgxxxxx --name audio --auth-mode login \
  --query '{name:name,publicAccess:publicAccess}' --output json
# expected: {"name":"audio","publicAccess":null}

# CORS -- exact Vercel origin, no wildcard, no trailing slash
az storage cors add \
  --account-name playbackstgxxxxx \
  --services b \
  --methods GET HEAD OPTIONS \
  --origins https://playback-be-staging.vercel.app \
  --allowed-headers Range \
  --exposed-headers Content-Length Content-Range Accept-Ranges Content-Type ETag \
  --max-age 3600 \
  --auth-mode login

az storage cors list --account-name playbackstgxxxxx --services b --auth-mode login

# Connection string (store in Vercel, never commit)
az storage account show-connection-string \
  --resource-group playback-staging-rg \
  --name playbackstgxxxxx \
  --query connectionString --output tsv
```

Notes:

- Keep `Shared Key access` Enabled until User Delegation SAS migration (see `DEVOPS-AZURE-AUDIO.md` section 10). SAS is signed with account key.
- SAS policy: Storage account > Configuration > SAS expiration policy > Upper limit `1 hour 15 minutes` (app uses 60 min + 5 min skew = 65 min).
- Container must exist before `npm run db:seed`; seed uploads `public/audio/sample-call.wav` as `<conversationId>.wav` when Blob is configured, otherwise it keeps local fallback.

## 3. Microsoft Entra ID -- App Registration for Vercel

Create a dedicated registration for staging; do not reuse local registration.

1. Azure Portal > Microsoft Entra ID > App registrations > New registration
   - Name: `playback-be-staging`
   - Supported account types: `Accounts in this organizational directory only` (single tenant) unless multi-tenant is required
   - Redirect URI: Web > `https://playback-be-staging.vercel.app/auth/callback` -- Add now.
2. After creation, note `Application (client) ID` and `Directory (tenant) ID`.
3. Certificates & secrets > New client secret > 6-12 months > Copy `Value` immediately (this is `ENTRA_CLIENT_SECRET`).
4. Authentication > Add URI > Web > `https://playback-be-staging.vercel.app/auth/callback` (already set) -- Ensure `Front-channel logout URL` is empty or set to `https://playback-be-staging.vercel.app/auth/logout/callback` if front-channel logout is used. Set Post-logout redirect via app config, not portal.
5. Authentication > Implicit grant: ensure OFF (app uses auth code + PKCE via `@azure/msal-node`).
6. API permissions: `Microsoft Graph` > `openid`, `profile`, `email` are requested via `SCOPES = ['openid','profile','email']` at runtime; no admin consent needed for these delegated permissions.

Vercel env values:

```
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_SECRET=<secret Value>
ENTRA_REDIRECT_URI=https://playback-be-staging.vercel.app/auth/callback
ENTRA_LOGOUT_URI=https://playback-be-staging.vercel.app/login
```

When FE is separate, Entra still redirects to BE `/auth/callback`; BE sets the session cookie and redirects to `/`. For cross-site FE/BE, set `APP_ORIGINS` to include FE origin and ensure `SESSION` cookie is `sameSite=none` + `secure=true` (already `secure` in staging). Current `src/server/auth/session.ts` uses `sameSite: lax` -- for cross-site you must change to `none`. For same-host staging (BE only), `lax` is correct.

Generate session secrets once per environment:

```bash
openssl rand -hex 32   # -> SESSION_KEY (64 hex chars)
openssl rand -base64 32  # -> SESSION_PASSWORD
```

Never reuse across local/staging/production.

## 4. Repo Preparation -- Vercel Adapter

Already committed in this repo:

- `vercel.json` at project root -- rewrites all routes to `api/index.ts`, build with `npm run build`.
- `api/index.ts` -- serverless adapter that reuses a single Fastify instance per cold start, delegates `req/res` via `fastify.server.emit('request', req, res)` (supports streaming, multipart, Range), and lazily connects to MongoDB (cached across invocations).
- `.env.staging.example` -- template for Vercel env.

Vercel build steps:

- Install: `npm ci`
- Build: `npm run build` -> `src/dist-server` (tsc). `api/index.ts` imports from `src/server` via `tsx` at runtime; Vercel Node runtime transpiles `api/index.ts` on deploy. No Docker involved.
- Function: `api/index.ts` becomes the serverless function. `vercel.json` `functions.includeFiles` ensures `src/dist-server/**` is bundled if `build` output is needed.

If you add a new route, no `vercel.json` change is needed -- all paths rewrite to `/api`.

Verify locally before pushing:

```bash
npm run build
# Simulate Vercel env
NODE_ENV=staging MONGO_URI='mongodb+srv://...' AUTH_PROVIDER=entra ... node --import tsx api/index.ts
# Or just run the regular server:
NODE_ENV=staging npm run dev  # requires .env.staging
curl -i http://localhost:3000/health
```

## 5. Vercel Project Setup -- Free Hobby

1. Vercel Dashboard > Add New Project > Import Git Repository > `rachmat-solutif/playback-be` > Import.
2. Configure Project:
   - Framework Preset: `Other`
   - Root Directory: `./` (default)
   - Build Command: `npm run build` (from `vercel.json`; override if Vercel detects wrong)
   - Install Command: `npm ci`
   - Node Version: `22.x` (Project Settings > General > Node.js Version)
3. Domain: Vercel auto-assigns `playback-be-staging.vercel.app` if project name is `playback-be-staging`. Otherwise Settings > Domains > Add `playback-be-staging.vercel.app` (or rename project to `playback-be-staging` so the default `*.vercel.app` matches). Verify `https://playback-be-staging.vercel.app` is the production deployment URL for the `main` branch.
4. Environment Variables: Settings > Environment Variables > Add each key from `.env.staging.example` for `Production` (and `Preview` if you want PR previews to use staging Atlas). Mark secrets as Sensitive (eye icon). Required set:

```
NODE_ENV=staging
MONGO_URI=mongodb+srv://.../childapp?retryWrites=true&w=majority
AUTH_PROVIDER=entra
ENTRA_CLIENT_ID=...
ENTRA_TENANT_ID=...
ENTRA_CLIENT_SECRET=...
ENTRA_REDIRECT_URI=https://playback-be-staging.vercel.app/auth/callback
ENTRA_LOGOUT_URI=https://playback-be-staging.vercel.app/login
SESSION_KEY=<64 hex>
SESSION_PASSWORD=<base64 32>
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
AZURE_STORAGE_ACCOUNT_NAME=playbackstgxxxxx
AZURE_STORAGE_CONTAINER=audio
AUDIO_SAS_EXPIRY_MINUTES=60
AUDIO_SAS_CLOCK_SKEW_MINUTES=5
REMOTE_AUDIO_TIMEOUT_SECONDS=300
REMOTE_AUDIO_MAX_REDIRECTS=3
APP_ORIGINS=https://playback-be-staging.vercel.app
LOG_LEVEL=info
SERVICE_NAME=playback-server
```

`AUTH_BYPASS` must NOT be set in staging (Zod `superRefine` rejects `AUTH_BYPASS=true` when `NODE_ENV=staging`). `PORT` is ignored on Vercel (platform assigns port).

5. Git integration: Settings > Git > Connected Repository -- ensure `main` is Production Branch, auto-deploy on push is enabled.
6. Deploy: Push to `main`:

```bash
git push github-solutif main
```

Vercel builds automatically. Watch Build Logs in dashboard or `vercel --prod` via CLI.

7. Vercel CLI alternative (optional):

```bash
npm i -g vercel
vercel login
vercel link --project playback-be-staging
vercel env add MONGO_URI production  # repeat for each var
vercel --prod
```

## 6. Seed Staging Data

Atlas is empty on first deploy. Seed from local machine using the Atlas URI (container must already exist):

```bash
# Use the same URI as Vercel
export MONGO_URI='mongodb+srv://playback-staging:PASSWORD@.../childapp?retryWrites=true&w=majority'
export AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=playbackstgxxxxx;...'
export AZURE_STORAGE_ACCOUNT_NAME=playbackstgxxxxx
export AZURE_STORAGE_CONTAINER=audio
export NODE_ENV=staging  # so seed uses staging config path

npm run db:seed          # drops + seeds 160 conversations + uploads sample wav to Blob as <id>.wav
npm run db:indexes       # rebuild indexes (also done by seed)
```

Alternatively run via Vercel: `vercel env pull .env.staging.local` to get remote env, then seed. Do not run seed from Vercel function itself (no shell there).

Verify:

```bash
curl -fsS https://playback-be-staging.vercel.app/health
# -> {"status":"ok","timestamp":"..."}

# Authenticated check: open in browser https://playback-be-staging.vercel.app/auth/login
# -> redirects to login.microsoftonline.com -> after login redirects to /
# -> GET https://playback-be-staging.vercel.app/auth/me should return {userId,email,name,roles}

# API (requires session cookie from login, or use IMPORT_API_KEY for import)
curl -fsS -b 'session=...' https://playback-be-staging.vercel.app/api/conversations | jq .

# Audio SAS (requires auth cookie)
curl -fsS -b 'session=...' https://playback-be-staging.vercel.app/api/audio/<conversationId> | jq .
# -> {"url":"https://playbackstgxxxxx.blob.core.windows.net/audio/...?sv=...&sig=..."}
```

If `IMPORT_API_KEY` is set in Vercel, imports can be tested without browser session:

```bash
curl -X POST https://playback-be-staging.vercel.app/api/import \
  -H "Authorization: Bearer $IMPORT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"conversation":{"customer":{"phone":1555000100,"name":"Jordan Reyes"},"agent":{"email":"maya.chen@company.com","name":"Maya Chen"},"channel":"call","started_at":"2026-09-01T09:00:00Z","ended_at":"2026-09-01T09:05:00Z"},"audio":{"blob_name":"imports/manual-test.wav","format":"wav"}}'
```

## 7. Verification Checklist

- [ ] `GET /health` returns 200 from `https://playback-be-staging.vercel.app/health`.
- [ ] Unauthenticated `GET /api/conversations` returns 401 or redirects (auth guard active).
- [ ] `GET /auth/login` redirects to `login.microsoftonline.com` with `client_id` = `ENTRA_CLIENT_ID`.
- [ ] After login, `GET /auth/me` returns user JSON (session cookie `httpOnly`, `secure`, `sameSite=lax`).
- [ ] `GET /api/conversations` with session cookie returns paginated JSON (160 seeded).
- [ ] `GET /api/audio/:id` returns `{url: "https://...blob.core.windows.net/audio/...?sv=...&sig=..."}` with `sp=r`, `spr=https`, expiry 60 min from issuance, `st` 5 min in past.
- [ ] Browser playback fetches directly from Blob (DevTools Network shows `Range` requests, 206 on seek). No SAS in app logs.
- [ ] Atlas Metrics shows connections from Vercel (Network Access 0.0.0.0/0, Connections < 500).
- [ ] Vercel Logs (Dashboard > Deployments > Logs) shows `Connected to MongoDB` once per cold start, then `incoming request` / `request completed` with `transactionId`.
- [ ] Staging SAS URLs use `playbackstgxxxxx.blob.core.windows.net`, not the local account hostname.

## 8. Troubleshooting

| Symptom | Fix |
|--------|-----|
| `Invalid environment variables: AUTH_PROVIDER must be entra in staging` | Set `AUTH_PROVIDER=entra` and remove `AUTH_BYPASS`. Redeploy. |
| `AUTH_BYPASS is not allowed in staging or production` | Unset `AUTH_BYPASS` in Vercel env. |
| `SESSION_KEY must be a 32-byte hexadecimal value` | Regenerate with `openssl rand -hex 32` (64 hex chars, no prefix). |
| `MongoDB connection failed on cold start` | Check Atlas IP whitelist `0.0.0.0/0`, user password URL-encoded, `MONGO_URI` includes `childapp` db. Test with `mongosh`. |
| `Azure Blob Storage is not configured` | Verify `AZURE_STORAGE_CONNECTION_STRING` in Vercel env (no newline), `AZURE_STORAGE_CONTAINER=audio` exists. |
| `Container not found` / seed fails | Create container with `az storage container create --name audio --public-access off --auth-mode login` before seeding. |
| `CORS error` fetching SAS URL | `az storage cors list` must show origin `https://playback-be-staging.vercel.app` with `GET HEAD OPTIONS`, `Range` allowed header, `Content-Range` exposed. |
| Entra login loops / `Invalid state parameter` | `ENTRA_REDIRECT_URI` must exactly match portal redirect URI `https://playback-be-staging.vercel.app/auth/callback` (no trailing slash). Check `SESSION_KEY`/`SESSION_PASSWORD` are set; secure session requires both. |
| Session cookie not set on Vercel | `SESSION_KEY` missing or invalid HEX; `NODE_ENV=staging` requires `secure=true` so only HTTPS works (Vercel is HTTPS -- ok). For local parity use `http://localhost:3000` with `NODE_ENV=development` where `secure=false`. |
| `413 Payload Too Large` on import | Body limit is 500 MB; multipart file too large or missing boundary. |
| Vercel function timeout (10 s Hobby limit) | Atlas cold connect + large bulk import may exceed 10 s. Keep `POST /api/import/bulk` async (job poll) and use `IMPORT_API_KEY` Bearer auth. Consider Vercel Pro for 60 s if bulk is frequent. |
| `react-scripts` / frontend build errors | This repo is BE-only; frontend lives in `playback-fe`. Do not build FE in BE Vercel project. |

Vercel logs: Dashboard > playback-be-staging > Deployments > [deployment] > Runtime Logs. Filter `StorageBlobLogs` in Azure Log Analytics for `403` or `SasExpiryStatus` per `DEVOPS-AZURE-AUDIO.md` section 8.

## 9. Cost Notes

- Vercel Hobby: free, 100 GB bandwidth, 100 GB-hours. Sufficient for staging API (SAS playback bypasses Vercel). Upgrade to Pro only if you need 60 s timeout or more bandwidth.
- Atlas M0: free, 512 MB. Seed is ~5-10 MB + indexes. Monitor Atlas Billing; M0 has no daily backup -- export via `npm run db:export` if needed.
- Azure Blob: ~$0.018/GB/month storage + $0.01/10k write + egress $0.087/GB. Staging seed < $0.05/month. Use separate staging account; delete test blobs after verification.

## 10. Local Parity With This Staging Stack

To test staging config locally without Vercel:

```bash
cp .env.staging.example .env.staging
# fill with Atlas/Entra/Blob values (same as Vercel, but keep ENTRA_REDIRECT_URI=http://localhost:3000/auth/callback locally)
NODE_ENV=staging npm run dev  # validates staging guard (AUTH_PROVIDER=entra) without deploying
```

Do not use `AUTH_BYPASS=true` when mimicking staging.

## 11. Next Steps

- Point FE `playback-fe` env `VITE_API_BASE_URL=https://playback-be-staging.vercel.app` and set its Vercel env `APP_ORIGINS` to include FE origin.
- Set up Atlas backups: Atlas > Backup > enable for M10+; for M0 run `npm run db:export` on schedule via GitHub Actions.
- Rotate `ENTRA_CLIENT_SECRET` before expiry; update Vercel env and redeploy.
- Add Vercel Deploy Hook for `main` if you need programmatic deploys: Settings > Git > Deploy Hooks.

See also: `.env.staging.example`, `vercel.json`, `api/index.ts`, `docs/DEVOPS-AZURE-AUDIO.md`, `docs/LOCAL-AZURE-AUDIO-CHECKLIST.md`, `README.md`.
