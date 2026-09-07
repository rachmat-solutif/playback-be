import { FastifyInstance, FastifyReply } from 'fastify';
import pino from 'pino';
import { ObjectId } from 'mongodb';
import { connectDb } from '../db/connection.js';
import { importSingleSchema, importBulkSchema, ImportSingleInput } from './import-schemas.js';
import { createJob, getJob, updateJob, ImportJobError } from './import-jobs.js';
import {
  blobExists,
  deleteBlob,
  isBlobStorageConfigured,
  uploadAudio,
} from '../storage/blob.js';
import { downloadRemoteAudio, RemoteAudioError } from '../storage/remote-audio.js';
import {
  ALLOWED_AUDIO_TYPES,
  AudioSizeLimitError,
  createAudioBlobName,
  getFormatFromMime,
  getMimeFromFormat,
  MAX_AUDIO_SIZE,
  validateBlobName,
} from '../storage/audio-policy.js';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const AUDIO_DIR = path.join(projectRoot, 'public', 'audio');

const BULK_CHUNK_SIZE = 500;
const MAX_FILE_SIZE = MAX_AUDIO_SIZE;

type ResolvedAudio = {
  url: string;
  format: string;
  blob_name?: string;
};

type AudioSourceResolution = {
  audio: ResolvedAudio;
  uploadedBlobName?: string;
};

function getFormatFromFilename(mime: string): string {
  return getFormatFromMime(mime) || 'wav';
}

function getBlobNameFromLegacyUrl(url: string): string | null {
  const match = url.match(/^\/?audio\/([^?]+)$/);
  if (!match) return null;
  try {
    return validateBlobName(match[1]);
  } catch {
    return null;
  }
}

async function resolveJsonAudio(
  audio: ImportSingleInput['audio'],
): Promise<AudioSourceResolution | undefined> {
  if (!audio) return undefined;

  if (audio.blob_name) {
    if (!isBlobStorageConfigured()) {
      throw new Error('blob_name audio sources require Azure Blob Storage configuration');
    }
    const blobName = validateBlobName(audio.blob_name);
    if (!(await blobExists(blobName))) {
      throw new Error('The specified Azure audio blob does not exist');
    }
    return {
      audio: { url: `/audio/${blobName}`, format: audio.format || 'wav', blob_name: blobName },
    };
  }

  if (audio.remote_url) {
    if (!isBlobStorageConfigured()) {
      throw new Error('remote_url audio sources require Azure Blob Storage configuration');
    }
    const download = await downloadRemoteAudio(audio.remote_url, audio.format);
    const format = download.format;
    const blobName = createAudioBlobName(format);
    await uploadAudio(download.stream, blobName, download.contentType);
    return {
      audio: { url: `/audio/${blobName}`, format, blob_name: blobName },
      uploadedBlobName: blobName,
    };
  }

  if (!audio.url) return undefined;

  if (isBlobStorageConfigured()) {
    const blobName = getBlobNameFromLegacyUrl(audio.url);
    if (!blobName) {
      throw new Error('Use blob_name for an existing Azure blob or remote_url for a remote audio URL');
    }
    if (!(await blobExists(blobName))) {
      throw new Error('The specified Azure audio blob does not exist');
    }
    return {
      audio: { url: `/audio/${blobName}`, format: audio.format || 'wav', blob_name: blobName },
    };
  }

  return {
    audio: { url: audio.url, format: audio.format || 'wav' },
  };
}

async function cleanupUploadedBlobs(blobNames: string[]): Promise<void> {
  await Promise.all(blobNames.map((blobName) => deleteBlob(blobName).catch(() => undefined)));
}

function sendImportError(reply: FastifyReply, error: unknown) {
  if (error instanceof AudioSizeLimitError) {
    return reply.status(413).send({ error: error.message });
  }
  if (error instanceof RemoteAudioError) {
    return reply.status(422).send({ error: error.message });
  }
  const message = error instanceof Error ? error.message : 'Import failed';
  return reply.status(422).send({ error: message });
}

/**
 * Insert a single conversation with all related documents.
 * Returns the new conversation _id on success, or throws on failure.
 */
