import { Collection, ObjectId } from 'mongodb';
import { connectDb } from './connection.js';

// --- Document types (matching docs/DB_SCHEMA.md) ---

export interface AgentDoc {
  _id: ObjectId;
  name: string;
  email: string;
  team: string;
  avatar_url?: string;
}

export interface CustomerDoc {
  _id: ObjectId;
  name: string;
  email: string;
  phone: string | null;
  created_at: Date;
}

export interface TagDoc {
  _id: ObjectId;
  label: string;
}

export interface ConversationDoc {
  _id: ObjectId;
  customer_id: ObjectId;
  agent_id: ObjectId;
  channel: 'call' | 'chat' | 'email';
  started_at: Date;
  ended_at: Date;
  duration_seconds: number;
  status: 'resolved' | 'unresolved' | 'escalated';
  tag_ids: ObjectId[];
  created_at: Date;
}

export interface TranscriptSegmentDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  speaker: 'agent' | 'customer';
  timestamp_seconds: number;
  text: string;
}

export interface AudioFileDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  url: string;
  blob_name?: string;
  duration_seconds: number;
  format: string;
}

export interface ConversationMetricDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  sentiment_score: number;
  sentiment_label: 'positive' | 'neutral' | 'negative';
  handle_time_seconds: number;
  first_response_seconds: number;
}

export interface UserDoc {
  _id: ObjectId;
  username: string;
  password_hash: string;
  role: 'user';
  created_at: Date;
}

// --- Collection accessors ---

export async function agents(): Promise<Collection<AgentDoc>> {
  const db = await connectDb();
  return db.collection<AgentDoc>('agents');
}

export async function customers(): Promise<Collection<CustomerDoc>> {
  const db = await connectDb();
  return db.collection<CustomerDoc>('customers');
}

export async function tags(): Promise<Collection<TagDoc>> {
  const db = await connectDb();
  return db.collection<TagDoc>('tags');
}

export async function conversations(): Promise<Collection<ConversationDoc>> {
  const db = await connectDb();
  return db.collection<ConversationDoc>('conversations');
}

export async function transcriptSegments(): Promise<Collection<TranscriptSegmentDoc>> {
  const db = await connectDb();
  return db.collection<TranscriptSegmentDoc>('transcript_segments');
}

export async function audioFiles(): Promise<Collection<AudioFileDoc>> {
  const db = await connectDb();
  return db.collection<AudioFileDoc>('audio_files');
}

export async function conversationMetrics(): Promise<Collection<ConversationMetricDoc>> {
  const db = await connectDb();
  return db.collection<ConversationMetricDoc>('conversation_metrics');
}

export async function users(): Promise<Collection<UserDoc>> {
  const db = await connectDb();
  return db.collection<UserDoc>('users');
}
