# Private Azure Audio Delivery - DevOps Runbook

This document configures private Azure Blob Storage audio delivery for Playback.
The application authenticates users with Microsoft Entra ID, then returns a
short-lived read-only Service SAS URL. The browser downloads or streams audio
directly from Azure Blob Storage.

Do not put real secrets, connection strings, client secrets, SAS URLs, or account
keys in this document, source control, issue trackers, or application logs.

## Architecture

```text
Browser -- Entra login --> Playback Fastify API -- MongoDB metadata
                                      |
                                      +-- JSON { url: private Blob SAS }

Browser -- HTTPS GET/Range GET with SAS --> Azure Blob Storage
```

The API does not proxy Azure audio bytes. This reduces bandwidth and memory use
on the GCP VM. CORS permits browser-origin requests, but CORS is not
authorization; the SAS is still required.

For the current architecture, Public network access should be enabled so the
application server and browser can reach the Azure Blob endpoint. Blob
anonymous access must remain disabled. An enabled public network endpoint does
not make the blobs public: the endpoint is reachable, but each blob still
requires a valid short-lived read-only SAS URL. Use storage firewall rules or
approved network restrictions where practical, without disabling the endpoint
needed by the application and browser.

## Environment isolation

Use a separate Storage account for each environment where possible. At a
minimum, use separate private containers and separate credentials.

| Environment | Application origin | Storage account | Container | Runtime |
|---|---|---|---|---|
| local | `http://localhost:3000` | `<local-storage-account>` | `audio` | developer machine |
| staging | `https://<staging-host>` | `<staging-storage-account>` | `audio` | GCP staging VM |
| production | `https://<production-host>` | `<production-storage-account>` | `audio` | production deployment |

### Recommended account settings

Use separate StorageV2 accounts and credentials for local, staging, and
production. The application currently uses private Blob containers and
account-key-signed Service SAS URLs.

| Setting | Local | Staging | Production |
|---------|-------|---------|------------|
| Account kind | StorageV2 | StorageV2 | StorageV2 |
| Blob service | Enabled | Enabled | Enabled |
| Hierarchical namespace | Disabled | Disabled | Disabled unless the application is intentionally migrated to ADLS Gen2 |
| Performance | Standard | Standard | Standard; evaluate Premium only with measured workload requirements |
| Access tier | Hot | Hot | Hot |
| Redundancy | LRS | LRS or ZRS if staging availability matters | GZRS where available; otherwise ZRS, based on approved RTO/RPO |
| Public blob access | Disabled | Disabled | Disabled |
| Secure transfer | Enabled | Enabled | Enabled |
| Minimum TLS | TLS 1.2 | TLS 1.2 | TLS 1.2 |
| Shared Key access | Enabled for current Service SAS | Enabled until User Delegation SAS migration | Enabled until User Delegation SAS migration; disable only after migration |
| Public network access | Developer access with firewall restrictions when practical | Restrict to approved GCP egress IPs where practical | Restrict to approved application egress or private connectivity where available |
| Private endpoint | Not recommended for the current local browser flow | Optional only with approved GCP-to-Azure private networking and DNS | Conditional on approved private networking and an audio delivery design that supports private browser access |
| Blob versioning | Disabled | Optional | Enable when recovery or compliance requires it |
| Blob and container soft delete | Disabled or shortest approved period | At least 7 days | At least 30 days, subject to retention policy |
| CORS | Exact local origin | Exact staging origin | Exact production origin |
| Diagnostics | Optional for local troubleshooting | Enable Blob logs and metrics | Enable Blob logs, metrics, alerts, and retention according to policy |

Recommended account choices:

- **Local:** Standard LRS, Hot tier, private container, and the lowest practical
  retention. Local data is disposable and the account should be separate from
  all shared environments.
- **Staging:** Standard LRS is sufficient for a cost-conscious test environment.
  Use ZRS if staging availability testing or continuity is important. Keep the
  container private and configure the staging origin only.
