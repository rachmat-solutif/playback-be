/**
 * Seed script for Playback database.
 * Uses mulberry32 PRNG for deterministic data (same seed = same data every run).
 * Matches the shape of the existing frontend mock in src/data/conversations.js.
 *
 * Usage: npm run db:seed
 */

import { ObjectId } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, disconnectDb } from '../src/server/db/connection.js';
import {
  containerExists,
  isBlobStorageConfigured,
  uploadAudio,
} from '../src/server/storage/blob.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_AUDIO_PATH = path.join(projectRoot, 'public', 'audio', 'sample-call.wav');
const SAMPLE_AUDIO_CONTENT_TYPE = 'audio/wav';

type AudioSeedDoc = {
  _id: ObjectId;
  conversation_id: ObjectId;
  url: string;
  blob_name?: string;
  duration_seconds: number;
  format: string;
};

// --- Deterministic PRNG (same as frontend mock) ---

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260706);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

// Deterministic ObjectId generation (based on index)
function makeId(index: number): ObjectId {
  const hex = index.toString(16).padStart(24, '0');
  return new ObjectId(hex);
}

// --- Constants (matching src/lib/constants.js) ---

const AGENT_NAMES = [
  'Maya Chen',
  'Diego Alvarez',
  'Priya Nair',
  'Sam Whitfield',
  'Tanya Brooks',
  'Omar Haddad',
];

const TAG_LABELS = [
  'Billing',
  'Technical Support',
  'Account',
  'Shipping',
  'Returns',
  'Cancellation',
  'Product Info',
];

const TEAMS = ['Support', 'Billing', 'Technical'];

const FIRST_NAMES = [
  'Jordan', 'Casey', 'Riley', 'Avery', 'Morgan',
  'Quinn', 'Harper', 'Rowan', 'Devon', 'Skyler',
  'Elena', 'Marcus', 'Nadia', 'Theo', 'Isla',
];

const LAST_NAMES = [
  'Reyes', 'Kim', 'Novak', 'Osei', 'Fischer',
  'Baptiste', 'Lindqvist', 'Costa', 'Iqbal', 'Moreau',
  'Bauer', 'Silva',
];

const CHANNELS = ['call', 'chat', 'email'] as const;
const STATUSES = ['resolved', 'resolved', 'resolved', 'escalated'] as const;

// Sample transcript phrases by speaker
const AGENT_PHRASES = [
  'Thank you for calling, how can I help you today?',
  'I understand your concern. Let me look into that for you.',
  'Can you please verify your account email address?',
  'I can see the issue on my end. Let me get that resolved.',
  'Is there anything else I can help you with?',
  'I\'ve updated your account with those changes.',
  'Let me transfer you to our specialist team for this.',
  'I apologize for the inconvenience. We\'ll get this sorted.',
  'Your refund has been processed and should appear in 3-5 days.',
  'I\'ve made a note on your account about this issue.',
  'Let me check the status of your order.',
  'That\'s a great question. Here\'s what I can tell you.',
  'I\'ve escalated this to our senior team for review.',
  'Thank you for your patience while I look into this.',
  'I\'ve sent a confirmation email to your address on file.',
];

const CUSTOMER_PHRASES = [
  'Hi, I\'m having a problem with my recent order.',
  'I was charged twice for my subscription.',
  'Can you help me reset my password?',
  'I\'d like to cancel my service please.',
  'When will my refund be processed?',
  'The product I received is damaged.',
  'I haven\'t received my shipping confirmation yet.',
  'I need to update my billing information.',
  'Why was my account suspended?',
  'I\'d like to upgrade my plan.',
  'The website keeps giving me an error.',
  'I need help setting up my new device.',
  'Can I get a discount on my next order?',
  'Thank you, that resolves my issue.',
  'Yes, that\'s all I needed. Thanks for your help!',
];

function assertGuard() {
  const guard = process.env.SEED_GUARD || process.argv.find((a) => a.startsWith('--guard='))?.split('=')[1];
  if (guard !== 'SAYASADAR') {
    console.error('Refusing to seed: set SEED_GUARD=SAYASADAR or --guard=SAYASADAR');
    console.error('Example: SEED_GUARD=SAYASADAR npm run db:seed:dummy');
    process.exit(1);
  }
}

// --- Generate data ---

