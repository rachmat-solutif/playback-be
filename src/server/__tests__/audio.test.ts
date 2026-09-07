import { connectDb } from '../db/connection.js';
import { afterEach, describe, expect, it } from 'vitest';
import { useTestApp, TEST_CONVERSATIONS } from './setup.js';
import { config, setConfig } from '../config.js';

const { getApp } = useTestApp();
const connectionString =
  `DefaultEndpointsProtocol=https;AccountName=testaudio;AccountKey=${Buffer.alloc(32, 3).toString('base64')};EndpointSuffix=core.windows.net`;

afterEach(() => {
  setConfig('AZURE_STORAGE_CONNECTION_STRING', undefined as unknown as string);
  setConfig('AZURE_STORAGE_CONTAINER', 'audio');
  setConfig('AUDIO_SAS_EXPIRY_MINUTES', 60);
  setConfig('AUDIO_SAS_CLOCK_SKEW_MINUTES', 5);
});

describe('GET /api/audio/:conversationId', () => {
  it('streams audio file for a valid conversation', async () => {
    const id = TEST_CONVERSATIONS[0]._id.toString();
    const res = await getApp().inject({ method: 'GET', url: `/api/audio/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('supports byte range requests for local audio', async () => {
    const id = TEST_CONVERSATIONS[0]._id.toString();
    const res = await getApp().inject({
      method: 'GET',
      url: `/api/audio/${id}`,
      headers: { range: 'bytes=0-9' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-9\//);
    expect(res.headers['content-length']).toBe('10');
    expect(res.rawPayload.length).toBe(10);
  });

  it('returns a direct JSON SAS URL when Blob Storage is configured', async () => {
    setConfig('AZURE_STORAGE_CONNECTION_STRING', connectionString);
    setConfig('AZURE_STORAGE_CONTAINER', 'audio');
    setConfig('AUDIO_SAS_EXPIRY_MINUTES', 60);
    setConfig('AUDIO_SAS_CLOCK_SKEW_MINUTES', 5);

    const id = TEST_CONVERSATIONS[0]._id.toString();
    const res = await getApp().inject({ method: 'GET', url: `/api/audio/${id}` });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.url).toMatch(/^https:\/\/testaudio\.blob\.core\.windows\.net\/audio\/sample-call\.wav\?/);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns a direct JSON SAS URL for an explicit blob_name', async () => {
    const db = await connectDb();
    const id = TEST_CONVERSATIONS[0]._id.toString();
    await db.collection('audio_files').updateOne(
      { conversation_id: TEST_CONVERSATIONS[0]._id },
      { $set: { blob_name: 'imports/explicit-call.wav', url: '/audio/legacy.wav' } },
    );

    setConfig('AZURE_STORAGE_CONNECTION_STRING', connectionString);
    setConfig('AZURE_STORAGE_CONTAINER', 'audio');
    setConfig('AUDIO_SAS_EXPIRY_MINUTES', 60);
    setConfig('AUDIO_SAS_CLOCK_SKEW_MINUTES', 5);

    const res = await getApp().inject({ method: 'GET', url: `/api/audio/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/\/audio\/imports\/explicit-call\.wav\?/);

    await db.collection('audio_files').updateOne(
      { conversation_id: TEST_CONVERSATIONS[0]._id },
      { $unset: { blob_name: '' }, $set: { url: '/audio/sample-call.wav' } },
    );
  });

  it('returns 404 for conversation without audio record', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/audio/000000000000000000ffffff',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error');
  });

  it('returns 400 for invalid conversation ID', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/audio/invalid-id' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid conversation ID' });
  });
});