- **Production:** Prefer Standard GZRS where it is available and consistent
  with the approved regional recovery design. Use Standard ZRS when GZRS is not
  available or when the approved RTO/RPO does not require geo-replication. Keep
  the Hot tier, private access, exact CORS, diagnostic logs, and a retention
  period approved by the data owner.

### Private endpoint decision

Do not create a private endpoint for the current local setup. The developer
machine and browser are not connected to an Azure VNet, and the application
returns SAS URLs for the browser to fetch directly from the Blob endpoint.
Private access would require private routing and DNS for the browser as well as
the server.

For staging and production, a private endpoint is not a standalone security
switch. The GCP VM would require approved GCP-to-Azure VPN or equivalent private
connectivity, Azure VNet routing, private DNS for
`privatelink.blob.core.windows.net`, and matching firewall rules. Browser users
would also need network access to the private endpoint. If browsers remain
outside that private network, direct SAS playback will fail unless the
application changes to proxy audio bytes through a reachable service or uses an
approved public Blob endpoint with SAS.

Keep private Blob containers, disabled anonymous access, HTTPS, exact CORS, and
short-lived SAS authorization as the current control set. Revisit private
endpoints only as part of a complete network and playback architecture review.

Do not enable hierarchical namespace merely because the account is used for
large audio files. Playback uses ordinary Blob Storage block blobs. Do not use
Azure Files, Tables, or Queues for audio delivery.

Because the application currently signs Service SAS URLs with the storage
account key, Shared Key access must remain enabled in staging and production
until the User Delegation SAS migration in Section 10 is complete. After that
migration is verified, disable Shared Key access and update the account policy.

Azure calls these resources containers, not buckets. Never reuse a production
connection string in local or staging.

## 1. Create private Storage accounts

Run once per environment with an account name that is globally unique.

```bash
az storage account create \
  --resource-group <resource-group> \
  --name <storage-account> \
  --location <region> \
  --sku <environment-approved-sku> \
  --kind StorageV2 \
  --access-tier Hot \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
```

For local and cost-conscious staging, use `Standard_LRS`. For staging with
availability testing, use `Standard_ZRS`. For production, use
`Standard_GZRS` where available and approved, or `Standard_ZRS` when the
approved recovery design does not require geo-replication. Leave hierarchical
namespace disabled; this application uses Blob Storage block blobs rather than
ADLS Gen2.

### Create the private audio container with Azure CLI

Sign in to the subscription that contains the storage account. The identity
used with `--auth-mode login` must have permission to create Blob containers,
for example through an appropriate Azure Storage data-plane role.

```bash
az login
az account set --subscription "<subscription-id-or-name>"
az storage container create \
  --account-name "<storage-account>" \
  --name audio \
  --public-access off \
  --auth-mode login
```

Verify the container and its access level:

```bash
az storage container show \
  --account-name "<storage-account>" \
  --name audio \
  --auth-mode login \
  --query '{name:name,publicAccess:publicAccess}' \
  --output json
```

The container name should be `audio` and `publicAccess` should be `null`, which
means that anonymous public access is disabled. If a different container name
is used, set the same value in `AZURE_STORAGE_CONTAINER`.

### Create the private audio container through the Azure portal

1. Open the Azure portal and select the correct subscription.
2. Open the target Storage account.
3. Select **Data storage > Containers**.
4. Select **+ Container**.
5. Set **Name** to `audio`, or use the environment-specific value intended for
   `AZURE_STORAGE_CONTAINER`.
6. Set **Public access level** to **Private (no anonymous access)**.
7. Select **Create**.
8. Open the new container and verify that its access level remains private.

Create the container once per environment before deploying or running the
application. Do not grant the application runtime permission to create or
change containers. The application does not provision containers during
startup, import processing, or playback.

