/**
 * Seed script for Playback database -- 1-row dummy (canonical).
 * Creates complete schema + indexes with 1 dummy conversation via phone (+62 Indonesia)
 * and 1 dummy user for login without Entra (AUTH_PROVIDER=dummy).
 *
 * Guarded: requires SEED_GUARD=SAYA_SADAR_DROPDB_{HH}:{MM} or --guard=SAYA_SADAR_DROPDB_{HH}:{MM} (destructive).
 * Current time guard, e.g. at 14:05 use SAYA_SADAR_DROPDB_14:05.
 * Usage: SEED_GUARD=SAYA_SADAR_DROPDB_$(date +%H:%M) npm run db:seed
 *        SEED_GUARD=SAYA_SADAR_DROPDB_14:05 npm run db:seed:dummy  # full dummy dataset 160 rows is seed-dummy.ts
 */

import { ObjectId } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from '../src/server/db/connection.js';
import { ensureIndexes } from '../src/server/db/indexes.js';
import {
  containerExists,
  isBlobStorageConfigured,
  uploadAudio,
} from '../src/server/storage/blob.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_AUDIO_PATH = path.join(projectRoot, 'public', 'audio', 'sample-call.wav');
const SAMPLE_AUDIO_CONTENT_TYPE = 'audio/wav';

function getExpectedGuard(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `SAYA_SADAR_DROPDB_${hh}:${mm}`;
}

function assertGuard() {
  const guard =
    process.env.SEED_GUARD ||
    process.argv.find((a) => a.startsWith('--guard='))?.split('=')[1];
  const expected = getExpectedGuard();
  if (guard !== expected) {
    console.error(`Refusing to seed: invalid guard "${guard ?? ''}"`);
    console.error(`Expected guard is "${expected}" (SAYA_SADAR_DROPDB_{HH}:{MM} for current time)`);
    console.error(`Example: SEED_GUARD=${expected} npm run db:seed`);
    console.error(`      or: npm run db:seed -- --guard=${expected}`);
    process.exit(1);
  }
}

async function seed() {
  assertGuard();
  console.log('Seeding database (1-row dummy)...');

  const azureAudioEnabled = isBlobStorageConfigured();
  let sampleAudioSize = 0;
  if (azureAudioEnabled) {
    if (!fs.existsSync(SAMPLE_AUDIO_PATH)) {
      throw new Error(`Azure audio seed source not found: ${SAMPLE_AUDIO_PATH}`);
    }
    sampleAudioSize = fs.statSync(SAMPLE_AUDIO_PATH).size;
    if (!(await containerExists())) {
      throw new Error(
        'Azure Blob container is unavailable; create AZURE_STORAGE_CONTAINER manually before seeding',
      );
    }
    console.log(`Azure Blob Storage configured; sample audio source: ${SAMPLE_AUDIO_PATH}`);
  }

  // --- Dummy IDs (deterministic, distinct range) ---
  const agentId = new ObjectId('000000000000000000000064');
  const customerId = new ObjectId('0000000000000000000000c8');
  const tagId = new ObjectId('0000000000000000000000ff');
  const conversationId = new ObjectId('000000000000000000000001');
  const userId = new ObjectId('0000000000000000000000a0');

  const agentDocs = [
    {
      _id: agentId,
      name: 'Agent Dummy',
      email: 'agent-dummy@company.com',
      team: 'Support',
    },
  ];

  const tagDocs = [
    {
      _id: tagId,
      label: 'General',
    },
  ];

  const customerDocs = [
    {
      _id: customerId,
      name: 'Customer Dummy',
      email: 'customer-dummy@example.com',
      phone: '+628123456789',
      created_at: new Date(),
    },
  ];

  const started = new Date();
  started.setHours(10, 0, 0, 0);
  const durationSec = 90;
  const endedAt = new Date(started.getTime() + durationSec * 1000);

  const conversationDocs = [
    {
      _id: conversationId,
      customer_id: customerId,
      agent_id: agentId,
      channel: 'call' as const,
      started_at: started,
      ended_at: endedAt,
      duration_seconds: durationSec,
      status: 'resolved' as const,
      tag_ids: [tagId],
      created_at: started,
    },
  ];

  const segmentDocs = [
    {
      _id: new ObjectId(),
      conversation_id: conversationId,
      speaker: 'agent' as const,
      timestamp_seconds: 2,
      text: 'Thank you for calling, how can I help you today?',
    },
    {
      _id: new ObjectId(),
      conversation_id: conversationId,
      speaker: 'customer' as const,
      timestamp_seconds: 45,
      text: 'Hi, I am having a problem with my recent order via phone.',
    },
  ];

  const audioBlobName = azureAudioEnabled ? `${conversationId.toHexString()}.wav` : undefined;
  const audioDocs = [
    {
      _id: new ObjectId(),
      conversation_id: conversationId,
      url: `/audio/${audioBlobName || 'sample-call.wav'}`,
      ...(audioBlobName ? { blob_name: audioBlobName } : {}),
      duration_seconds: durationSec,
      format: 'wav',
    },
  ];

  const metricDocs = [
    {
      _id: new ObjectId(),
      conversation_id: conversationId,
      sentiment_score: 0.2,
      sentiment_label: 'neutral' as const,
      handle_time_seconds: 95,
      first_response_seconds: 10,
    },
  ];

  const passwordHash = await bcrypt.hash('123456', 10);
  const userDocs = [
    {
      _id: userId,
      username: 'user',
      password_hash: passwordHash,
      role: 'user' as const,
      created_at: new Date(),
    },
  ];

  if (azureAudioEnabled) {
    const audio = audioDocs[0] as any;
    if (!audio.blob_name) throw new Error('Missing blob_name for dummy conversation');
    console.log('Uploading 1 Azure audio blob...');
    await uploadAudio(
      fs.createReadStream(SAMPLE_AUDIO_PATH),
      audio.blob_name,
      SAMPLE_AUDIO_CONTENT_TYPE,
      sampleAudioSize,
    );
    console.log('  Uploaded 1/1 audio blobs');
  }

  const db = await connectDb();

  // Drop existing data after external audio preparation succeeds.
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }
  console.log('  Dropped existing collections');

  await db.collection('agents').insertMany(agentDocs as any);
  console.log(`  ${agentDocs.length} agents (Agent Dummy)`);

  await db.collection('tags').insertMany(tagDocs as any);
  console.log(`  ${tagDocs.length} tags`);

  await db.collection('customers').insertMany(customerDocs as any);
  console.log(`  ${customerDocs.length} customers (Customer Dummy +628123456789)`);

  await db.collection('users').insertMany(userDocs as any);
  console.log(`  ${userDocs.length} users (user/123456)`);

  await db.collection('conversations').insertMany(conversationDocs as any);
  console.log(`  ${conversationDocs.length} conversations (call via phone +62)`);

  await db.collection('transcript_segments').insertMany(segmentDocs as any);
  console.log(`  ${segmentDocs.length} transcript segments`);

  await db.collection('audio_files').insertMany(audioDocs as any);
  console.log(`  ${audioDocs.length} audio files`);

  await db.collection('conversation_metrics').insertMany(metricDocs as any);
  console.log(`  ${metricDocs.length} conversation metrics`);

  await ensureIndexes();
  console.log('  Indexes ensured');

  console.log('\nSeed complete! Dummy conversation ready via phone (+62).');
  console.log('Login: POST /auth/login {username:"user", password:"123456"} (AUTH_PROVIDER=dummy)');
  await disconnectDb();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
