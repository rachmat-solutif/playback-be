import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, setConfig, resetConfig } from '../config.js';
import { MAX_AUDIO_SIZE } from '../storage/audio-policy.js';
import {
  assertSafeRemoteUrl,
  downloadRemoteAudio,
  RemoteAudioError,
} from '../storage/remote-audio.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetConfig();
});

describe('remote audio downloader', () => {
  it('rejects private and loopback destinations', async () => {
    await expect(assertSafeRemoteUrl('https://127.0.0.1/call.wav')).rejects.toThrow(
      'blocked network address',
    );
    await expect(assertSafeRemoteUrl('https://192.168.1.10/call.wav')).rejects.toThrow(
      'blocked network address',
    );
  });

  it('rejects non-HTTPS URLs and credentials', async () => {
    await expect(assertSafeRemoteUrl('http://8.8.8.8/call.wav')).rejects.toThrow('HTTPS');
    await expect(assertSafeRemoteUrl('https://user:pass@8.8.8.8/call.wav')).rejects.toThrow(
      'credentials',
    );
  });

  it('downloads a supported bounded audio response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from('audio-data'), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
        }),
      ),
    );

    const result = await downloadRemoteAudio('https://8.8.8.8/call.mp3');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe('audio-data');
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.format).toBe('mp3');
  });

  it('rejects a non-audio response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not audio', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    await expect(downloadRemoteAudio('https://8.8.8.8/call.txt')).rejects.toThrow(
      'unsupported content type',
    );
  });

  it('rejects a response over the maximum size before downloading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: {
            'content-type': 'audio/wav',
            'content-length': String(MAX_AUDIO_SIZE + 1),
          },
        }),
      ),
    );

    await expect(downloadRemoteAudio('https://8.8.8.8/call.wav')).rejects.toThrow(
      'exceeds max size',
    );
  });

  it('validates every redirect target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1/private.wav' },
        }),
      ),
    );

    await expect(downloadRemoteAudio('https://8.8.8.8/redirect')).rejects.toThrow(
      'blocked network address',
    );
  });

  it('enforces the redirect limit', async () => {
    setConfig('REMOTE_AUDIO_MAX_REDIRECTS', 0);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://8.8.8.8/next.wav' },
        }),
      ),
    );

    await expect(downloadRemoteAudio('https://8.8.8.8/redirect')).rejects.toBeInstanceOf(
      RemoteAudioError,
    );
  });
});
