#!/usr/bin/env node
// Helper to run infra-gcloud commands from any directory
import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const infraDir = resolve(__dirname, '..', 'infra-gcloud');

const args = process.argv.slice(2);
const cmd = args.join(' ');

process.chdir(infraDir);
execSync(cmd, { stdio: 'inherit' });
