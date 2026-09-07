# Playback -- GCP Compute Engine Infrastructure

Pulumi-managed GCP e2 VM for running the Playback web server.
Storage remains on Azure Blob Storage; database remains on MongoDB Atlas M0.

## Architecture

```
Client -> Caddy (port 80/443) -> Node.js Fastify (port 3000) -> MongoDB Atlas M0
                                                              -> Azure Blob Storage
```

- GCP Compute Engine e2-micro (free tier eligible: 1 instance in us-central1, or ~$6/month in other regions)
- Caddy reverse proxy with automatic HTTPS (once you add a domain)
- Systemd manages the Node.js process
- Code deployed via rsync over SSH

## Prerequisites

1. GCP project with billing enabled
2. Pulumi CLI installed (`curl -fsSL https://get.pulumi.com | sh`)
3. gcloud CLI installed and authenticated (`curl -fsSL https://sdk.cloud.google.com | bash`, `gcloud auth login`)
4. SSH key pair for deployment access
5. MongoDB Atlas M0 connection string
6. Azure Storage connection string (from existing infra)

## Setup

### 1. Install dependencies

```bash
cd infra-gcloud
npm install
```

### 2. Initialize the Pulumi stack

```bash
pulumi stack init staging
```

### 3. Set your GCP project

Edit `Pulumi.staging.yaml` and replace `REPLACE_WITH_YOUR_GCP_PROJECT_ID`:

```yaml
config:
  gcp:project: your-gcp-project-id
```

### 4. Configure secrets

Use a separate Azure Storage account, Entra app registration, and secret set for
local, staging, and production. All Pulumi secret values are encrypted in the
stack state.

```bash
# Required
pulumi config set --secret mongoUri "mongodb+srv://user:pass@cluster.mongodb.net/playback"
pulumi config set --secret azureStorageConnectionString "DefaultEndpointsProtocol=https;AccountName=..."
pulumi config set azureStorageContainer audio
pulumi config set audioSasExpiryMinutes 60
pulumi config set appOrigins "https://playback.example.com"
pulumi config set authProvider entra
pulumi config set nodeEnv staging

# Entra ID
pulumi config set --secret entraClientId "<environment-client-id>"
pulumi config set --secret entraTenantId "<tenant-id>"
pulumi config set --secret entraClientSecret "<environment-client-secret>"
pulumi config set entraRedirectUri "https://playback.example.com/auth/callback"
pulumi config set entraLogoutUri "https://playback.example.com/login"
pulumi config set --secret sessionKey "$(openssl rand -hex 32)"
pulumi config set --secret sessionPassword "$(openssl rand -base64 32)"

# SSH public key (paste the content of your ~/.ssh/gcp_key.pub)
pulumi config set sshPublicKey "$(cat ~/.ssh/gcp_key.pub)"

# Optional
pulumi config set deployUser deploy
pulumi config set machineType e2-small
```

Do not use `AUTH_BYPASS=true` in staging or production. See
`../docs/DEVOPS-AZURE-AUDIO.md` for Azure account creation, private containers,
Blob CORS, monitoring, key rotation, and User Delegation SAS migration.

### 5. Deploy infrastructure

```bash
pulumi preview   # review changes
pulumi up        # create resources
```

### 6. Deploy application code

```bash
./deploy.sh
# Or from project root:
npm run gcloud:deploy
```

## Machine Types

| Type | vCPU | RAM | Monthly Cost (asia-southeast1) |
|------|------|-----|-------------------------------|
| e2-micro | 0.25 | 1 GB | ~$6 |
| e2-small | 0.5 | 2 GB | ~$12 |
| e2-medium | 1 | 4 GB | ~$24 |

e2-micro is sufficient for a low-traffic staging environment.
For production, consider e2-small (2 GB RAM gives comfortable headroom).

Note: e2-micro is included in GCP's Always Free tier (1 instance in us-central1, us-east1, or us-west1 only).

## Deployment Workflow

After the VM is provisioned:

