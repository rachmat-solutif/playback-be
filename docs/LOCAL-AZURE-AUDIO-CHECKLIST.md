# Local Azure Audio Checklist

Use this checklist to run Playback locally with audio stored in a real private
Azure Blob Storage container.

The application does not create, configure, or change Azure containers. The
container must be created manually before the application starts. Never commit
connection strings, account keys, SAS URLs, Entra secrets, or import API keys.

## 1. Azure prerequisites

### Recommended local Storage account settings

Use these settings for a disposable or developer-owned local account:

| Setting | Recommendation | Reason |
|---------|----------------|--------|
| Account kind | `StorageV2` / General-purpose v2 | The application uses Azure Blob Storage, not Data Lake, Files, Tables, or Queues. |
| Performance | Standard | Sufficient for local audio uploads and playback at lower cost. |
| Redundancy | LRS | Appropriate for local test data; do not use this recommendation for production data. |
| Access tier | Hot | Audio is likely to be read soon after import and during testing. |
| Hierarchical namespace | Disabled | The application uses Blob containers and block blobs, not ADLS Gen2 paths. |
| Public blob access | Disabled | The container must remain private. |
| Secure transfer | Enabled | Require HTTPS for storage requests and SAS URLs. |
| Minimum TLS | TLS 1.2 | Avoid older TLS versions. |
| Shared Key access | Enabled | The current application signs Service SAS URLs with the account key. |
| Public network access | Enabled, with a developer IP allowlist when practical | A local machine needs to reach the Azure endpoint; authentication still protects data. |
| Private endpoint | Not recommended for the current local setup | A local machine and browser are not in an Azure VNet; a private endpoint would require private routing and DNS. |
| Blob versioning | Disabled | Avoid unnecessary local test-data retention and cost. |
| Blob soft delete | Disabled, or the shortest retention required by policy | Local data is disposable; enable a short period if recovery is useful. |
| Container | Private `audio` container | Anonymous access must never be used for playback. |
| CORS | Exact `http://localhost:3000` origin | Required for browser playback from SAS URLs; do not use `*`. |

For the current local architecture, do not create an Azure Private Endpoint.
Playback returns a SAS URL for the browser to fetch directly from the Azure Blob
endpoint. A private endpoint would require the developer machine and browser to
have access to the Azure VNet, private DNS, and private routes. Keep the Blob container private and use the public HTTPS storage endpoint with
SAS authorization instead. Public network access should be enabled for the
current local setup so the local server and browser can reach Azure. Blob
anonymous access must remain disabled. These settings are not contradictory:
the storage endpoint is reachable, but every blob still requires a valid
short-lived SAS URL.

Only revisit this decision if private connectivity is intentionally designed
and tested. Creating a private endpoint alone does not provide connectivity
from a local machine.

Do not enable Data Lake Storage Gen2 or hierarchical namespace for this account.
Do not select Azure Files, Tables, or Queues. The application requires the Blob
service only.

A new local account can be created with settings similar to these:

```bash
az storage account create \
  --resource-group <resource-group> \
  --name <local-storage-account> \
  --location <region> \
  --sku Standard_LRS \
  --kind StorageV2 \
  --access-tier Hot \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
```

Do not add a hierarchical namespace flag. It must remain disabled. If the
account already exists, verify the settings in the Azure portal before using it.

Use a separate account from staging and production. The local account key must
never be reused in another environment.

- [ ] An Azure subscription and Storage Account are available.
- [ ] The account uses Blob Storage.
- [ ] A private container named `audio` exists, or another container name is
      selected for `AZURE_STORAGE_CONTAINER`.
- [ ] Anonymous public access is disabled for the container.
- [ ] The local operator has permission to read the account connection string.
- [ ] The storage account allows HTTPS requests.
- [ ] No private endpoint is configured for the current local setup; use the
      public HTTPS endpoint with private-container and SAS authorization.
- [ ] CORS allows the local application origin if the browser will stream SAS
      URLs directly from Azure.

Create the container through the Azure CLI or Azure portal. Confirm that the
container access level is private. The container must be created before the
application starts or before `npm run db:seed`. Do not add container creation
to application startup.

### Option A: Create the container with Azure CLI

Sign in to the subscription containing the local storage account. The identity
used with `--auth-mode login` must have permission to create Blob containers.

```bash
az login
az account set --subscription "<subscription-id-or-name>"
az storage container create \
  --account-name "<local-storage-account>" \
  --name audio \
  --public-access off \
  --auth-mode login
```

Verify that the container exists and is private:

```bash
az storage container show \
  --account-name "<local-storage-account>" \
  --name audio \
  --auth-mode login \
  --query '{name:name,publicAccess:publicAccess}' \
  --output json
```

The result should show `audio` and `publicAccess` as `null`, which means that
anonymous public access is disabled. If you use another container name, set
that same name in `AZURE_STORAGE_CONTAINER`.

