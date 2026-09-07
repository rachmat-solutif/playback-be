import { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { connectDb } from '../db/connection.js';
import { isBlobStorageConfigured, generateSasUrl } from '../storage/blob.js';
import { getSession } from '../auth/session.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const publicRoot = path.resolve(projectRoot, 'public');

type AudioRecord = {
  url?: unknown;
  blob_name?: unknown;
  format?: unknown;
};

type ByteRange = { start: number; end: number };

function resolveBlobName(audioFile: AudioRecord): string | null {
  if (typeof audioFile.blob_name === 'string' && audioFile.blob_name.trim()) {
    return audioFile.blob_name.trim();
  }

  if (typeof audioFile.url !== 'string') return null;
  const match = audioFile.url.match(/\/audio\/([^?]+)(?:\?.*)?$/);
  return match?.[1] || null;
}

function getContentType(audioFile: AudioRecord, filePath: string): string {
  const format = typeof audioFile.format === 'string' ? audioFile.format.toLowerCase() : '';
  const byFormat: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
  };

  return byFormat[format] || {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function parseRangeHeader(rangeHeader: string, size: number): ByteRange | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return null;

  const requestedStart = match[1] === '' ? null : Number(match[1]);
  const requestedEnd = match[2] === '' ? null : Number(match[2]);
  if (
    (requestedStart !== null && !Number.isSafeInteger(requestedStart)) ||
    (requestedEnd !== null && !Number.isSafeInteger(requestedEnd))
  ) {
    return null;
  }

  if (requestedStart === null) {
    const suffixLength = requestedEnd || 0;
    if (suffixLength <= 0) return null;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  if (requestedStart >= size) return null;
  return {
    start: requestedStart,
    end: Math.min(requestedEnd ?? size - 1, size - 1),
  };
}

export async function audioRoutes(app: FastifyInstance) {
  /**
   * GET /api/audio/:conversationId
   *
   * Azure environments return a short-lived JSON SAS URL. The browser then
   * fetches the audio directly from the private Blob container.
   * Local development streams files from public/audio/ and supports Range.
   */
  app.get(
    '/audio/:conversationId',
    {
      schema: {
        tags: ['Audio'],
        summary: 'Get audio URL or stream',
        params: z.object({ conversationId: z.string().min(1).describe('Conversation ObjectId') }),
      },
    },
    async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };

    let objectId: ObjectId;
    try {
      objectId = new ObjectId(conversationId);
    } catch {
      return reply.status(400).send({ error: 'Invalid conversation ID' });
    }

    const db = await connectDb();
    const audioFile = (await db
      .collection('audio_files')
      .findOne({ conversation_id: objectId })) as AudioRecord | null;

    if (!audioFile) {
      return reply.status(404).send({ error: 'Audio not found for this conversation' });
    }

    if (isBlobStorageConfigured()) {
      const blobName = resolveBlobName(audioFile);
      if (!blobName) {
        request.log.debug(
          {
            data: { conversationId },
          },
          'audio file not found',
        );
        return reply.status(404).send({ error: 'Audio blob is not configured' });
      }

      try {
        request.log.debug(
          {
            data: {
              conversationId,
              blobName,
              storageType: 'blob',
            },
          },
          'audio file resolved',
        );

        const url = generateSasUrl(blobName);
        const session = getSession(request.session);
        request.log.info(
          {
            data: {
              userId: session?.userId,
              conversationId,
              blobName,
            },
          },
          'SAS URL generated',
        );
        return reply.send({ url });
      } catch {
        request.log.error(
          {
            data: { conversationId, blobName },
          },
          'SAS generation failed',
        );
        return reply.status(503).send({ error: 'Audio storage unavailable' });
      }
    }

    if (typeof audioFile.url !== 'string' || !audioFile.url) {
      request.log.debug(
        {
          data: { conversationId },
        },
        'audio file not found',
      );
      return reply.status(404).send({ error: 'Audio file is not configured' });
    }

    const relativePath = audioFile.url.replace(/^[/\\]+/, '');
    const filePath = path.resolve(publicRoot, relativePath);
    if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
      return reply.status(404).send({ error: 'Audio file not found on disk' });
    }

    if (!fs.existsSync(filePath)) {
      request.log.debug(
        {
          data: { conversationId, filePath },
        },
        'audio file not found',
      );
      return reply.status(404).send({ error: 'Audio file not found on disk' });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return reply.status(404).send({ error: 'Audio file not found on disk' });
    }

    request.log.debug(
      {
        data: {
          conversationId,
          blobName: path.basename(filePath),
          storageType: 'disk',
        },
      },
      'audio file resolved',
    );

    reply.header('Content-Type', getContentType(audioFile, filePath));
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Range');

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, stat.size);
      if (!range || range.start > range.end) {
        reply.header('Content-Range', `bytes */${stat.size}`);
        return reply.status(416).send();
      }

      const chunkSize = range.end - range.start + 1;
      reply.status(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header('Content-Length', chunkSize);
      return reply.send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
    }

    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(filePath));
  });
}
