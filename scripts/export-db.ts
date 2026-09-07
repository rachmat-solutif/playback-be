/**
 * Export Playback MongoDB data and index schema as an Extended JSON snapshot.
 *
 * Usage: npm run db:export -- --output backups/mongodb-2026-07-30
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { connectDb, disconnectDb } from '../src/server/db/connection.js';
import {
  APPLICATION_COLLECTIONS,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  collectionFileName,
  resolveRequiredOption,
  usage,
  writeJsonFile,
  type SnapshotCollection,
  type SnapshotManifest,
} from './mongodb-snapshot.js';

async function prepareOutputDirectory(outputDir: string, force: boolean): Promise<void> {
  try {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      throw new Error(`Export output is not a directory: ${outputDir}`);
    }

    const entries = await fs.readdir(outputDir);
    if (entries.length > 0) {
      if (!force) {
        throw new Error(
          `Export output is not empty: ${outputDir}. Choose another directory or use --force.`,
        );
      }
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.mkdir(path.join(outputDir, 'collections'), { recursive: true });
}

async function exportSnapshot(outputDir: string, force: boolean): Promise<void> {
  await prepareOutputDirectory(outputDir, force);

  const db = await connectDb();
  try {
    const collections: SnapshotCollection[] = [];

    for (const name of APPLICATION_COLLECTIONS) {
      const exists =
        (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
      const collection = db.collection(name);
      const documents = exists ? await collection.find({}).sort({ _id: 1 }).toArray() : [];
      const indexes = exists ? await collection.listIndexes().toArray() : [];
      const documentsFile = collectionFileName(name);

      await writeJsonFile(path.join(outputDir, documentsFile), documents);
      collections.push({
        name,
        documentsFile,
        documentCount: documents.length,
        indexes,
      });

      console.log(`  ${name}: ${documents.length} documents, ${indexes.length} indexes`);
    }

    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      database: db.databaseName,
      createdAt: new Date(),
      collections,
    };
    await writeJsonFile(path.join(outputDir, 'manifest.json'), manifest);
    console.log(`\nExport complete: ${outputDir}`);
  } finally {
    await disconnectDb();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage('export'));
    return;
  }

  const outputOption = resolveRequiredOption(args, '--output');
  const remaining = outputOption.remaining;
  if (!outputOption.value) {
    throw new Error(usage('export'));
  }
  if (remaining.length > 0 && !(remaining.length === 1 && remaining[0] === '--force')) {
    throw new Error(`Unknown option: ${remaining[0]}\n\n${usage('export')}`);
  }

  const outputDir = path.resolve(process.cwd(), outputOption.value);
  const force = remaining.includes('--force');
  await exportSnapshot(outputDir, force);
}

main().catch((error) => {
  console.error('MongoDB export failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
