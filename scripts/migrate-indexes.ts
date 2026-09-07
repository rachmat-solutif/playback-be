/**
 * Index migration script for Playback database.
 * Drops all non-_id indexes then recreates them from definitions in src/server/db/indexes.ts.
 *
 * Usage: npm run db:indexes
 */

import { connectDb, disconnectDb } from '../src/server/db/connection.js';
import { ensureIndexes } from '../src/server/db/indexes.js';

async function migrateIndexes() {
  console.log('Rebuilding indexes...');

  const db = await connectDb();

  // Drop all non-_id indexes on every collection
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    if (col.type === 'collection') {
      await db.collection(col.name).dropIndexes();
    }
  }
  console.log('  Dropped all non-_id indexes');

  // Recreate from definitions
  await ensureIndexes();

  console.log('\nIndex rebuild complete!');
  await disconnectDb();
}

migrateIndexes().catch((err) => {
  console.error('[ERROR]  Index migration failed:', err);
  process.exit(1);
});
