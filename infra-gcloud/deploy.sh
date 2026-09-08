#!/bin/bash
# Deploy application code to GCP VM via rsync + SSH.
# Run after `pulumi up` to push code, or anytime to redeploy.
#
# Usage: ./infra-gcloud/deploy.sh [user@host]
#
# If no argument is given, reads the IP from Pulumi stack output.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Get deploy target and app dir from argument or Pulumi output
if [ -n "$1" ]; then
  DEPLOY_TARGET="$1"
  APP_DIR=$(pulumi config get appDir --stack staging 2>/dev/null || echo "/opt/playback")
else
  echo "[*] Reading deploy target from Pulumi outputs..."
  cd "$SCRIPT_DIR"
  DEPLOY_USER=$(pulumi config get deployUser --stack staging 2>/dev/null || echo "deploy")
  APP_DIR=$(pulumi config get appDir --stack staging 2>/dev/null || echo "/opt/playback")
  EXTERNAL_IP=$(pulumi stack output externalIp --stack staging)
  DEPLOY_TARGET="${DEPLOY_USER}@${EXTERNAL_IP}"
  cd "$PROJECT_ROOT"
fi

echo "=== Deploying to ${DEPLOY_TARGET} ==="
echo ""

# 1. Build frontend
echo "[1/4] Building frontend..."
cd "$PROJECT_ROOT"
npm run build

# 2. Sync only built artifacts to VM
echo "[2/4] Syncing built artifacts to VM..."
SSH_OPTS="-i ~/.ssh/gcp_key -o StrictHostKeyChecking=no"

rsync -avz -e "ssh ${SSH_OPTS}" \
  "$PROJECT_ROOT/dist/" \
  "${DEPLOY_TARGET}:${APP_DIR}/dist/"
rsync -avz -e "ssh ${SSH_OPTS}" \
  "$PROJECT_ROOT/src/dist-server/" \
  "${DEPLOY_TARGET}:${APP_DIR}/src/dist-server/"
rsync -avz -e "ssh ${SSH_OPTS}" \
  "$PROJECT_ROOT/package.json" \
  "$PROJECT_ROOT/package-lock.json" \
  "${DEPLOY_TARGET}:${APP_DIR}/"

# 3. Install production dependencies and restart service on the VM
echo "[3/4] Installing dependencies and restarting service..."
ssh -i ~/.ssh/gcp_key -o StrictHostKeyChecking=no "$DEPLOY_TARGET" << REMOTE_COMMANDS
cd ${APP_DIR}
npm ci --omit=dev
sudo systemctl restart playback
REMOTE_COMMANDS

# 4. Verify
echo "[4/4] Verifying deployment..."
sleep 3

# Try health check via Node.js directly (bypasses Caddy HTTPS redirect)
HTTP_STATUS=$(ssh -i ~/.ssh/gcp_key -o StrictHostKeyChecking=no "$DEPLOY_TARGET" \
  'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health' || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  echo ""
  echo "=== Deploy complete ==="
  echo "Site: https://playback.rachmat.pro"
else
  echo ""
  echo "=== Deploy finished, but health check returned HTTP ${HTTP_STATUS} ==="
  echo "Check logs: ssh ${DEPLOY_TARGET} 'journalctl -u playback -n 50'"
fi
