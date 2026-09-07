/**
 * Test setup helper.
 * Seeds a minimal dataset into the test DB and provides a Fastify app instance.
 */

import { ObjectId } from 'mongodb';
import { beforeAll, afterAll } from 'vitest';
import { connectDb, disconnectDb, getClient } from '../db/connection.js';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

// --- Deterministic test data ---

export const TEST_AGENT_1 = {
  _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
  name: 'Test Agent Alice',
  email: 'alice@company.com',
  team: 'Support',
};

export const TEST_AGENT_2 = {
  _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaab'),
  name: 'Test Agent Bob',
  email: 'bob@company.com',
  team: 'Billing',
};

export const TEST_CUSTOMER = {
  _id: new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'),
  name: 'Test Customer',
  email: 'customer@example.com',
  phone: '+1234567890',
  created_at: new Date('2026-01-01'),
};

export const TEST_TAG = {
  _id: new ObjectId('cccccccccccccccccccccccc'),
  label: 'Billing',
};

export const TEST_TAG_2 = {
  _id: new ObjectId('cccccccccccccccccccccccd'),
  label: 'Technical Support',
};

// 5 conversations: 3 calls, 1 chat, 1 email; across different dates and agents
export const TEST_CONVERSATIONS = [
  {
    _id: new ObjectId('dddddddddddddddddddddd01'),
    customer_id: TEST_CUSTOMER._id,
    agent_id: TEST_AGENT_1._id,
    channel: 'call' as const,
    started_at: new Date('2026-07-10T10:00:00Z'),
    ended_at: new Date('2026-07-10T10:05:00Z'),
    duration_seconds: 300,
    status: 'resolved' as const,
    tag_ids: [TEST_TAG._id],
    created_at: new Date('2026-07-10T10:00:00Z'),
  },
  {
    _id: new ObjectId('dddddddddddddddddddddd02'),
    customer_id: TEST_CUSTOMER._id,
    agent_id: TEST_AGENT_1._id,
    channel: 'call' as const,
    started_at: new Date('2026-07-11T14:00:00Z'),
    ended_at: new Date('2026-07-11T14:10:00Z'),
    duration_seconds: 600,
    status: 'escalated' as const,
    tag_ids: [TEST_TAG_2._id],
    created_at: new Date('2026-07-11T14:00:00Z'),
  },
  {
    _id: new ObjectId('dddddddddddddddddddddd03'),
    customer_id: TEST_CUSTOMER._id,
    agent_id: TEST_AGENT_2._id,
    channel: 'chat' as const,
    started_at: new Date('2026-07-11T16:00:00Z'),
    ended_at: new Date('2026-07-11T16:03:00Z'),
    duration_seconds: 180,
    status: 'resolved' as const,
    tag_ids: [TEST_TAG._id],
    created_at: new Date('2026-07-11T16:00:00Z'),
  },
  {
    _id: new ObjectId('dddddddddddddddddddddd04'),
    customer_id: TEST_CUSTOMER._id,
    agent_id: TEST_AGENT_2._id,
    channel: 'email' as const,
    started_at: new Date('2026-07-12T09:00:00Z'),
    ended_at: new Date('2026-07-12T09:08:00Z'),
    duration_seconds: 480,
    status: 'resolved' as const,
    tag_ids: [TEST_TAG._id],
    created_at: new Date('2026-07-12T09:00:00Z'),
  },
  {
    _id: new ObjectId('dddddddddddddddddddddd05'),
    customer_id: TEST_CUSTOMER._id,
    agent_id: TEST_AGENT_1._id,
    channel: 'call' as const,
    started_at: new Date('2026-07-15T11:00:00Z'),
    ended_at: new Date('2026-07-15T11:02:00Z'),
    duration_seconds: 120,
    status: 'resolved' as const,
    tag_ids: [TEST_TAG_2._id],
    created_at: new Date('2026-07-15T11:00:00Z'),
  },
];

