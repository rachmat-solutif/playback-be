import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { config, setConfig, resetConfig } from '../config.js';
import { generateSasUrl } from '../storage/blob.js';
import {
  AudioSizeLimitError,
  createAudioBlobName,
  limitAudioStream,
  validateBlobName,
} from '../storage/audio-policy.js';

const connectionString =
  `DefaultEndpointsProtocol=https;AccountName=stagingaudio;AccountKey=${Buffer.alloc(32, 7).toString('base64')};EndpointSuffix=core.windows.net`;

describe('Service SAS generation', () => {
  beforeEach(() => {
    setConfig('AZURE_STORAGE_CONNECTION_STRING', connectionString);
    setConfig('AZURE_STORAGE_CONTAINER', 'audio');
    setConfig('AUDIO_SAS_EXPIRY_MINUTES', 60);
    setConfig('AUDIO_SAS_CLOCK_SKEW_MINUTES', 5);
  });

  afterEach(() => {
    resetConfig();
  });

  it('creates a read-only HTTPS SAS scoped to one blob', () => {
    const before = Date.now();
    const url = generateSasUrl('recordings/conversation.wav');
    const after = Date.now();
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://stagingaudio.blob.core.windows.net');
    expect(parsed.pathname).toBe('/audio/recordings/conversation.wav');
    expect(parsed.searchParams.get('sp')).toBe('r');
    expect(parsed.searchParams.get('spr')).toBe('https');
    expect(parsed.searchParams.get('sr')).toBe('b');

    const startsOn = Date.parse(parsed.searchParams.get('st') || '');
    const expiresOn = Date.parse(parsed.searchParams.get('se') || '');
    expect(startsOn).toBeLessThanOrEqual(before - 4 * 60 * 1000);
    expect(expiresOn).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(expiresOn).toBeLessThanOrEqual(after + 61 * 60 * 1000);
  });

  it('rejects blob names containing a query string', () => {
    expect(() => generateSasUrl('recording.wav?sp=wd')).toThrow('valid blob name');
  });

  it('creates opaque names under the imports prefix', () => {
    const name = createAudioBlobName('mp3');
    expect(name).toMatch(/^imports\/[0-9a-f-]+\.mp3$/);
    expect(validateBlobName(name)).toBe(name);
  });

  it('rejects traversal-like blob names', () => {
    expect(() => validateBlobName('../secret.wav')).toThrow('invalid path segment');
    expect(() => validateBlobName('imports/../secret.wav')).toThrow('invalid path segment');
  });

  it('raises a size error when a stream exceeds its configured bound', async () => {
    const limited = limitAudioStream(Readable.from([Buffer.from('12345')]), 4);
    await expect(async () => {
      for await (const _chunk of limited) {
        // Consume until the limiter reports the error.
      }
    }).rejects.toBeInstanceOf(AudioSizeLimitError);
  });
});