```bash
az storage account show \
  --resource-group <resource-group> \
  --name <storage-account> \
  --query '{publicBlobAccess:allowBlobPublicAccess,httpsOnly:enableHttpsTrafficOnly}'
```

Expected values are `false` for public blob access and `true` for HTTPS-only
traffic.

The application currently uses a Service SAS signed by the storage account
key. Retrieve the connection string only through a protected secret-management
workflow. Do not paste it into a terminal transcript that is retained. The
Azure CLI must be logged in to the subscription containing the target account,
and the identity must be allowed to retrieve account keys.

```bash
az login
az account set --subscription "<subscription-id-or-name>"
az storage account show-connection-string \
  --resource-group "<resource-group>" \
  --name "<storage-account>" \
  --query connectionString \
  --output tsv
```

The final command returns the complete single-line connection string without
JSON wrappers. Store it only in the environment's approved secret store or
protected runtime environment file. Do not put it in source control, shell
transcripts, logs, tickets, or chat. If account-key retrieval is not permitted,
ask an Azure administrator to place the secret in the approved secret store.

## 2. Configure Blob CORS

CORS must be configured separately on each Storage account. Use exact origins,
not `*`.

```bash
az storage cors add \
  --account-name <storage-account> \
  --services b \
  --methods GET HEAD OPTIONS \
  --origins <exact-application-origin> \
  --allowed-headers Range \
  --exposed-headers Content-Length Content-Range Accept-Ranges Content-Type ETag \
  --max-age 3600 \
  --auth-mode login
```

For local development, use the exact local origin, for example:

```text
http://localhost:3000
```

For staging and production, use their HTTPS origins. Do not include a trailing
slash unless it is part of the actual browser Origin value. Do not use a
wildcard origin when audio is private.

Verify the rule:

```bash
az storage cors list \
  --account-name <storage-account> \
  --services b \
  --auth-mode login
```

The browser may use Range requests for seeking. If browser testing shows that
Range is not accepted, add the exact request header required by the browser or
player implementation; do not broaden the rule to all headers without review.

## 3. Configure SAS expiry policy

The application issues a Service SAS with an expiry of 60 minutes from
issuance. It sets the signed start time five minutes in the past to tolerate
clock skew. Therefore, the Azure account policy must allow at least a
65-minute signed interval. Use a 75-minute upper limit as the operational
buffer.

Configure the SAS expiration policy on each account in the Azure portal under
Storage account > Configuration > Shared access signature (SAS) expiration
policy:

- Enabled: yes
- Upper limit: 0 days, 1 hour, 15 minutes
- Initial action: Log
- Later action: Block, after violations have been reviewed

Both account keys may need to have a creation time before the policy can be
configured. Rotate keys according to the key-rotation procedure if Azure
requires it.

The application settings are:

```text
AUDIO_SAS_EXPIRY_MINUTES=60
AUDIO_SAS_CLOCK_SKEW_MINUTES=5
```

Never increase the application expiry casually. A SAS is a bearer credential:
anyone who obtains the URL can use it until it expires or the signing key is
rotated.

## 4. Configure Microsoft Entra ID

Create a separate Web app registration for local, staging, and production when
possible. This isolates redirect URIs and client credentials.

For each registration:

1. Open Microsoft Entra ID > App registrations > New registration.
2. Use the organization tenant account type unless cross-tenant access is
   explicitly required.
3. Add a Web platform.
4. Add the exact redirect URI:
   - Local: `http://localhost:3000/auth/callback`
   - Staging: `https://<staging-host>/auth/callback`
   - Production: `https://<production-host>/auth/callback`
5. Create a client secret with an expiry approved by the security team.
6. Record the client ID, tenant ID, and secret in the environment secret store.
7. Configure the post-logout URI:
   - Local: `http://localhost:3000/login`
   - Staging: `https://<staging-host>/login`
   - Production: `https://<production-host>/login`

The application uses authorization code flow with PKCE. It stores only the
necessary identity/session data in the encrypted HTTP-only session cookie.