async function insertConversation(
  input: ImportSingleInput,
  audioFile?: ResolvedAudio,
): Promise<string> {
  const db = await connectDb();
  const { conversation, transcript, metrics, audio } = input;

  // Resolve tag labels -> tag_ids (create if not exists)
  const tagIds: ObjectId[] = [];
  for (const label of conversation.tags) {
    const result = await db.collection('tags').findOneAndUpdate(
      { label },
      { $setOnInsert: { label } },
      { upsert: true, returnDocument: 'after' },
    );
    if (result) {
      tagIds.push(result._id);
    }
  }

  // Resolve agent by email -- create if not exists, update name/team if exists
  const agentData = conversation.agent;
  const agentResult = await db.collection('agents').findOneAndUpdate(
    { email: agentData.email },
    {
      $set: {
        name: agentData.name,
        ...(agentData.team ? { team: agentData.team } : {}),
        ...(agentData.avatar_url ? { avatar_url: agentData.avatar_url } : {}),
      },
      $setOnInsert: { email: agentData.email },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const agentId = agentResult!._id;

  // Resolve customer by phone -- create if not exists, update name/email if exists
  const customerData = conversation.customer;
  const customerResult = await db.collection('customers').findOneAndUpdate(
    { phone: customerData.phone },
    {
      $set: {
        name: customerData.name,
        ...(customerData.email ? { email: customerData.email } : {}),
      },
      $setOnInsert: { phone: customerData.phone, created_at: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const customerId = customerResult!._id;

  const startedAt = new Date(conversation.started_at);
  const endedAt = new Date(conversation.ended_at);
  const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

  // If external_id is provided, check for existing conversation and replace it
  let convId: ObjectId;
  if (conversation.external_id) {
    const existing = await db.collection('conversations').findOne(
      { external_id: conversation.external_id },
      { projection: { _id: 1 } },
    );

    if (existing) {
      convId = existing._id;
      // Delete old related data before replacing
      await db.collection('transcript_segments').deleteMany({ conversation_id: convId });
      await db.collection('conversation_metrics').deleteMany({ conversation_id: convId });
      await db.collection('audio_files').deleteMany({ conversation_id: convId });

      // Update the conversation document
      await db.collection('conversations').updateOne(
        { _id: convId },
        {
          $set: {
            customer_id: customerId,
            agent_id: agentId,
            channel: conversation.channel,
            started_at: startedAt,
            ended_at: endedAt,
            duration_seconds: durationSeconds,
            status: conversation.status,
            tag_ids: tagIds,
            external_id: conversation.external_id,
            updated_at: new Date(),
          },
        },
      );
    } else {
      convId = new ObjectId();
      await db.collection('conversations').insertOne({
        _id: convId,
        customer_id: customerId,
        agent_id: agentId,
        channel: conversation.channel,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: durationSeconds,
        status: conversation.status,
        tag_ids: tagIds,
        created_at: new Date(),
        external_id: conversation.external_id,
      });
    }
  } else {
    convId = new ObjectId();
    await db.collection('conversations').insertOne({
      _id: convId,
      customer_id: customerId,
      agent_id: agentId,
      channel: conversation.channel,
      started_at: startedAt,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      status: conversation.status,
      tag_ids: tagIds,
      created_at: new Date(),
    });
  }

  // Insert transcript segments
  if (transcript && transcript.length > 0) {
    const segmentDocs = transcript.map((seg) => ({
      _id: new ObjectId(),
      conversation_id: convId,
      speaker: seg.speaker,
      timestamp_seconds: seg.timestamp_seconds,
      text: seg.text,
    }));
    await db.collection('transcript_segments').insertMany(segmentDocs);
  }

  // Insert metrics (default to neutral if not provided)
  const resolvedMetrics = metrics || {
    sentiment_score: 0,
    sentiment_label: 'neutral' as const,
    handle_time_seconds: durationSeconds,
    first_response_seconds: 0,
  };
  await db.collection('conversation_metrics').insertOne({
    _id: new ObjectId(),
    conversation_id: convId,
    sentiment_score: resolvedMetrics.sentiment_score,
    sentiment_label: resolvedMetrics.sentiment_label,
    handle_time_seconds: resolvedMetrics.handle_time_seconds,
    first_response_seconds: resolvedMetrics.first_response_seconds,
  });

  // Insert audio -- prefer uploaded file, fall back to JSON audio reference
  const resolvedAudio = audioFile || audio;
  if (resolvedAudio) {
    if (!resolvedAudio.url) {
      throw new Error('Resolved audio source is missing a URL');
    }
    await db.collection('audio_files').insertOne({
      _id: new ObjectId(),
      conversation_id: convId,
      url: resolvedAudio.url,
      duration_seconds: durationSeconds,
      format: resolvedAudio.format || 'wav',
      ...(resolvedAudio.blob_name ? { blob_name: resolvedAudio.blob_name } : {}),
    });
  }

  return convId.toHexString();
}

/**
 * Process a bulk import in chunks, updating job progress.
 */
async function processBulkImport(
  jobId: string,
  items: ImportSingleInput[],
  log: pino.Logger,
): Promise<void> {
  updateJob(jobId, { status: 'processing' });

  const errors: ImportJobError[] = [];
  let imported = 0;

  for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BULK_CHUNK_SIZE);

    for (let j = 0; j < chunk.length; j++) {
      const index = i + j;
      let uploadedBlobName: string | undefined;
      try {
        const resolved = await resolveJsonAudio(chunk[j].audio);
        uploadedBlobName = resolved?.uploadedBlobName;
        await insertConversation(chunk[j], resolved?.audio);
        imported++;
      } catch (err) {
        if (uploadedBlobName) {
          await cleanupUploadedBlobs([uploadedBlobName]);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ index, message });
        log.warn(
          {
            data: { jobId, index, error: message },
          },
          'import job failed',
        );
      }
    }

    updateJob(jobId, { imported, errors: [...errors] });
  }

  if (errors.length === 0) {
    log.debug(
      {
        data: { jobId, imported },
      },
      'import job completed',
    );
  }

  updateJob(jobId, {
    status: errors.length === items.length ? 'failed' : 'complete',
    imported,
    errors,
    completed_at: new Date().toISOString(),
  });
}

export async function importRoutes(app: FastifyInstance) {
  // Register multipart for file upload support
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: 2 },
    attachFieldsToBody: false,
  });

  // Ensure audio directory exists for the local filesystem fallback only.
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }

  /**
   * POST /api/import
   * Import a single conversation.
   */
  app.post('/import', async (request, reply) => {
    request.log.debug(
      {
        data: { method: 'POST', path: '/api/import' },
      },
      'import job started',
    );

    let input: ImportSingleInput;
    let audioFile: ResolvedAudio | undefined;
    const uploadedBlobNames: string[] = [];

    const cleanup = async () => cleanupUploadedBlobs(uploadedBlobNames.splice(0));
    const fail = async (status: number, body: unknown) => {
      await cleanup();
      return reply.status(status).send(body);
    };

    const contentType = request.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Multipart: parse JSON from "data" field, file from "audio" field
      const parts = request.parts();
      let jsonData: string | undefined;

      try {
        for await (const part of parts) {
          if (part.type === 'field' && part.fieldname === 'data') {
            jsonData = part.value as string;
          } else if (part.type === 'file' && part.fieldname === 'data') {
            // Handle "data" sent as a file (e.g., curl -F "data=@file.json")
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk);
            }
            jsonData = Buffer.concat(chunks).toString('utf8');
          } else if (part.type === 'file' && part.fieldname === 'audio') {
            if (!ALLOWED_AUDIO_TYPES.has(part.mimetype.split(';', 1)[0].toLowerCase())) {
              return fail(400, { error: `Invalid audio type: ${part.mimetype}` });
            }

            const format = getFormatFromFilename(part.mimetype);
            if (isBlobStorageConfigured()) {
              const blobName = createAudioBlobName(format);
              await uploadAudio(
                Readable.from(part.file),
                blobName,
                part.mimetype.split(';', 1)[0].toLowerCase(),
              );
              uploadedBlobNames.push(blobName);

              if (part.file.truncated) {
                return fail(413, { error: `Audio file exceeds max size of ${MAX_FILE_SIZE} bytes` });
              }

              audioFile = { url: `/audio/${blobName}`, format, blob_name: blobName };
            } else {
              // Local disk fallback (development without Azure configuration)
              const fileName = `${new ObjectId().toHexString()}.${format}`;
              const filePath = path.join(AUDIO_DIR, fileName);
              await pipeline(part.file, fs.createWriteStream(filePath));

              if (part.file.truncated) {
                fs.unlinkSync(filePath);
                return fail(413, { error: `Audio file exceeds max size of ${MAX_FILE_SIZE} bytes` });
              }

              audioFile = { url: `/audio/${fileName}`, format };
            }
          }
        }
      } catch (error) {
        await cleanup();
        return sendImportError(reply, error);
      }

      if (!jsonData) {
        return fail(400, { error: 'Missing "data" field in multipart request' });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonData);
      } catch {
        return fail(400, { error: 'Invalid JSON in "data" field' });
      }

      const validated = importSingleSchema.safeParse(parsed);
      if (!validated.success) {
        request.log.warn(
          {
            data: { issues: validated.error.issues },
          },
          'Import payload rejected schema validation',
        );
        return fail(400, {
          error: 'Validation failed',
          details: validated.error.issues,
        });
      }
      input = validated.data;

      // If channel=call and no file uploaded and no audio in JSON, reject
      if (input.conversation.channel === 'call' && !audioFile && !input.audio) {
        return fail(400, {
          error: 'Audio is required when channel is "call". Provide audio.url, audio.blob_name, audio.remote_url, or attach a file.',
        });
      }
    } else {
      // JSON body
      const validated = importSingleSchema.safeParse(request.body);
      if (!validated.success) {
        request.log.warn(
          {
            data: { issues: validated.error.issues },
          },
          'Import payload rejected schema validation',
        );
        return fail(400, {
          error: 'Validation failed',
          details: validated.error.issues,
        });
      }
      input = validated.data;

      // For JSON-only submissions, audio is required when channel is "call"
      if (input.conversation.channel === 'call' && !input.audio) {
        return fail(400, {
          error: 'Audio is required when channel is "call". Provide audio.url, audio.blob_name, or audio.remote_url.',
        });
      }
    }

    try {
      if (!audioFile && input.audio) {
        const resolved = await resolveJsonAudio(input.audio);
        if (resolved) {
          audioFile = resolved.audio;
          if (resolved.uploadedBlobName) {
            uploadedBlobNames.push(resolved.uploadedBlobName);
          }
        }
      }

      const id = await insertConversation(input, audioFile);
      uploadedBlobNames.splice(0);
      request.log.debug(
        {
          data: { jobId: id },
        },
        'import job completed',
      );
      return reply.status(201).send({ id });
    } catch (err) {
      request.log.warn(
        {
          data: { err },
        },
        'import job failed',
      );
      await cleanup();
      return sendImportError(reply, err);
    }
  });

  /**
   * POST /api/import/bulk
   * Import multiple conversations (JSON only, no file attachments).
   * Returns immediately with a job ID, processes in background.
   */
  app.post('/import/bulk', async (request, reply) => {
    const parsed = importBulkSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn(
        {
          data: { issues: parsed.error.issues },
        },
        'Import payload rejected schema validation',
      );
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.issues,
      });
    }

    const job = createJob(parsed.data.conversations.length);

    request.log.debug(
      {
        data: { jobId: job.id, total: parsed.data.conversations.length },
      },
      'import job started',
    );

    // Fire and forget -- process in background with child logger for correlation
    const jobLogger = (request.log as pino.Logger).child({ data: { jobId: job.id } });
    setImmediate(() => {
      processBulkImport(job.id, parsed.data.conversations, jobLogger).catch(() => {
        updateJob(job.id, { status: 'failed', completed_at: new Date().toISOString() });
        jobLogger.error(
          {
            data: { jobId: job.id },
          },
          'Import job crashed',
        );
      });
    });

    return reply.status(202).send({ jobId: job.id });
  });

  /**
   * GET /api/import/jobs/:jobId
   * Poll import job status and progress.
   */
  app.get('/import/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    return reply.send({
      id: job.id,
      status: job.status,
      total: job.total,
      imported: job.imported,
      errors: job.errors,
      created_at: job.created_at,
      completed_at: job.completed_at,
    });
  });
}
