import {
  agents,
  customers,
  tags,
  conversations,
  transcriptSegments,
  audioFiles,
  conversationMetrics,
} from './collections.js';

/**
 * Ensure all indexes exist on all collections.
 * Safe to call multiple times -- createIndex is idempotent.
 */
export async function ensureIndexes(): Promise<void> {
  const conv = await conversations();
  await conv.createIndex({ started_at: -1 });
  await conv.createIndex({ agent_id: 1 });
  await conv.createIndex({ customer_id: 1 });
  await conv.createIndex({ channel: 1 });
  await conv.createIndex({ status: 1 });
  await conv.createIndex({ tag_ids: 1 });
  await conv.createIndex({ duration_seconds: 1 });
  await conv.createIndex(
    { external_id: 1 },
    { unique: true, sparse: true, name: 'external_id_unique' }
  );

  const segments = await transcriptSegments();
  await segments.createIndex({ conversation_id: 1 });
  await segments.createIndex(
    { text: 'text' },
    { name: 'transcript_text_search' }
  );

  const audio = await audioFiles();
  await audio.createIndex({ conversation_id: 1 }, { unique: true });

  const metrics = await conversationMetrics();
  await metrics.createIndex({ conversation_id: 1 }, { unique: true });
  await metrics.createIndex({ sentiment_label: 1 });

  const cust = await customers();
  await cust.createIndex({ phone: 1 }, { unique: true });

  const ag = await agents();
  await ag.createIndex({ email: 1 }, { unique: true });

  const tg = await tags();
  await tg.createIndex({ label: 1 }, { unique: true });

  console.log('[OK] All indexes ensured');
}