Required runtime settings:

```text
AUTH_PROVIDER=entra
ENTRA_CLIENT_ID=<environment-client-id>
ENTRA_TENANT_ID=<tenant-id>
ENTRA_CLIENT_SECRET=<environment-client-secret>
ENTRA_REDIRECT_URI=https://<environment-host>/auth/callback
ENTRA_LOGOUT_URI=https://<environment-host>/login
SESSION_KEY=<64 hexadecimal characters>
SESSION_PASSWORD=<long random secret>
```

`AUTH_BYPASS=true` is permitted only for local development or tests. It must
not be present in staging or production.

## 5. Configure local development

Copy the example file and fill values through a local secret workflow:

```bash
cp .env.development.example .env.development
openssl rand -hex 32
openssl rand -base64 32
```

For local Azure-backed audio, set the local account connection string and keep
the local account/container private:

```text
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/childapp
AUTH_PROVIDER=entra
AZURE_STORAGE_CONNECTION_STRING=<local-secret>
AZURE_STORAGE_ACCOUNT_NAME=<local-storage-account>
AZURE_STORAGE_CONTAINER=audio
AUDIO_SAS_EXPIRY_MINUTES=60
AUDIO_SAS_CLOCK_SKEW_MINUTES=5
APP_ORIGINS=http://localhost:3000
```

If Azure is intentionally unavailable, omit the Azure connection string. The
application then uses `public/audio/` and local HTTP Range streaming. Do not use
this fallback to test staging or production behavior.

## 6. Configure GCP Pulumi staging or production

The Pulumi stack must receive environment-specific encrypted values. Run from
`infra-gcloud/`:

```bash
pulumi config set --secret mongoUri '<environment-mongo-uri>'
pulumi config set --secret azureStorageConnectionString '<environment-connection-string>'
pulumi config set azureStorageContainer audio
pulumi config set audioSasExpiryMinutes 60
pulumi config set appOrigins 'https://<environment-host>'
pulumi config set authProvider entra
pulumi config set --secret entraClientId '<client-id>'
pulumi config set --secret entraTenantId '<tenant-id>'
pulumi config set --secret entraClientSecret '<client-secret>'
pulumi config set entraRedirectUri 'https://<environment-host>/auth/callback'
pulumi config set entraLogoutUri 'https://<environment-host>/login'
pulumi config set --secret sessionKey '<64-hex-character-key>'
pulumi config set --secret sessionPassword '<random-session-password>'
```

For a production Pulumi stack, set the appropriate `nodeEnv` value:

```bash
pulumi config set nodeEnv production
```

Review the rendered environment configuration carefully and do not print
secret values. Apply only after reviewing the change:

```bash
pulumi preview --stack <environment>
pulumi up --stack <environment>
```

The VM environment file must have mode `600`, and the application service must
run as the non-root deployment user.

## 7. Deployment checks

After deployment:

```bash
curl -fsS https://<environment-host>/health
```

Verify all of the following in a browser session:

1. An unauthenticated request is redirected to Entra login or receives `401`
   for an API request.
2. An authenticated request to `/auth/me` returns the signed-in user.
3. `GET /api/audio/<conversation-id>` returns JSON with `url`.
4. The JSON response does not contain audio bytes.
5. The browser requests audio directly from the environment's Blob endpoint.
6. Playback, pause, seeking, and reload work.
7. Browser DevTools shows Range requests when seeking.
8. The SAS URL contains read-only HTTPS parameters and the expected account.
9. No SAS query string appears in application logs.

The local, staging, and production SAS URLs must contain different storage
account hostnames.

## 8. Monitoring and audit

Create a Log Analytics workspace and diagnostic setting for Blob read/write/
delete logs on each account. Keep the application log and Azure Storage log
retention appropriate for the organization's privacy and compliance needs.

The application should log safe SAS issuance metadata:

- event name
- environment
- authenticated user ID
- conversation ID
- blob name
- request/correlation ID
- expiry timestamp or configured lifetime

