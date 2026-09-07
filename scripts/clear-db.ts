/**
 * Clear all collection data from the database without touching indexes or Docker.
 *
 * Usage: npm run db:clear
 */

import { connectDb, disconnectDb } from '../src/server/db/connection.js';

async function clearAll() {
  console.log('Clearing all collections...');

  const db = await connectDb();
  const collections = await db.listCollections().toArray();

  for (const col of collections) {
    if (col.type === 'collection') {
      const result = await db.collection(col.name).deleteMany({});
      console.log('  %s: %d documents removed', col.name, result.deletedCount);
    }
  }

  console.log('\nDone. All data cleared (indexes preserved).');
  await disconnectDb();
}

clearAll().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
