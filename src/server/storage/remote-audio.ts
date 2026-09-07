import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import {
  getFormatFromMime,
  getFormatFromPath,
  getMimeFromFormat,
  limitAudioStream,
  MAX_AUDIO_SIZE,
} from './audio-policy.js';
import { AudioSizeLimitError } from './audio-policy.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADER_TIMEOUT_MS = 15_000;

export class RemoteAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteAudioError';
  }
}

export interface RemoteAudioDownload {
  stream: Readable;
  contentType: string;
  format: string;
  finalUrl: string;
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return true;

  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  const third = (value >>> 8) & 255;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isBlockedIpv4(mapped);
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  if (net.isIP(normalized) === 4) return isBlockedIpv4(normalized);
  if (net.isIP(normalized) === 6) return isBlockedIpv6(normalized);
  return true;
}

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteAudioError('Remote audio URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw new RemoteAudioError('Remote audio URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new RemoteAudioError('Remote audio URL must not contain credentials');
  }
  if (url.hash) {
    throw new RemoteAudioError('Remote audio URL must not contain a fragment');
  }
  if (!url.hostname) {
    throw new RemoteAudioError('Remote audio URL must contain a hostname');
  }

  let addresses: string[];
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map(
        (entry) => entry.address,
      );
    } catch {
      throw new RemoteAudioError('Remote audio hostname could not be resolved');
    }
  }

  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new RemoteAudioError('Remote audio URL resolves to a blocked network address');
  }

  return url;
}

function getResponseContentType(response: Response, url: URL, formatHint?: string): {
  contentType: string;
  format: string;
} {
  const header = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const responseFormat = getFormatFromMime(header);
  if (!responseFormat && header && header !== 'application/octet-stream') {
    throw new RemoteAudioError('Remote audio response has an unsupported content type');
  }
  const pathFormat = getFormatFromPath(url.pathname);
  const hint = formatHint?.trim().toLowerCase();
  const format = responseFormat || pathFormat || hint;

  if (!format) {
    throw new RemoteAudioError('Remote audio response does not identify a supported audio format');
  }

  const contentType = responseFormat ? header : getMimeFromFormat(format);
  if (!contentType) {
    throw new RemoteAudioError('Remote audio response has an unsupported content type');
  }

  if (!responseFormat && header && header !== 'application/octet-stream') {
    throw new RemoteAudioError('Remote audio response has an unsupported content type');
  }

  return { contentType, format };
}

export async function downloadRemoteAudio(
  rawUrl: string,
  formatHint?: string,
): Promise<RemoteAudioDownload> {
  let currentUrl = rawUrl;
  let redirects = 0;

  while (true) {
    const safeUrl = await assertSafeRemoteUrl(currentUrl);
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(safeUrl, {
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof RemoteAudioError) throw error;
      throw new RemoteAudioError('Remote audio request failed');
    } finally {
      clearTimeout(headerTimer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects >= config.REMOTE_AUDIO_MAX_REDIRECTS) {
        throw new RemoteAudioError('Remote audio redirect limit was exceeded');
      }
      currentUrl = new URL(location, safeUrl).toString();
      redirects++;
      continue;
    }

    if (!response.ok) {
      throw new RemoteAudioError(`Remote audio server returned HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_AUDIO_SIZE) {
        throw new AudioSizeLimitError();
      }
    }

    if (!response.body) {
      throw new RemoteAudioError('Remote audio response has no body');
    }

    const { contentType, format } = getResponseContentType(response, safeUrl, formatHint);
    const source = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
    );
    const limitedStream = limitAudioStream(source);
    const totalTimer = setTimeout(() => {
      controller.abort();
      source.destroy(new RemoteAudioError('Remote audio download timed out'));
    }, config.REMOTE_AUDIO_TIMEOUT_SECONDS * 1000);

    const clearTimer = () => clearTimeout(totalTimer);
    limitedStream.once('end', clearTimer);
    limitedStream.once('error', clearTimer);
    limitedStream.once('close', clearTimer);

    return {
      stream: limitedStream,
      contentType,
      format,
      finalUrl: safeUrl.toString(),
    };
  }
}
