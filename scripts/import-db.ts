/**
 * Import a Playback MongoDB Extended JSON snapshot.
 *
 * Merge is the default and upserts documents by _id. Replace is destructive
 * and requires both --mode replace and --yes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId, type Document, type IndexSpecification } from 'mongodb';
import { connectDb, disconnectDb } from '../src/server/db/connection.js';
import { ensureIndexes } from '../src/server/db/indexes.js';
import {
  APPLICATION_COLLECTIONS,
  assertSnapshotManifest,
  collectionFileName,
  deserializeEjson,
  readJsonFile,
  resolveRequiredOption,
  resolveSnapshotFile,
  usage,
  type SnapshotCollection,
  type SnapshotManifest,
} from './mongodb-snapshot.js';

type ImportedDocument = Document & { _id: ObjectId };
type ImportMode = 'merge' | 'replace';

interface LoadedCollection extends SnapshotCollection {
  documents: ImportedDocument[];
}

interface LoadedSnapshot {
  manifest: SnapshotManifest;
  collections: LoadedCollection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function loadSnapshot(snapshotDir: string): Promise<LoadedSnapshot> {
  const manifestPath = resolveSnapshotFile(snapshotDir, 'manifest.json');
  const manifest = await readJsonFile<unknown>(manifestPath);
  assertSnapshotManifest(manifest);

  const collections: LoadedCollection[] = [];
  for (const entry of manifest.collections) {
    const filePath = resolveSnapshotFile(snapshotDir, entry.documentsFile);
    const documents = deserializeEjson<unknown>(await fs.readFile(filePath, 'utf8'));
    if (!Array.isArray(documents)) {
      throw new Error(`Snapshot data file is not an array: ${entry.documentsFile}`);
    }
    if (documents.length !== entry.documentCount) {
      throw new Error(
        `Document count mismatch for ${entry.name}: manifest says ${entry.documentCount}, file contains ${documents.length}`,
      );
    }

    for (const [index, document] of documents.entries()) {
      if (!isRecord(document) || !Object.prototype.hasOwnProperty.call(document, '_id')) {
        throw new Error(`${entry.documentsFile} document ${index} is missing _id`);
      }
    }

    collections.push({
      ...entry,
      documents: documents as ImportedDocument[],
    });
  }

  return { manifest, collections };
}

async function dropApplicationCollections(db: Awaited<ReturnType<typeof connectDb>>): Promise<void> {
  for (const name of APPLICATION_COLLECTIONS) {
    const collection = db.collection(name);
    try {
      await collection.drop();
      console.log(`  Dropped ${name}`);
    } catch (error) {
      if ((error as { code?: number }).code !== 26) {
        throw error;
      }
    }
  }
}

async function importCollection(
  db: Awaited<ReturnType<typeof connectDb>>,
  collection: LoadedCollection,
  mode: ImportMode,
): Promise<void> {
  const target = db.collection(collection.name);
  if (collection.documents.length === 0) {
    console.log(`  ${collection.name}: 0 documents`);
    return;
  }

  if (mode === 'replace') {
    await target.insertMany(collection.documents);
    console.log(`  ${collection.name}: inserted ${collection.documents.length} documents`);
    return;
  }

  await target.bulkWrite(
    collection.documents.map((document) => ({
      replaceOne: {
        filter: { _id: document._id },
        replacement: document,
        upsert: true,
      },
    })),
    { ordered: true },
  );
  console.log(`  ${collection.name}: merged ${collection.documents.length} documents`);
}

async function restoreAdditionalIndexes(
  db: Awaited<ReturnType<typeof connectDb>>,
  collection: LoadedCollection,
): Promise<void> {
  const target = db.collection(collection.name);
  const existingIndexes = await target.listIndexes().toArray();
  const existingNames = new Set(existingIndexes.map((index) => index.name));

  for (const rawIndex of collection.indexes) {
    if (!isRecord(rawIndex) || rawIndex.name === '_id_') {
      continue;
    }
    if (typeof rawIndex.name === 'string' && existingNames.has(rawIndex.name)) {
      continue;
    }
    if (!isRecord(rawIndex.key)) {
      throw new Error(`Invalid index definition for ${collection.name}`);
    }

    const indexOptions = { ...rawIndex };
    delete indexOptions.key;
    delete indexOptions.v;
    delete indexOptions.ns;
    await target.createIndex(
      rawIndex.key as IndexSpecification,
      indexOptions as Parameters<typeof target.createIndex>[1],
    );
    console.log(`  ${collection.name}: restored index ${String(rawIndex.name)}`);
  }
}

async function importSnapshot(
  snapshot: LoadedSnapshot,
  snapshotDir: string,
  mode: ImportMode,
): Promise<void> {
  const db = await connectDb();
  try {
    console.log(`Importing snapshot from ${snapshotDir}`);
    console.log(`Source database: ${snapshot.manifest.database}`);
    console.log(`Target database: ${db.databaseName}`);
    console.log(`Mode: ${mode}`);

    if (mode === 'replace') {
      console.log('Replacing the seven Playback application collections...');
      await dropApplicationCollections(db);
    }

    for (const collection of snapshot.collections) {
      await importCollection(db, collection, mode);
    }

    await ensureIndexes();
    for (const collection of snapshot.collections) {
      await restoreAdditionalIndexes(db, collection);
    }

    console.log('\nImport complete.');
  } finally {
    await disconnectDb();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage('import'));
    return;
  }

  const inputOption = resolveRequiredOption(args, '--input');
  if (!inputOption.value) {
    throw new Error(usage('import'));
  }

  const modeOption = resolveRequiredOption(inputOption.remaining, '--mode');
  const mode = (modeOption.value || 'merge') as ImportMode;
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`Invalid import mode: ${mode}\n\n${usage('import')}`);
  }

  const remaining = modeOption.remaining;
  const allowedFlags = new Set(['--yes', '--dry-run']);
  const unknownFlag = remaining.find((arg) => !allowedFlags.has(arg));
  if (unknownFlag) {
    throw new Error(`Unknown option: ${unknownFlag}\n\n${usage('import')}`);
  }

  const replaceConfirmed = remaining.includes('--yes');
  const dryRun = remaining.includes('--dry-run');
  if (mode === 'replace' && !replaceConfirmed) {
    throw new Error('Replace mode is destructive; rerun with --mode replace --yes');
  }

  const snapshotDir = path.resolve(process.cwd(), inputOption.value);
  const snapshot = await loadSnapshot(snapshotDir);
  const totalDocuments = snapshot.collections.reduce(
    (total, collection) => total + collection.documents.length,
    0,
  );

  if (dryRun) {
    console.log(`Snapshot is valid: ${snapshotDir}`);
    console.log(`Source database: ${snapshot.manifest.database}`);
    console.log(`Collections: ${snapshot.collections.length}`);
    console.log(`Documents: ${totalDocuments}`);
    console.log(`Mode: ${mode} (dry run; no database changes made)`);
    return;
  }

  await importSnapshot(snapshot, snapshotDir, mode);
}

main().catch((error) => {
  console.error('MongoDB import failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
