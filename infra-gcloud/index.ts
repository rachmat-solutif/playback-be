import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

// --- Config ---

const config = new pulumi.Config();
const appName = config.require("appName");
const machineType = config.get("machineType") || "e2-micro";

// Secrets -- set via: pulumi config set --secret mongoUri "mongodb+srv://..."
const mongoUri = config.requireSecret("mongoUri");
const azureStorageConnectionString = config.requireSecret("azureStorageConnectionString");

const nodeEnv = config.get("nodeEnv") || "staging";
const azureStorageContainer = config.get("azureStorageContainer") || "audio";
const audioSasExpiryMinutes = config.getNumber("audioSasExpiryMinutes") || 60;
const appOrigins = config.get("appOrigins") || "";

// Auth config
const authProvider = config.get("authProvider") || "entra";
const sessionKey = config.getSecret("sessionKey");
const sessionPassword = config.getSecret("sessionPassword");
const entraClientId = config.getSecret("entraClientId");
const entraTenantId = config.getSecret("entraTenantId");
const entraClientSecret = config.getSecret("entraClientSecret");
const entraRedirectUri = config.get("entraRedirectUri") || "";
const entraLogoutUri = config.get("entraLogoutUri") || "";
const importApiKey = config.getSecret("importApiKey");

// SSH key for deployment access
const sshPublicKey = config.require("sshPublicKey");
const deployUser = config.get("deployUser") || "deploy";

// Optional domain (if set, Caddy will auto-configure HTTPS for it)
const domain = config.get("domain") || "";

// --- Network ---

const network = new gcp.compute.Network("network", {
  name: `${appName}-vpc`,
  autoCreateSubnetworks: false,
});

const subnet = new gcp.compute.Subnetwork("subnet", {
  name: `${appName}-subnet`,
  network: network.id,
  ipCidrRange: "10.0.1.0/24",
  region: gcp.config.region!,
});

// --- Firewall Rules ---

const firewallAllowHttp = new gcp.compute.Firewall("allow-http", {
  name: `${appName}-allow-http`,
  network: network.selfLink,
  allows: [
    { protocol: "tcp", ports: ["80", "443"] },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["web-server"],
});

const firewallAllowSsh = new gcp.compute.Firewall("allow-ssh", {
  name: `${appName}-allow-ssh`,
  network: network.selfLink,
  allows: [
    { protocol: "tcp", ports: ["22"] },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["web-server"],
});

const firewallAllowApp = new gcp.compute.Firewall("allow-app", {
  name: `${appName}-allow-app`,
  network: network.selfLink,
  allows: [
    { protocol: "tcp", ports: ["3000"] },
  ],
  sourceRanges: ["0.0.0.0/0"],
  targetTags: ["web-server"],
});

// --- Static IP ---

const staticIp = new gcp.compute.Address("static-ip", {
  name: `${appName}-ip`,
  region: gcp.config.region!,
});

// --- Startup Script ---
// Installs Node.js 22, creates app directory, sets up systemd service.
// Code deployment is handled separately via deploy.sh (SCP + restart).

const startupScript = pulumi.interpolate`#!/bin/bash
set -e

# Install Node.js 22 (if not already installed)
if ! command -v node &> /dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Install Caddy for reverse proxy with automatic HTTPS
if ! command -v caddy &> /dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Create deploy user (for SSH deployments)
if ! id "${deployUser}" &>/dev/null; then
  useradd -m -s /bin/bash ${deployUser}
  mkdir -p /home/${deployUser}/.ssh
  echo "${sshPublicKey}" > /home/${deployUser}/.ssh/authorized_keys
  chmod 700 /home/${deployUser}/.ssh
  chmod 600 /home/${deployUser}/.ssh/authorized_keys
  chown -R ${deployUser}:${deployUser} /home/${deployUser}/.ssh
fi

# Create app directory
mkdir -p /opt/playback
chown ${deployUser}:${deployUser} /opt/playback

# Write environment file
cat > /opt/playback/.env <<EOF
NODE_ENV=${nodeEnv}
PORT=3000
MONGO_URI=${mongoUri}
AZURE_STORAGE_CONNECTION_STRING=${azureStorageConnectionString}
AZURE_STORAGE_CONTAINER=${azureStorageContainer}
AUDIO_SAS_EXPIRY_MINUTES=${audioSasExpiryMinutes}
APP_ORIGINS=${appOrigins}
AUTH_PROVIDER=${authProvider}
EOF

# Add optional Entra ID config
${entraClientId ? pulumi.interpolate`echo "ENTRA_CLIENT_ID=${entraClientId}" >> /opt/playback/.env` : "true"}
${entraTenantId ? pulumi.interpolate`echo "ENTRA_TENANT_ID=${entraTenantId}" >> /opt/playback/.env` : "true"}
${entraClientSecret ? pulumi.interpolate`echo "ENTRA_CLIENT_SECRET=${entraClientSecret}" >> /opt/playback/.env` : "true"}
${entraRedirectUri ? pulumi.interpolate`echo "ENTRA_REDIRECT_URI=${entraRedirectUri}" >> /opt/playback/.env` : "true"}
${entraLogoutUri ? pulumi.interpolate`echo "ENTRA_LOGOUT_URI=${entraLogoutUri}" >> /opt/playback/.env` : "true"}
${importApiKey ? pulumi.interpolate`echo "IMPORT_API_KEY=${importApiKey}" >> /opt/playback/.env` : "true"}

# Add optional session config
${sessionKey ? pulumi.interpolate`echo "SESSION_KEY=${sessionKey}" >> /opt/playback/.env` : "true"}
${sessionPassword ? pulumi.interpolate`echo "SESSION_PASSWORD=${sessionPassword}" >> /opt/playback/.env` : "true"}

chmod 600 /opt/playback/.env
chown ${deployUser}:${deployUser} /opt/playback/.env

# Create systemd service
cat > /etc/systemd/system/playback.service <<EOF
[Unit]
Description=Playback Web Server
After=network.target

[Service]
Type=simple
User=${deployUser}
WorkingDirectory=/opt/playback
EnvironmentFile=/opt/playback/.env
ExecStart=/usr/bin/node src/dist-server/app.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable playback

# Configure Caddy
cat > /etc/caddy/Caddyfile <<EOF
${domain || ":80"} {
  reverse_proxy localhost:3000
}
EOF

systemctl restart caddy
`;

// --- Compute Instance ---

const instance = new gcp.compute.Instance("vm", {
  name: `${appName}-vm`,
  machineType: machineType,
  zone: gcp.config.zone!,
  tags: ["web-server"],
  bootDisk: {
    initializeParams: {
      image: "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
      size: 20, // GB
      type: "pd-standard",
    },
  },
  networkInterfaces: [
    {
      network: network.id,
      subnetwork: subnet.id,
      accessConfigs: [
        {
          natIp: staticIp.address,
        },
      ],
    },
  ],
  metadataStartupScript: startupScript,
  metadata: {
    "ssh-keys": pulumi.interpolate`${deployUser}:${sshPublicKey}`,
  },
  serviceAccount: {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
  allowStoppingForUpdate: true,
});

// --- Outputs ---

export const vmName = instance.name;
export const vmZone = instance.zone;
export const externalIp = staticIp.address;
export const sshCommand = pulumi.interpolate`ssh ${deployUser}@${staticIp.address}`;
export const endpoint = pulumi.interpolate`http://${staticIp.address}`;
