import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

export const MAX_AUDIO_SIZE = 500 * 1024 * 1024;

const AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'flac', 'webm']);

const FORMAT_BY_MIME: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
};

const MIME_BY_FORMAT: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

export const ALLOWED_AUDIO_TYPES = new Set(Object.keys(FORMAT_BY_MIME));

export class AudioSizeLimitError extends Error {
  constructor() {
    super(`Audio file exceeds max size of ${MAX_AUDIO_SIZE} bytes`);
    this.name = 'AudioSizeLimitError';
  }
}

export function limitAudioStream(stream: Readable, maxBytes = MAX_AUDIO_SIZE): Readable {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        callback(new AudioSizeLimitError());
        return;
      }
      callback(null, buffer);
    },
  });
  return stream.pipe(limiter);
}

export function getFormatFromMime(mime: string): string | undefined {
  return FORMAT_BY_MIME[mime.split(';', 1)[0].trim().toLowerCase()];
}

export function getMimeFromFormat(format: string): string | undefined {
  return MIME_BY_FORMAT[format.trim().toLowerCase()];
}

export function isAllowedAudioFormat(format: string): boolean {
  return AUDIO_FORMATS.has(format.trim().toLowerCase());
}

export function isAllowedAudioMime(mime: string): boolean {
  return ALLOWED_AUDIO_TYPES.has(mime.split(';', 1)[0].trim().toLowerCase());
}

export function validateBlobName(blobName: string): string {
  const value = blobName.trim();
  if (!value || value.length > 1024) {
    throw new Error('Blob name must contain between 1 and 1024 characters');
  }
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('A valid blob name must contain no invalid characters');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Blob name contains an invalid path segment');
  }

  return value;
}

export function createAudioBlobName(format: string): string {
  const normalizedFormat = format.trim().toLowerCase();
  if (!isAllowedAudioFormat(normalizedFormat)) {
    throw new Error(`Unsupported audio format: ${format}`);
  }
  return validateBlobName(`imports/${randomUUID()}.${normalizedFormat}`);
}

export function getFormatFromPath(pathname: string): string | undefined {
  const extension = pathname.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  return extension && isAllowedAudioFormat(extension) ? extension : undefined;
}
