# MongoDB Snapshot Export and Import

Playback provides application-level MongoDB snapshots containing the seven
application collections, their BSON data, and their indexes. Snapshots use
MongoDB Extended JSON so `ObjectId` and `Date` values are preserved.

MongoDB does not enforce the TypeScript document interfaces as a relational
schema. The snapshot manifest records the collection list and actual index
schema. The application also runs its current `ensureIndexes` definitions after
an import.

Snapshots contain MongoDB metadata and conversation data only. They do not
contain audio bytes stored in Azure Blob Storage or files under `public/audio/`.
Keep snapshot directories out of source control because they may contain
customer names, phone numbers, transcripts, and other sensitive data.

## Export

Set `MONGO_URI` in the environment file loaded by the application, then choose
an output directory:

```bash
npm run db:export -- --output backups/mongodb-$(date -u +%Y%m%dT%H%M%SZ)
```

The export creates this structure:

```text
backups/mongodb-<timestamp>/
|-- manifest.json
+-- collections/
    |-- agents.json
    |-- customers.json
    |-- tags.json
    |-- conversations.json
    |-- transcript_segments.json
    |-- audio_files.json
    +-- conversation_metrics.json
```

The command refuses to overwrite a non-empty directory. Use `--force` only
when intentionally replacing an existing local snapshot directory:

```bash
npm run db:export -- --output backups/mongodb-existing --force
```

The export includes the current database name, document counts, collection
names, index definitions, and all documents in Extended JSON.

## Validate an import

Always validate a snapshot before changing MongoDB:

```bash
npm run db:import -- \
  --input backups/mongodb-<timestamp> \
  --dry-run
```

Validation checks the manifest format and version, known application
collections, expected data file paths, document counts, and the presence of an
`_id` on every document. It does not connect to MongoDB or change data.

## Merge import

The default import mode is `merge`. It upserts each snapshot document by
`_id`, keeps documents in other collections, and leaves non-snapshot documents
in the application collections in place:

```bash
npm run db:import -- \
  --input backups/mongodb-<timestamp>
```

Use merge only when that behavior is intended. Existing documents with the
same `_id` are replaced by the snapshot document.

## Replace import

Replace mode drops only the seven Playback application collections before
restoring the snapshot. It does not drop unrelated collections in the target
database, but it is still destructive and requires an explicit confirmation:

```bash
npm run db:import -- \
  --input backups/mongodb-<timestamp> \
  --mode replace \
  --yes
```

The import restores snapshot indexes and runs the application's current index
migration definitions. It does not create or upload Azure audio blobs. If the
snapshot's `audio_files` records reference Azure blobs, those blobs must already
exist in the target environment's configured private container.

Do not run replace import against staging or production until the target URI,
snapshot contents, and rollback plan have been reviewed. `npm run db:seed` is
also destructive because it drops and recreates the seeded database.

## Environment and credentials

The scripts load the same environment configuration as the server, including
`.env.development`, `.env.staging`, or `.env.production` based on `NODE_ENV`.
Never put a MongoDB URI in a command committed to source control, a snapshot,
logs, or documentation. Do not commit snapshot directories.