Never log the URL, SAS query string, account key, connection string, Entra
client secret, or session secret.

Useful Log Analytics queries include:

```kusto
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where StatusCode >= 400
| summarize failures=count() by StatusCode, OperationName, AccountName
| order by failures desc
```

```kusto
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where SasExpiryStatus startswith "Policy violated"
| summarize count() by AccountName, SasExpiryStatus
```

```kusto
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where AuthenticationType in ("AccountKey", "SAS")
| summarize requests=count() by CallerIpAddress, UserAgentHeader, AccountName
| top 20 by requests desc
```

Create alerts for repeated Blob `403` responses, SAS policy violations, and
unexpected request-volume spikes. Correlate an application audio-SAS issuance
event with Azure Blob logs using the request/correlation ID when available.

## 9. Service SAS emergency revocation

An ad hoc Service SAS cannot be revoked individually. If a SAS URL or account
key may have leaked:

1. Identify the affected environment and storage account.
2. Restrict or disable the affected application path if immediate containment
   is needed.
3. Rotate the storage account key used by the application.
4. Store the new connection string in the correct secret store.
5. Redeploy or restart the application so it uses the new key.
6. Verify that old SAS URLs fail and newly issued URLs work.
7. Review Entra, application, and Blob logs for unauthorized access.
8. Record the incident and remove any exposed secrets from logs or tickets.

Key rotation may affect all Service SAS URLs and all applications using that
key. Coordinate the rotation and prefer one key per environment/account.

## 10. Migration to User Delegation SAS

Microsoft recommends User Delegation SAS because it is signed with Microsoft
Entra credentials rather than a storage account key.

Do not set `AllowSharedKeyAccess=false` while the application still relies on a
connection string for any operation. Disabling Shared Key rejects Service SAS
and account-key requests.

Migration sequence:

1. Keep the audio route contract unchanged: `{ url }`.
2. Keep SAS signing behind the storage signer boundary.
3. Add an Entra workload identity for the application:
   - For an Azure-hosted runtime, use a system-assigned or user-assigned
     managed identity.
   - For the GCP VM, use Microsoft Entra workload identity federation or move
     the signing/storage workload to an Azure-hosted service. A GCP VM does not
     automatically have an Azure Managed Identity.
4. Grant only the required Azure RBAC roles. The identity generally needs
   `Storage Blob Delegator` to obtain a user delegation key. Upload, delete,
   and other data operations need an appropriate data-plane role such as
   `Storage Blob Data Contributor`; verify the exact scope and current role
   requirements before assignment.
5. Replace connection-string Blob clients with `DefaultAzureCredential` and an
   account endpoint/name configuration.
6. Migrate every server-side operation:
   - upload
   - delete
   - existence checks
   - container initialization
   - SAS signing
7. Cache the user delegation key only within its supported validity period and
   renew it before expiry.
8. Generate a User Delegation SAS with the same restrictions:
   - one exact blob
   - read permission only
   - HTTPS only
   - one-hour application access window
9. Test imports/uploads and direct playback in local or a dedicated migration
   environment.
10. Enable User Delegation SAS in staging and verify logs and metrics.
11. Enable User Delegation SAS in production.
12. Confirm no remaining account-key clients in Azure metrics and logs.
13. Set `AllowSharedKeyAccess=false` only after the migration is complete.
14. Move the Storage policy for Shared Key access from audit to deny when
    governance approval is complete.

After migration, revocation is handled through Entra identity/RBAC and
user-delegation-key lifecycle controls rather than rotating the storage account
key for every application event.

## References

- https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview
- https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/storage
- https://learn.microsoft.com/en-us/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services
- https://learn.microsoft.com/en-us/entra/identity-platform/tutorial-v2-nodejs-webapp-msal
- https://learn.microsoft.com/en-us/azure/storage/common/sas-expiration-policy
- https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent
