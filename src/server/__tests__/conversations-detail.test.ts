import { describe, it, expect } from 'vitest';
import {
  useTestApp,
  TEST_CONVERSATIONS,
  TEST_AGENT_1,
  TEST_CUSTOMER,
  TEST_TAG,
} from './setup.js';

describe('GET /api/conversations/:id', () => {
  const { getApp } = useTestApp();

  it('returns full conversation detail with populated relations', async () => {
    const id = TEST_CONVERSATIONS[0]._id.toString();
    const res = await getApp().inject({ method: 'GET', url: `/api/conversations/${id}` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.channel).toBe('call');
    expect(body.durationSeconds).toBe(300);
    expect(body.status).toBe('resolved');

    // Populated agent
    expect(body.agent).toEqual({
      id: TEST_AGENT_1._id.toString(),
      name: TEST_AGENT_1.name,
      email: TEST_AGENT_1.email,
      team: TEST_AGENT_1.team,
    });

    // Populated customer
    expect(body.customer.name).toBe(TEST_CUSTOMER.name);
    expect(body.customer.email).toBe(TEST_CUSTOMER.email);

    // Tags
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].label).toBe(TEST_TAG.label);

    // Transcript segments (conversation 1 has 3 segments)
    expect(body.transcript).toHaveLength(3);
    expect(body.transcript[0]).toHaveProperty('speaker');
    expect(body.transcript[0]).toHaveProperty('timestampSeconds');
    expect(body.transcript[0]).toHaveProperty('text');

    // Audio
    expect(body.audio).toEqual({
      url: '/audio/sample-call.wav',
      durationSeconds: 300,
      format: 'wav',
    });

    // Sentiment
    expect(body.sentiment).toEqual({ score: 0.7, label: 'positive' });
  });

  it('returns transcript segments sorted by timestamp', async () => {
    const id = TEST_CONVERSATIONS[0]._id.toString();
    const res = await getApp().inject({ method: 'GET', url: `/api/conversations/${id}` });
    const body = res.json();

    const timestamps = body.transcript.map((s: { timestampSeconds: number }) => s.timestampSeconds);
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i + 1]);
    }
  });

  it('returns 404 for non-existent conversation', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations/000000000000000000ffffff',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Conversation not found' });
  });

  it('returns 400 for malformed ID', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations/not-a-valid-id',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid conversation ID' });
  });
});