### Option B: Create the container through the Azure portal

1. Open the Azure portal and select the correct subscription.
2. Open the local Storage account.
3. Select **Data storage > Containers**.
4. Select **+ Container**.
5. Set **Name** to `audio`, or use the name selected for
   `AZURE_STORAGE_CONTAINER`.
6. Set **Public access level** to **Private (no anonymous access)**.
7. Select **Create**.
8. Open the new container and verify that its access level remains private.

If the account does not allow the current identity to create containers, ask an
Azure administrator to perform this step. The application should not require
container-management permissions at runtime.

## 2. Obtain local configuration

### Retrieve the connection string with Azure CLI

Sign in with an identity that is allowed to read the storage account keys. If
multiple Azure subscriptions are available, select the subscription that
contains the local account before retrieving the secret:

```bash
az login
az account set --subscription "<subscription-id-or-name>"
az storage account show-connection-string \
  --resource-group "<resource-group>" \
  --name "<local-storage-account>" \
  --query connectionString \
  --output tsv
```

The final command prints the complete single-line connection string. The
`--query connectionString --output tsv` options prevent JSON wrappers and
return the value in the format expected by the application. Store the result
only in the local secret workflow or `.env.development`; do not save it in
shell history, source files, chat, tickets, or logs. The command requires
permission to retrieve the account key. If the command is not allowed, ask an
Azure administrator to retrieve the secret through the approved secret store.

- [ ] Copy `.env.development.example` to `.env.development`.
- [ ] Set `MONGO_URI` for the local MongoDB database.
- [ ] Set `AZURE_STORAGE_CONNECTION_STRING` using a secret-management method.
- [ ] Set `AZURE_STORAGE_ACCOUNT_NAME` to the storage account name.
- [ ] Set `AZURE_STORAGE_CONTAINER` to the manually created private container.
- [ ] Keep `AUDIO_SAS_EXPIRY_MINUTES` at 60 or lower.
- [ ] Keep `AUDIO_SAS_CLOCK_SKEW_MINUTES` at 5 unless there is a documented
      clock issue.
- [ ] Review `REMOTE_AUDIO_TIMEOUT_SECONDS` and
      `REMOTE_AUDIO_MAX_REDIRECTS` before enabling remote imports.
- [ ] Set `APP_ORIGINS=http://localhost:3000` when required by local browser
      access.
- [ ] Confirm `.env.development` is ignored by Git.

The minimum Azure settings look like this, with the secret value kept local:

```dotenv
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
AZURE_STORAGE_ACCOUNT_NAME=...
AZURE_STORAGE_CONTAINER=audio
AUDIO_SAS_EXPIRY_MINUTES=60
AUDIO_SAS_CLOCK_SKEW_MINUTES=5
REMOTE_AUDIO_TIMEOUT_SECONDS=300
REMOTE_AUDIO_MAX_REDIRECTS=3
APP_ORIGINS=http://localhost:3000
```

Do not paste the connection string into source files, issue trackers, chat, or
browser code.

## 3. Start local dependencies

- [ ] Start MongoDB:

```bash
docker compose -f docker-compose.dev.yml up -d
```

- [ ] Install dependencies:

```bash
npm install
```

- [ ] Seed or prepare the database if required:

```bash
npm run db:seed
```

When `AZURE_STORAGE_CONNECTION_STRING` is configured, this command uploads
`public/audio/sample-call.wav` once for each seeded conversation using the blob
name `<conversation_id>.wav`, then stores that `blob_name` in `audio_files`.
The private `audio` container must already exist. The seed checks the container
before changing MongoDB, so a missing or unreachable Azure container does not
erase existing database collections. Without Azure configuration, seeded records
continue to reference the local `/audio/sample-call.wav` file.

- [ ] Start the backend:

```bash
npm run dev:server
```

- [ ] Confirm the health endpoint responds:

```bash
curl http://localhost:3000/health
```

- [ ] Confirm the backend starts without attempting to create the Azure
      container.

## 4. Test an existing Azure blob

Upload a known test file to the private container using an approved Azure
workflow. Use a blob name under `imports/`, for example
`imports/manual-test.wav`.

- [ ] Confirm the blob exists in the private container.
- [ ] Import a conversation using `blob_name`:

```bash
curl -X POST http://localhost:3000/api/import \
  -H 'Content-Type: application/json' \
  -d '{
    "conversation": {
      "customer": { "phone": 1555000100, "name": "Jordan Reyes" },
      "agent": { "email": "maya.chen@company.com", "name": "Maya Chen" },
      "channel": "call",
      "started_at": "2026-07-20T09:00:00Z",
      "ended_at": "2026-07-20T09:05:00Z"
    },
    "audio": {
      "blob_name": "imports/manual-test.wav",
      "format": "wav"
    }
  }'
```

