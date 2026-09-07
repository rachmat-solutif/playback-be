# Playback High-Level Design

## 1. Document status

- Status: Current implementation design
- Scope: Playback web application and its local, staging, and production runtime
- Primary runtime: React frontend, Fastify API, MongoDB, Azure Blob Storage, and GCP VM hosting
- Authentication: Microsoft Entra ID in protected environments
- Last reviewed: July 2026

This document describes the architecture that is implemented or explicitly
planned in the repository. It is a high-level design, not a replacement for
API, database, deployment, or security runbooks.

## 2. Purpose and goals

Playback is an internal application for searching, filtering, analyzing, and
playing back historical customer service conversations.

The design goals are:

- Provide a responsive browser experience for conversation search and analytics.
- Keep conversation metadata and searchable transcript data in MongoDB.
- Keep audio bytes outside the application server when Azure Blob Storage is
  configured.
- Protect audio with authenticated access and short-lived read-only SAS URLs.
- Support local development with either real Azure Blob Storage or a local
  filesystem fallback.
- Keep deployment inexpensive and operationally simple for staging.
- Make import operations explicit, bounded, and observable.

## 3. Scope and non-goals

### In scope

- Browser frontend and client-side routing.
- Fastify API and route protection.
- Entra ID login and encrypted HTTP-only sessions.
- Conversation, transcript, analytics, and audio metadata storage.
- Private Azure Blob Storage audio delivery.
- Local filesystem audio fallback when Azure is not configured.
- Single and bulk conversation imports.
- GCP VM deployment with Caddy and systemd.
- MongoDB local development and Atlas staging/production.

### Out of scope

- Multi-tenant isolation.
- Fine-grained application roles and permissions beyond the current auth model.
- A durable external job queue for bulk imports.
- Full-text search infrastructure outside MongoDB.
- Audio transcoding, speech-to-text, or automated sentiment analysis.
- Automatic Azure container provisioning.
- Automatic database backup orchestration in the application.

## 4. System context

```text
+------------------+        +---------------------+
| Browser           |        | Microsoft Entra ID  |
| React application |<------>| Login and logout    |
+--------+---------+        +---------------------+
         |
         | HTTPS application requests and API calls
         v
+--------+------------------------------------------------+
| Caddy reverse proxy                                      |
| Production/staging TLS termination and forwarding       |
+--------+------------------------------------------------+
         |
         | localhost:3000
         v
+--------+------------------------------------------------+
| Playback Fastify API                                     |
| Auth guard, routes, validation, sessions, SAS issuance   |
+------+--------------------------+----------------------+
       |                          |
       | MongoDB driver            | Azure Blob SDK
       v                          v
+------+------------------+   +---+------------------------+
| MongoDB Atlas M0        |   | Private Azure Blob Storage |
| Conversations and       |   | Audio block blobs         |
| related metadata        |   | Short-lived SAS delivery |
+-------------------------+   +----------------------------+
```

In local development, Caddy is normally not required. Vite serves the frontend
in development, and the Fastify server runs separately on port 3000. The local
application can use a real Azure StorageV2 account or use `public/audio/` when
`AZURE_STORAGE_CONNECTION_STRING` is absent.

## 5. Main components

### 5.1 Browser frontend

Location: `src/`, built with Vite and React 18.

Responsibilities:

- Render login, dashboard, conversation search, and conversation detail pages.
- Keep authentication state in React Context.
- Keep date ranges and search filters in URL query parameters.
- Call the Fastify API through `src/lib/api.js`.
- Render transcript segments and connect timestamps to audio seeking.
- Request a playback URL from the API without handling Azure account secrets.
- Use the returned SAS URL only for direct browser audio playback.

The frontend does not connect directly to MongoDB, Entra management APIs, or
Azure using account credentials.

### 5.2 Fastify API

Location: `src/server/`.

Responsibilities:

- Validate environment variables at startup with Zod.
- Register rate limiting, sessions, authentication, API routes, and static
  frontend serving.
