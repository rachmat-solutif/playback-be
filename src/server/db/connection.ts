import { MongoClient, Db } from 'mongodb';
import { config } from '../config.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export function getClient(): MongoClient {
  if (!client) {
    const isDirectSafe =
      (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')
      && !config.MONGO_URI.startsWith('mongodb+srv://');

    client = new MongoClient(config.MONGO_URI, {
      maxPoolSize: 10,
      directConnection: isDirectSafe,
    });
  }
  return client;
}

export async function connectDb(): Promise<Db> {
  if (db) return db;

  const c = getClient();
  await c.connect();
  db = c.db(); // Uses the database name from the connection string
  return db;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