- [ ] Confirm the response is `201` and contains an `id`.
- [ ] Confirm the `audio_files` record contains the same `blob_name`.
- [ ] Confirm the server did not copy or overwrite the existing blob.

## 5. Test a multipart upload

- [ ] Import a local WAV, MP3, OGG, FLAC, or WebM file:

```bash
curl -X POST http://localhost:3000/api/import \
  -F 'data={"conversation":{"customer":{"phone":1555000101,"name":"Casey Kim"},"agent":{"email":"maya.chen@company.com","name":"Maya Chen"},"channel":"call","started_at":"2026-07-20T09:00:00Z","ended_at":"2026-07-20T09:05:00Z"}}' \
  -F 'audio=@/path/to/recording.wav;type=audio/wav'
```

- [ ] Confirm the response is `201`.
- [ ] Confirm a new opaque blob exists under `imports/`.
- [ ] Confirm no new audio file was written to `public/audio/`.
- [ ] Confirm the database record stores `blob_name` and the format.
- [ ] Confirm a file over 500 MB is rejected with `413`.
- [ ] Confirm unsupported MIME types are rejected.

## 6. Test a remote HTTPS URL

Use a remote HTTPS URL that you trust and that returns an allowed audio MIME
type. Do not test with internal services, localhost, cloud metadata endpoints,
or URLs containing credentials.

- [ ] Import with `remote_url`:

```bash
curl -X POST http://localhost:3000/api/import \
  -H 'Content-Type: application/json' \
  -d '{
    "conversation": {
      "customer": { "phone": 1555000102, "name": "Taylor Smith" },
      "agent": { "email": "maya.chen@company.com", "name": "Maya Chen" },
      "channel": "call",
      "started_at": "2026-07-20T09:00:00Z",
      "ended_at": "2026-07-20T09:05:00Z"
    },
    "audio": {
      "remote_url": "https://media.example.com/call.wav"
    }
  }'
```

- [ ] Confirm the response is `201`.
- [ ] Confirm the downloaded file is stored under a generated `imports/` blob.
- [ ] Confirm the source URL is not stored as a public playback URL.
- [ ] Confirm an HTTP URL is rejected.
- [ ] Confirm a URL resolving to localhost or a private address is rejected.
- [ ] Confirm redirects to unsafe addresses are rejected.
- [ ] Confirm non-audio responses are rejected.
- [ ] Confirm oversized responses and download timeouts are rejected.

Remote downloads are deliberately restricted because the server performs the
network request. Do not remove the HTTPS, DNS/IP, redirect, response-size, or
content-type checks to make a test source work.

## 7. Verify SAS playback

- [ ] Open a conversation created by each audio mode.
- [ ] Request the playback endpoint:

```bash
curl http://localhost:3000/api/audio/<conversation-id>
```

- [ ] Confirm the response contains a short-lived `url`.
- [ ] Confirm the URL uses HTTPS and the Azure blob hostname.
- [ ] Confirm the SAS permissions are read-only.
- [ ] Confirm the URL is scoped to the expected blob.
- [ ] Confirm the URL is not written to MongoDB as the permanent audio value.
- [ ] Play the conversation in the browser.
- [ ] Confirm Azure CORS permits the browser origin.
- [ ] Confirm the direct blob request does not require a public container.

## 8. Test local fallback separately

To verify the old filesystem fallback, stop using Azure settings in the local
environment and restart the server.

- [ ] Import a multipart file with Azure disabled.
- [ ] Confirm the file is written under `public/audio/`.
- [ ] Confirm playback streams the file locally.
- [ ] Confirm byte-range playback still returns `206`.

Do not use this fallback as evidence that Azure configuration is working.

## 9. Troubleshooting

| Symptom | Checks |
|---------|--------|
| Azure storage unavailable | Check connection string, account name, network access, and container name. |
| Container not found | Create the container manually and verify `AZURE_STORAGE_CONTAINER`. |
| SAS request succeeds but playback fails | Check Azure CORS, HTTPS, SAS expiry, and browser network logs. |
| Existing blob rejected | Check the exact container-relative `blob_name` and blob existence. |
| Remote URL rejected | Check HTTPS, DNS resolution, public IP routing, redirect targets, MIME type, and size. |
| Multipart upload rejected | Check the MIME type and 500 MB size limit. |
| Local file appears during Azure import | Check that `AZURE_STORAGE_CONNECTION_STRING` was loaded before starting the server. |

## 10. Cleanup and security review

- [ ] Delete test blobs from the Azure container after testing.
- [ ] Remove test conversations from the local database if they contain real
      data.
- [ ] Revoke or rotate the local connection string if it was exposed.
- [ ] Confirm no `.env` file, SAS URL, or account key appears in `git diff`.
- [ ] Confirm the container remains private.
- [ ] Confirm application startup still does not call container creation.
- [ ] Run the backend test suite:

```bash
npm run build:server
npm run test:server
```