- Enforce authentication on API paths in protected environments.
- Query and aggregate MongoDB data.
- Validate import payloads and audio sources.
- Upload audio to Azure or the local filesystem, depending on configuration.
- Issue short-lived, read-only, HTTPS-only SAS URLs.
- Return health status and structured error responses.

Primary route groups:

- `conversations.ts`: conversation list and conversation detail.
- `analytics.ts`: volume, KPI, sentiment, and top-agent data.
- `audio.ts`: authenticated audio lookup and playback URL generation.
- `import.ts`: single imports, bulk imports, and job polling.
- `auth/entra.ts`: Entra login, callback, logout, and session handling.
- `auth/guard.ts`: API protection and import credential handling.

### 5.3 MongoDB

MongoDB stores searchable metadata and relationships. The application uses a
MongoClient singleton and typed collection accessors.

Runtime collections:

- `agents`
- `customers`
- `tags`
- `conversations`
- `transcript_segments`
- `audio_files`
- `conversation_metrics`

MongoDB stores audio metadata and blob references, not Azure audio bytes. The
`audio_files.blob_name` field identifies an Azure blob when Azure is enabled.
The `audio_files.url` field remains the local path or compatibility reference.

### 5.4 Azure Blob Storage

Azure is the audio byte store when
`AZURE_STORAGE_CONNECTION_STRING` is configured.

The application uses:

- Azure StorageV2 account.
- Blob service and private container, normally named `audio`.
- Block blobs for uploaded audio.
- Generated names such as `imports/<opaque-id>.<format>`.
- Read-only blob-scoped Service SAS URLs.
- HTTPS-only SAS URLs.

The application does not use Azure Data Lake Storage, Azure Files, Tables, or
Queues for audio delivery. The container is created and configured manually.

### 5.5 Local filesystem fallback

When Azure is not configured:

- Multipart audio is written to `public/audio/`.
- The API streams local files and supports HTTP Range requests.
- Browser playback remains available for local development.

This fallback is not used as evidence that Azure configuration works and is not
the intended staging or production storage path.

### 5.6 GCP infrastructure

Location: `infra-gcloud/`.

Pulumi provisions a low-cost GCP Compute Engine VM with:

- Ubuntu 24.04 LTS.
- A VPC, subnet, static IP, and firewall rules.
- Caddy as the HTTPS reverse proxy.
- systemd as the Node.js process manager.
- Node.js serving the built frontend and Fastify API.

The GCP VM hosts the application process. Azure stores audio, and MongoDB
Atlas stores application data. The VM does not proxy Azure audio bytes during
normal playback.

## 6. Deployment topology

### Staging and production

```text
DNS A record
    |
    v
GCP static IP
    |
    v
Caddy :443 and :80
    |
    v
Fastify and static frontend :3000
    |                         \
    |                          \-- Direct SAS URL returned to browser
    v                                |
MongoDB Atlas M0                  Azure Blob Storage
(metadata)                        (private audio blobs)
```

Caddy terminates public HTTPS and forwards requests to Fastify on localhost.
Fastify returns SAS metadata to the browser. The browser then connects directly
to the Azure Blob endpoint for audio bytes. This avoids routing large audio
responses through the GCP VM.

### Local development

```text
Vite :5173 or built frontend :3000
                |
                v
Fastify :3000 ---- MongoDB localhost
       |
       +---- Azure Blob Storage when configured
       |
       +---- public/audio/ fallback when Azure is absent
```

For local Azure-backed development, use a separate private StorageV2 account
and container. Do not reuse staging or production connection strings.

## 7. Core data flows

### 7.1 Authentication flow

```text
1. Browser requests a protected page or API route.
2. Fastify checks the encrypted session cookie.
3. If unauthenticated, the browser is sent to the Entra login flow or receives
   an API 401 response.
4. Entra redirects to /auth/callback after successful login.
5. Fastify validates the callback and stores the minimum session identity data.
6. Subsequent requests use the HTTP-only session cookie.
```

The session cookie is not exposed to frontend JavaScript. Authentication
configuration is environment-specific. Staging and production require
`AUTH_PROVIDER=entra`. The development bypass is restricted to local/test use.