export const TEST_TRANSCRIPT_SEGMENTS = [
  {
    _id: new ObjectId('eeeeeeeeeeeeeeeeeeeeee01'),
    conversation_id: TEST_CONVERSATIONS[0]._id,
    speaker: 'agent' as const,
    timestamp_seconds: 0,
    text: 'Hello, how can I help you today?',
  },
  {
    _id: new ObjectId('eeeeeeeeeeeeeeeeeeeeee02'),
    conversation_id: TEST_CONVERSATIONS[0]._id,
    speaker: 'customer' as const,
    timestamp_seconds: 5,
    text: 'I have a billing question about my invoice.',
  },
  {
    _id: new ObjectId('eeeeeeeeeeeeeeeeeeeeee03'),
    conversation_id: TEST_CONVERSATIONS[0]._id,
    speaker: 'agent' as const,
    timestamp_seconds: 15,
    text: 'Sure, let me pull up your account.',
  },
  {
    _id: new ObjectId('eeeeeeeeeeeeeeeeeeeeee04'),
    conversation_id: TEST_CONVERSATIONS[1]._id,
    speaker: 'agent' as const,
    timestamp_seconds: 0,
    text: 'Thank you for calling. What seems to be the issue?',
  },
  {
    _id: new ObjectId('eeeeeeeeeeeeeeeeeeeeee05'),
    conversation_id: TEST_CONVERSATIONS[1]._id,
    speaker: 'customer' as const,
    timestamp_seconds: 8,
    text: 'My internet connection keeps dropping.',
  },
];

export const TEST_AUDIO_FILES = TEST_CONVERSATIONS.map((conv, i) => ({
  _id: new ObjectId(`ffffffffffffffffffffffa${i}`),
  conversation_id: conv._id,
  url: '/audio/sample-call.wav',
  duration_seconds: conv.duration_seconds,
  format: 'wav',
}));

export const TEST_METRICS = [
  {
    _id: new ObjectId('111111111111111111111101'),
    conversation_id: TEST_CONVERSATIONS[0]._id,
    sentiment_score: 0.7,
    sentiment_label: 'positive' as const,
    handle_time_seconds: 310,
    first_response_seconds: 12,
  },
  {
    _id: new ObjectId('111111111111111111111102'),
    conversation_id: TEST_CONVERSATIONS[1]._id,
    sentiment_score: -0.8,
    sentiment_label: 'negative' as const,
    handle_time_seconds: 620,
    first_response_seconds: 5,
  },
  {
    _id: new ObjectId('111111111111111111111103'),
    conversation_id: TEST_CONVERSATIONS[2]._id,
    sentiment_score: 0.1,
    sentiment_label: 'neutral' as const,
    handle_time_seconds: 190,
    first_response_seconds: 30,
  },
  {
    _id: new ObjectId('111111111111111111111104'),
    conversation_id: TEST_CONVERSATIONS[3]._id,
    sentiment_score: 0.5,
    sentiment_label: 'positive' as const,
    handle_time_seconds: 490,
    first_response_seconds: 20,
  },
  {
    _id: new ObjectId('111111111111111111111105'),
    conversation_id: TEST_CONVERSATIONS[4]._id,
    sentiment_score: -0.6,
    sentiment_label: 'negative' as const,
    handle_time_seconds: 130,
    first_response_seconds: 8,
  },
];

// --- Setup / Teardown ---

let app: FastifyInstance;

export function getApp() {
  return app;
}

export async function setupTestDb() {
  const db = await connectDb();

  // Drop all collections
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }

  // Insert test data
  await db.collection('agents').insertMany([TEST_AGENT_1, TEST_AGENT_2]);
  await db.collection('customers').insertMany([TEST_CUSTOMER]);
  await db.collection('tags').insertMany([TEST_TAG, TEST_TAG_2]);
  await db.collection('conversations').insertMany(TEST_CONVERSATIONS);
  await db.collection('transcript_segments').insertMany(TEST_TRANSCRIPT_SEGMENTS);
  await db.collection('audio_files').insertMany(TEST_AUDIO_FILES);
  await db.collection('conversation_metrics').insertMany(TEST_METRICS);

  // Create text index for keyword search
  await db.collection('transcript_segments').createIndex({ text: 'text' });
  await db.collection('conversation_metrics').createIndex({ conversation_id: 1 });
  await db.collection('audio_files').createIndex({ conversation_id: 1 });
}

export async function globalSetup() {
  app = await buildApp({ disableAuth: true });
  await setupTestDb();
}

export async function globalTeardown() {
  if (app) await app.close();
  const client = getClient();
  const db = client.db();
  await db.dropDatabase();
  await disconnectDb();
}

// Helper to use in test files
export function useTestApp() {
  beforeAll(async () => {
    await globalSetup();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  return { getApp: () => app };
}
