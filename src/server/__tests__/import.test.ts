import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb } from '../db/connection.js';
import { config, setConfig, resetConfig } from '../config.js';
import { useTestApp } from './setup.js';

const mocks = vi.hoisted(() => ({
  isBlobStorageConfigured: vi.fn(),
  blobExists: vi.fn(),
  deleteBlob: vi.fn(),
  uploadAudio: vi.fn(),
  generateSasUrl: vi.fn(),
  downloadRemoteAudio: vi.fn(),
}));

vi.mock('../storage/blob.js', () => ({
  isBlobStorageConfigured: mocks.isBlobStorageConfigured,
  blobExists: mocks.blobExists,
  deleteBlob: mocks.deleteBlob,
  uploadAudio: mocks.uploadAudio,
  generateSasUrl: mocks.generateSasUrl,
}));

vi.mock('../storage/remote-audio.js', () => ({
  RemoteAudioError: class RemoteAudioError extends Error {},
  downloadRemoteAudio: mocks.downloadRemoteAudio,
}));

const { getApp } = useTestApp();

const baseConversation = {
  conversation: {
    customer: { phone: 1555000200, name: 'Azure Customer' },
    agent: { email: 'azure.agent@company.com', name: 'Azure Agent' },
    channel: 'call',
    started_at: '2026-07-20T09:00:00Z',
    ended_at: '2026-07-20T09:05:00Z',
  },
  transcript: [],
};

beforeEach(() => {
  setConfig('AZURE_STORAGE_CONNECTION_STRING', 'configured-for-test');
  setConfig('AZURE_STORAGE_CONTAINER', 'audio');
  mocks.isBlobStorageConfigured.mockImplementation(() => Boolean(config.AZURE_STORAGE_CONNECTION_STRING));
  mocks.blobExists.mockResolvedValue(true);
  mocks.deleteBlob.mockResolvedValue(undefined);
  mocks.generateSasUrl.mockImplementation((blobName: string) => `https://test.example/audio/${blobName}?sig=test`);
  mocks.uploadAudio.mockImplementation(async (stream: Readable, blobName: string) => {
    for await (const _chunk of stream) {
      // Consume the stream as the Azure SDK would.
    }
    return blobName;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetConfig();
});

describe('POST /api/import Azure audio modes', () => {
  it('verifies and persists an existing Azure blob reference', async () => {
    const response = await getApp().inject({
      method: 'POST',
      url: '/api/import',
      payload: {
        ...baseConversation,
        audio: { blob_name: 'imports/existing-call.wav', format: 'wav' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.blobExists).toHaveBeenCalledWith('imports/existing-call.wav');

    const body = response.json();
    const db = await connectDb();
    const record = await db.collection('audio_files').findOne({
      conversation_id: new ObjectId(body.id),
    });
    expect(record).toMatchObject({
      blob_name: 'imports/existing-call.wav',
      url: '/audio/imports/existing-call.wav',
      format: 'wav',
    });
  });

  it('downloads and uploads a remote HTTPS audio source', async () => {
    mocks.downloadRemoteAudio.mockResolvedValue({
      stream: Readable.from([Buffer.from('remote-audio')]),
      contentType: 'audio/mpeg',
      format: 'mp3',
      finalUrl: 'https://8.8.8.8/call.mp3',
    });

    const response = await getApp().inject({
      method: 'POST',
      url: '/api/import',
      payload: {
        ...baseConversation,
        audio: { remote_url: 'https://8.8.8.8/call.mp3' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.downloadRemoteAudio).toHaveBeenCalledWith('https://8.8.8.8/call.mp3', undefined);
    expect(mocks.uploadAudio).toHaveBeenCalledWith(
      expect.any(Readable),
      expect.stringMatching(/^imports\/.+\.mp3$/),
      'audio/mpeg',
    );

    const body = response.json();
    const db = await connectDb();
    const record = await db.collection('audio_files').findOne({
      conversation_id: new ObjectId(body.id),
    });
    expect(record?.blob_name).toMatch(/^imports\/.+\.mp3$/);
    expect(record?.format).toBe('mp3');
  });

  it('uploads multipart audio directly to Azure', async () => {
    const boundary = '----playback-test-boundary';
    const data = JSON.stringify(baseConversation);
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="data"',
      '',
      data,
      `--${boundary}`,
      'Content-Disposition: form-data; name="audio"; filename="call.wav"',
      'Content-Type: audio/wav',
      '',
      'RIFF-test-audio',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const response = await getApp().inject({
      method: 'POST',
      url: '/api/import',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.uploadAudio).toHaveBeenCalledWith(
      expect.any(Readable),
      expect.stringMatching(/^imports\/.+\.wav$/),
      'audio/wav',
    );
    expect(mocks.deleteBlob).not.toHaveBeenCalled();
  });

  it('rejects missing existing Azure blobs', async () => {
    mocks.blobExists.mockResolvedValue(false);

    const response = await getApp().inject({
      method: 'POST',
      url: '/api/import',
      payload: {
        ...baseConversation,
        audio: { blob_name: 'imports/missing.wav', format: 'wav' },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('does not exist');
  });

  it('returns an Azure requirement error for remote URLs without Azure configuration', async () => {
    setConfig('AZURE_STORAGE_CONNECTION_STRING', undefined as unknown as string);

    const response = await getApp().inject({
      method: 'POST',
      url: '/api/import',
      payload: {
        ...baseConversation,
        audio: { remote_url: 'https://8.8.8.8/call.wav' },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('require Azure');
  });
});