### 7.2 Conversation search flow

```text
Browser -> GET /api/conversations with URL filters
       -> auth guard and rate limit
       -> Fastify validates query parameters
       -> MongoDB conversations and related collections
       -> Fastify joins or aggregates related data
       -> JSON list with pagination and filter metadata
       -> Browser updates the search page
```

Search filters use AND semantics. Date range is the primary scope and is
represented in the browser URL so filtered views can be shared and bookmarked.

### 7.3 Dashboard analytics flow

```text
Browser -> analytics endpoint with date range and granularity
       -> Fastify validates the request
       -> MongoDB aggregation over conversations and metrics
       -> JSON chart/KPI response
       -> Browser renders dashboard panels
```

The dashboard currently calculates volume by day or hour, KPIs, sentiment
counts, and top agents from MongoDB data.

### 7.4 Audio playback flow

```text
1. Browser requests GET /api/audio/:conversationId.
2. Fastify authenticates the request and loads the audio_files record.
3. If Azure is configured, Fastify resolves blob_name and signs a read-only
   HTTPS Service SAS URL.
4. Fastify returns { url } without audio bytes.
5. Browser requests the Azure URL directly and streams the private blob.
6. If Azure is not configured, Fastify streams public/audio locally and handles
   HTTP Range requests.
```

SAS URLs are short-lived bearer credentials. They are not stored as permanent
metadata and must not be logged.

### 7.5 Single import flow

Supported sources:

- Multipart file: validate MIME and size, then upload to Azure or local disk.
- `blob_name`: validate and verify an existing Azure blob without copying it.
- `remote_url`: validate HTTPS and network safety, download with bounds, and
  upload the result to Azure.
- Local `url`: supported for the filesystem fallback when Azure is absent.

```text
Import request
    |
    v
Authentication and rate limit
    |
    v
Zod payload validation
    |
    +--> Existing blob: validate name -> blob existence check
    |
    +--> Multipart: MIME check -> bounded stream -> upload
    |
    +--> Remote URL: HTTPS/DNS/IP/redirect checks -> bounded download -> upload
    |
    v
Persist conversation, transcript, metrics, and audio metadata in MongoDB
    |
    v
Return conversation ID
```

Failed newly uploaded blobs are eligible for cleanup. The import path enforces
the 500 MB audio limit and supported audio formats.

### 7.6 Bulk import flow

```text
1. Client submits up to 10,000 JSON conversations.
2. Fastify validates the envelope and returns a job ID.
3. The process handles items in chunks of 500.
4. Each item is imported independently.
5. Job progress and item errors are held in application memory.
6. The client polls GET /api/import/jobs/:jobId.
```

Bulk job state is not durable. A process restart loses in-flight job state.
Bulk processing is suitable for the current scale but should move to a durable
queue and worker model for larger or mission-critical imports.

## 8. Data model and ownership

```text
agents 1 ---- many conversations many ---- 1 customers
                    |
                    +---- many transcript_segments
                    +---- one audio_files record
                    +---- one conversation_metrics record
                    +---- many tags through tag_ids
```

Ownership boundaries:

- MongoDB owns conversation metadata, transcript text, metrics, tags, and blob
  references.
- Azure Blob Storage owns audio bytes and blob HTTP metadata.
- Entra owns user identity and authentication decisions.
- The browser owns temporary UI state, filters, and playback state.
- The GCP VM owns process execution, reverse proxying, and local logs.

The conceptual schema in `docs/DB_SCHEMA.md` predates some implementation
changes. The current MongoDB collection shapes and the TypeScript accessors are
the runtime source of truth.

## 9. Security design

### Identity and access

- Entra ID is the authentication authority for staging and production.
- Sessions use encrypted HTTP-only cookies.
- API routes are protected by the Fastify auth guard.
- Import endpoints may require the dedicated import bearer credential.
- The import credential is not accepted as a general application session.
- Rate limiting is applied globally at 100 requests per minute per IP.

### Audio protection

