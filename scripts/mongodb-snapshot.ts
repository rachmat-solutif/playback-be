import { BSON } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';

const { EJSON } = BSON;

export const SNAPSHOT_FORMAT = 'playback-mongodb-snapshot';
export const SNAPSHOT_VERSION = 1;

export const APPLICATION_COLLECTIONS = [
  'agents',
  'customers',
  'tags',
  'conversations',
  'transcript_segments',
  'audio_files',
  'conversation_metrics',
] as const;

export type SnapshotIndex = Record<string, unknown>;

export interface SnapshotCollection {
  name: string;
  documentsFile: string;
  documentCount: number;
  indexes: SnapshotIndex[];
}

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  database: string;
  createdAt: Date;
  collections: SnapshotCollection[];
}

export function serializeEjson(value: unknown): string {
  return EJSON.stringify(value, undefined, 2, { relaxed: false });
}

export function deserializeEjson<T>(value: string): T {
  return EJSON.parse(value) as T;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return deserializeEjson<T>(await fs.readFile(filePath, 'utf8'));
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${serializeEjson(value)}\n`, 'utf8');
}

export function collectionFileName(name: string): string {
  return `collections/${name}.json`;
}

export function isApplicationCollection(name: string): boolean {
  return (APPLICATION_COLLECTIONS as readonly string[]).includes(name);
}

export function usage(command: 'export' | 'import'): string {
  if (command === 'export') {
    return [
      'Usage: npm run db:export -- --output <directory> [--force]',
      '',
      'Options:',
      '  --output <directory>  Directory to create for the snapshot (required)',
      '  --force                Replace an existing non-empty output directory',
      '  --help                 Show this help',
    ].join('\n');
  }

  return [
    'Usage: npm run db:import -- --input <directory> [--mode merge|replace] [--yes] [--dry-run]',
    '',
    'Options:',
    '  --input <directory>  Snapshot directory to import (required)',
    '  --mode merge         Upsert snapshot documents and keep other data (default)',
    '  --mode replace       Drop and restore the seven application collections',
    '  --yes                Required with --mode replace',
    '  --dry-run            Validate and report counts without changing MongoDB',
    '  --help               Show this help',
  ].join('\n');
}

export function resolveRequiredOption(
  args: string[],
  option: string,
): { value: string | undefined; remaining: string[] } {
  const index = args.indexOf(option);
  if (index === -1) {
    return { value: undefined, remaining: args };
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }

  return {
    value,
    remaining: [...args.slice(0, index), ...args.slice(index + 2)],
  };
}

export function assertSnapshotManifest(value: unknown): asserts value is SnapshotManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Snapshot manifest must be an object');
  }

  const manifest = value as Partial<SnapshotManifest>;
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported snapshot format or version; expected ${SNAPSHOT_FORMAT} v${SNAPSHOT_VERSION}`,
    );
  }

  if (typeof manifest.database !== 'string' || !manifest.database) {
    throw new Error('Snapshot manifest is missing its database name');
  }

  if (!Array.isArray(manifest.collections)) {
    throw new Error('Snapshot manifest is missing its collections');
  }

  const names = new Set<string>();
  for (const collection of manifest.collections) {
    if (!collection || typeof collection !== 'object') {
      throw new Error('Snapshot manifest contains an invalid collection entry');
    }

    const entry = collection as Partial<SnapshotCollection>;
    if (
      typeof entry.name !== 'string' ||
      !isApplicationCollection(entry.name) ||
      names.has(entry.name) ||
      typeof entry.documentsFile !== 'string' ||
      !Array.isArray(entry.indexes) ||
      typeof entry.documentCount !== 'number'
    ) {
      throw new Error('Snapshot manifest contains an invalid or duplicate collection entry');
    }

    const expectedFile = collectionFileName(entry.name);
    if (entry.documentsFile !== expectedFile) {
      throw new Error(`Snapshot collection ${entry.name} has an unexpected documents file`);
    }

    names.add(entry.name);
  }
}

export function resolveSnapshotFile(snapshotDir: string, relativePath: string): string {
  const root = path.resolve(snapshotDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Snapshot file escapes the snapshot directory: ${relativePath}`);
  }
  return resolved;
}
