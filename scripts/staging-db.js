#!/usr/bin/env node
// Run database commands against the staging MongoDB by executing on the VM.
// SSH credentials and env vars are already present in /opt/playback/.env.
//
// Usage: node scripts/staging-db.js <seed|clear|indexes>

import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const infraDir = resolve(projectRoot, 'infra-gcloud');

const command = process.argv[2];
const validCommands = { seed: 'db:seed', clear: 'db:clear', indexes: 'db:indexes' };

if (!validCommands[command]) {
  console.error(`Usage: node scripts/staging-db.js <${Object.keys(validCommands).join('|')}>`);
  process.exit(1);
}

// Get deploy target from Pulumi (same pattern as deploy.sh)
let deployUser;
let externalIp;

try {
  deployUser = execSync('pulumi config get deployUser --stack staging 2>/dev/null || echo deploy', {
    cwd: infraDir,
    encoding: 'utf8',
  }).trim();
} catch {
  console.error('Failed to read deployUser from Pulumi config.');
  process.exit(1);
}

try {
  externalIp = execSync('pulumi stack output externalIp --stack staging', {
    cwd: infraDir,
    encoding: 'utf8',
  }).trim();
} catch {
  console.error('Failed to read externalIp from Pulumi stack output.');
  console.error('Make sure you have run: cd infra-gcloud && pulumi up --stack staging');
  process.exit(1);
}

const target = `${deployUser}@${externalIp}`;
const npmScript = validCommands[command];

console.log(`Running "npm run ${npmScript}" against staging VM...`);
console.log(`SSH target: ${target}\n`);

execSync(`ssh -i ~/.ssh/gcp_key -o StrictHostKeyChecking=no ${target} 'cd /opt/playback && npm run ${npmScript}'`, {
  stdio: 'inherit',
});