async function seed() {
  assertGuard();
  console.log('Seeding database (legacy 160)...');

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

  // --- Agents ---
  const agentDocs = AGENT_NAMES.map((name, i) => ({
    _id: makeId(100 + i),
    name,
    email: `${name.toLowerCase().replace(' ', '.')}@company.com`,
    team: TEAMS[i % TEAMS.length],
  }));

  // --- Tags ---
  const tagDocs = TAG_LABELS.map((label, i) => ({
    _id: makeId(200 + i),
    label,
  }));

  // --- Customers ---
  const now = new Date();
  const customerDocs = Array.from({ length: 100 }, (_, i) => ({
    _id: makeId(1000 + i),
    name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    email: `customer${i}@example.com`,
    phone: `+1${between(1000000000, 9999999999)}`,
    created_at: new Date(now.getTime() - rand() * 90 * 24 * 60 * 60 * 1000),
  }));

  // --- Conversations + related data ---
  const conversationDocs: Record<string, unknown>[] = [];
  const segmentDocs: Record<string, unknown>[] = [];
  const audioDocs: AudioSeedDoc[] = [];
  const metricDocs: Record<string, unknown>[] = [];

  const refDate = new Date();
  refDate.setHours(23, 59, 0, 0);

  for (let i = 0; i < 160; i++) {
    const convId = makeId(1 + i);
    const agent = pick(agentDocs);
    const customer = pick(customerDocs);
    const tag = pick(tagDocs);

    // Spread conversations across the last 60 days
    const daysAgo = between(0, 59);
    const started = new Date(refDate);
    started.setDate(started.getDate() - daysAgo);

    // Bias toward working hours
    const hourPool = [8, 9, 9, 10, 10, 11, 11, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 18, 19, 20];
    started.setHours(pick(hourPool), between(0, 59), 0, 0);

    const durationSec = between(90, 900);
    const endedAt = new Date(started.getTime() + durationSec * 1000);
    const channel = pick([...CHANNELS]);
    const status = pick([...STATUSES]);

    conversationDocs.push({
      _id: convId,
      customer_id: customer._id,
      agent_id: agent._id,
      channel,
      started_at: started,
      ended_at: endedAt,
      duration_seconds: durationSec,
      status,
      tag_ids: [tag._id],
      created_at: started,
    });

    // --- Transcript segments (5-15 per conversation) ---
    const segmentCount = between(5, 15);
    const avgInterval = Math.floor(durationSec / segmentCount);

    for (let s = 0; s < segmentCount; s++) {
      const speaker = s % 2 === 0 ? 'agent' : 'customer';
      const phrases = speaker === 'agent' ? AGENT_PHRASES : CUSTOMER_PHRASES;
      segmentDocs.push({
        _id: new ObjectId(),
        conversation_id: convId,
        speaker,
        timestamp_seconds: Math.min(s * avgInterval + between(0, 10), durationSec),
        text: pick(phrases),
      });
    }

    // --- Audio file ---
    const audioBlobName = azureAudioEnabled ? `${convId.toHexString()}.wav` : undefined;
    audioDocs.push({
      _id: new ObjectId(),
      conversation_id: convId,
      url: `/audio/${audioBlobName || 'sample-call.wav'}`,
      ...(audioBlobName ? { blob_name: audioBlobName } : {}),
      duration_seconds: durationSec,
      format: 'wav',
    });

    // --- Conversation metrics ---
    const sentimentScore = +(rand() * 2 - 1).toFixed(2); // -1.00 to 1.00
    const sentimentLabel =
      sentimentScore > 0.3 ? 'positive' : sentimentScore < -0.3 ? 'negative' : 'neutral';

    metricDocs.push({
      _id: new ObjectId(),
      conversation_id: convId,
      sentiment_score: sentimentScore,
      sentiment_label: sentimentLabel,
      handle_time_seconds: durationSec + between(-30, 60), // slightly differ from raw duration
      first_response_seconds: between(5, 45),
    });
  }

  if (azureAudioEnabled) {
    console.log(`Uploading ${audioDocs.length} Azure audio blobs...`);
    for (let i = 0; i < audioDocs.length; i++) {
      const audio = audioDocs[i];
      if (!audio.blob_name) {
        throw new Error(`Missing Azure blob name for seeded conversation ${audio.conversation_id}`);
      }
      await uploadAudio(
        fs.createReadStream(SAMPLE_AUDIO_PATH),
        audio.blob_name,
        SAMPLE_AUDIO_CONTENT_TYPE,
        sampleAudioSize,
      );
      if ((i + 1) % 20 === 0 || i + 1 === audioDocs.length) {
        console.log(`  Uploaded ${i + 1}/${audioDocs.length} audio blobs`);
      }
    }
  }

  const db = await connectDb();

  // Drop existing data after external audio preparation succeeds.
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }
  console.log('  Dropped existing collections');

  await db.collection('agents').insertMany(agentDocs);
  console.log(`  ${agentDocs.length} agents`);

  await db.collection('tags').insertMany(tagDocs);
  console.log(`  ${tagDocs.length} tags`);

  await db.collection('customers').insertMany(customerDocs);
  console.log(`  ${customerDocs.length} customers`);

  await db.collection('conversations').insertMany(conversationDocs);
  console.log(`  ${conversationDocs.length} conversations`);

  await db.collection('transcript_segments').insertMany(segmentDocs);
  console.log(`  ${segmentDocs.length} transcript segments`);

  await db.collection('audio_files').insertMany(audioDocs);
  console.log(`  ${audioDocs.length} audio files`);

  await db.collection('conversation_metrics').insertMany(metricDocs);
  console.log(`  ${metricDocs.length} conversation metrics`);

  console.log('\nSeed complete!');
  await disconnectDb();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