```bash
# From project root
npm run gcloud:deploy

# Or manually
./infra-gcloud/deploy.sh deploy@<EXTERNAL_IP>
```

The deploy script:
1. Builds the frontend locally (`npm run build`)
2. Rsyncs project files to the VM (excludes node_modules, .git, infra dirs)
3. Runs `npm ci --omit=dev` on the VM
4. Restarts the systemd service
5. Verifies the health endpoint

## SSH Access

```bash
# Get the SSH command from Pulumi outputs
pulumi stack output sshCommand --stack staging

# Or directly
ssh deploy@<EXTERNAL_IP>
```

## Logs and Debugging

```bash
# Application logs
ssh deploy@<IP> 'journalctl -u playback -f'

# Caddy logs
ssh deploy@<IP> 'journalctl -u caddy -f'

# Service status
ssh deploy@<IP> 'sudo systemctl status playback'
```

## Custom Domain with HTTPS

Once you have a domain pointing to the static IP:

```bash
ssh deploy@<IP>
sudo tee /etc/caddy/Caddyfile <<EOF
playback.yourdomain.com {
  reverse_proxy localhost:3000
}
EOF
sudo systemctl restart caddy
```

Caddy handles Let's Encrypt certificates automatically.

## Azure audio and authentication

Azure Blob Storage audio is private. The Fastify API authenticates the user
with Microsoft Entra ID and returns a one-hour read-only Service SAS URL; the
browser then downloads audio directly from Azure. Configure each environment
with a separate Storage account or private container, Entra app registration,
and secret set.

See `../docs/DEVOPS-AZURE-AUDIO.md` for the complete setup and operations
runbook, including exact-origin CORS, monitoring, revocation, and User
Delegation SAS migration.

## Environment Variables

Set on the VM via `/opt/playback/.env` (managed by the startup script):

| Variable | Source | Description |
|----------|--------|-------------|
| NODE_ENV | Pulumi config | `staging` or `production` |
| PORT | Hardcoded | `3000` |
| MONGO_URI | Pulumi secret | MongoDB Atlas connection |
| AZURE_STORAGE_CONNECTION_STRING | Pulumi secret | Environment-specific Azure Storage key for initial Service SAS |
| AZURE_STORAGE_CONTAINER | Pulumi config | Private audio container, normally `audio` |
| AUDIO_SAS_EXPIRY_MINUTES | Pulumi config | Direct audio URL lifetime, normally `60` |
| AUDIO_SAS_CLOCK_SKEW_MINUTES | Application default | Backdated SAS start buffer, normally `5` |
| APP_ORIGINS | Pulumi config | Exact browser origin(s) for deployment documentation/CORS |
| AUTH_PROVIDER | Pulumi config | `entra` in staging and production |
| ENTRA_CLIENT_ID | Pulumi secret | Environment-specific Entra app registration |
| ENTRA_TENANT_ID | Pulumi secret | Entra tenant |
| ENTRA_CLIENT_SECRET | Pulumi secret | Entra confidential-client secret |
| ENTRA_REDIRECT_URI | Pulumi config | Environment callback URL |
| ENTRA_LOGOUT_URI | Pulumi config | Environment post-logout URL |
| SESSION_KEY | Pulumi secret | 32-byte hexadecimal secure-session key |
| SESSION_PASSWORD | Pulumi secret | Secure-session password |

To update env vars after initial deploy, update Pulumi config and run `pulumi up`.
Avoid editing `/opt/playback/.env` manually except for emergency recovery, then
restart the service.


## Teardown

```bash
pulumi destroy --stack staging
```

This removes the VM, network, firewall rules, and static IP.
MongoDB Atlas and Azure Storage are unaffected (managed separately).

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| e2-micro VM (asia-southeast1) | ~$6 |
| Static IP (while attached) | $0 |
| 20 GB standard disk | ~$0.80 |
| Egress (first 1 GB free) | ~$0 for staging |
| **Total** | **~$7/month** |

Compare: Azure App Service F1 = $0 but limited (60 CPU-min/day, no always-on).