- Azure containers are private.
- Blob SAS URLs are short-lived, read-only, HTTPS-only, and scoped to one blob.
- Account keys and connection strings remain server-side.
- The browser never receives Azure account credentials.
- Azure CORS is configured for exact application origins and is not treated as
  authorization.

### Remote import protection

Remote audio downloads are server-side network requests and are treated as an
SSRF boundary. The downloader:

- Accepts HTTPS URLs only.
- Rejects URL credentials and fragments.
- Resolves hostnames before connecting.
- Rejects loopback, private, link-local, metadata, multicast, and reserved
  network addresses.
- Validates every redirect target manually.
- Enforces response status, audio MIME, timeout, and maximum size checks.
- Does not log complete remote URLs or secrets.

### Input and filesystem protection

- Zod validates API payloads and import fields.
- Blob names reject query strings, control characters, path traversal, and
  invalid path segments.
- Local audio paths are resolved beneath `public/` before streaming.
- Audio MIME types and file sizes are restricted.
- Environment validation rejects unsafe protected-environment auth settings.

### Secret management

Secrets are supplied through local environment files, Pulumi secrets, or an
approved deployment secret store. Secrets must not appear in source control,
logs, SAS response bodies beyond the intended URL, or documentation.

## 10. Reliability and operational boundaries

### Health and failure behavior

- `/health` reports application process health and a timestamp.
- MongoDB connection failure prevents normal startup from accepting requests.
- Azure upload failures return controlled import errors and do not create a
  successful audio reference.
- Missing existing Azure blobs are rejected during import.
- SAS issuance failures return an audio storage unavailable response.
- Local filesystem failures return missing or unavailable audio responses.
- A remote download timeout or policy violation fails only the affected import.

### Scaling boundaries

Current design assumptions:

- One Fastify process per VM.
- MongoDB Atlas M0 for staging/prototype scale.
- In-memory bulk job state.
- No distributed cache.
- No durable queue.
- Audio bytes served directly by Azure in Azure mode.

Likely scaling changes:

- Move bulk jobs to a durable queue and worker process.
- Add durable job status storage.
- Review MongoDB indexes and query plans as data grows.
- Add application replicas behind a load balancer.
- Replace account-key Service SAS with User Delegation SAS.
- Add lifecycle policies for old audio blobs.
- Add backup and restore automation for MongoDB metadata.

### Data retention and privacy

Conversation transcripts and customer metadata may contain sensitive business
or personal data. Retention, deletion, export, and access policies must be
approved by the data owner. The application currently does not implement a
complete retention or archival policy.

Azure blob soft delete, versioning, diagnostics, and MongoDB backups should be
configured according to the environment's approved recovery and compliance
requirements.

## 11. Configuration boundaries

| Concern | Local | Staging | Production |
|---------|-------|---------|------------|
| `NODE_ENV` | `development` | `staging` | `production` |
| Auth | Entra or controlled development bypass | Entra required | Entra required |
| MongoDB | Local Docker MongoDB | MongoDB Atlas | MongoDB Atlas |
| Audio | Azure Blob or local fallback | Private Azure Blob | Private Azure Blob |
| Reverse proxy | Optional | Caddy | Caddy |
| Process manager | Shell or watch process | systemd | systemd |
| Deployment | Local commands | Pulumi and deploy script | Pulumi and approved deployment process |
| SAS signer | Service SAS | Service SAS until migration | Service SAS until migration |
| Container creation | Manual | Manual | Manual |

Detailed settings are documented in:

- `docs/LOCAL-AZURE-AUDIO-CHECKLIST.md`
- `docs/DEVOPS-AZURE-AUDIO.md`
- `infra-gcloud/README.md`

## 12. Observability and operations

Application logs should contain safe event metadata such as event type,
environment, conversation ID, blob name, user ID, and request ID. They must not
contain SAS query strings, storage keys, connection strings, session secrets, or
Entra client secrets.

Operational checks include:

- Fastify `/health` response.
- MongoDB connectivity and query latency.
- Azure Blob upload failures and 403 responses.
- SAS issuance failures and expiry policy violations.
- Caddy certificate and reverse proxy health.
- systemd service status and restart frequency.
- Disk usage on the GCP VM for builds and logs.
- Bulk import job error counts.
- Unexpected remote import rejection rates.

Azure Blob diagnostics and Log Analytics are configured per the DevOps runbook.

## 13. Deployment and change management

The expected staging deployment path is:

```text
1. Run backend and frontend validation locally.
2. Review configuration and Pulumi changes.
3. Run pulumi preview for the target stack.
4. Apply approved infrastructure changes.
5. Build the frontend and backend.
6. Rsync the application to the GCP VM.
7. Restart the systemd service.
8. Verify health, authentication, imports, and playback.
9. Review logs and Azure/MongoDB metrics.
```

Infrastructure changes are managed in `infra-gcloud/`. Application changes are
built from the repository. Secrets are supplied separately through Pulumi
secret configuration or the deployment environment.

## 14. Testing strategy

Backend tests cover:

- Conversation queries, filters, pagination, and detail responses.
- Analytics aggregation behavior.
- Local audio streaming and HTTP Range responses.
- SAS URL shape and permissions.
- Azure import source resolution.
- Blob-name validation and stream-size limits.
- SSRF and remote-download restrictions.
- Authentication, import credentials, rate limiting, and configuration.

Required validation before deployment:

```bash
npm run build:server
npm run test:server
npm run build
```

The local Azure checklist provides the additional end-to-end checks for manual
container setup, multipart upload, existing blobs, remote imports, CORS, SAS
playback, and cleanup.

## 15. Architecture decisions and tradeoffs

### Direct Azure playback

Decision: return a SAS URL instead of proxying audio through Fastify.

Benefit: lower VM bandwidth and memory usage, and Azure handles byte serving.
Tradeoff: browser CORS and SAS lifecycle must be configured correctly.

### Service SAS for the current implementation

Decision: sign SAS URLs with the account key through the Azure SDK.

Benefit: simple deployment across a GCP VM and local development. Tradeoff:
account-key protection and rotation are critical. The documented migration path
moves to User Delegation SAS before disabling Shared Key access.

### Manual container provisioning

Decision: the application never creates or changes containers.

Benefit: least privilege and predictable environment setup. Tradeoff: initial
Azure setup requires an operator or infrastructure workflow.

### In-memory bulk jobs

Decision: keep current bulk jobs in the Fastify process.

Benefit: no queue dependency for the current prototype. Tradeoff: jobs are lost
on restart and do not scale across multiple processes.

### GCP application host with Azure audio

Decision: host the application on a low-cost GCP VM while retaining Azure Blob
Storage for audio.

Benefit: low-cost always-on hosting and direct access to the selected Azure
storage service. Tradeoff: cross-cloud networking, credentials, monitoring,
and operational ownership are split across providers.

## 16. Future evolution

Potential next architectural steps:

1. Migrate Service SAS signing and storage operations to User Delegation SAS.
2. Add a durable import queue and worker service.
3. Add import idempotency and database transaction boundaries for partial-failure
   recovery.
4. Add lifecycle management and retention policies for Azure blobs.
5. Add MongoDB backup, restore, and disaster recovery procedures.
6. Add structured tracing across browser request, Fastify request, MongoDB, and
   Azure operations.
7. Add explicit application roles and audit events for sensitive playback.
8. Add a dedicated object-storage abstraction if another storage provider is
   required.

## 17. Related documentation

- `../README.md` - project overview, API routes, and deployment summary
- `DB_SCHEMA.md` - conceptual data model and relationships
- `IMPORT.md` - import API contract and audio source formats
- `LOCAL-AZURE-AUDIO-CHECKLIST.md` - local Azure setup and verification
- `DEVOPS-AZURE-AUDIO.md` - Azure, Entra, CORS, SAS, monitoring, and migration
- `../infra-gcloud/README.md` - GCP VM infrastructure and deployment
- `CHECKLIST.md` - project migration checklist
