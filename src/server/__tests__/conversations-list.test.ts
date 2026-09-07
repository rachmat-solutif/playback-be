import { describe, it, expect } from 'vitest';
import {
  useTestApp,
  TEST_CONVERSATIONS,
  TEST_AGENT_1,
  TEST_AGENT_2,
} from './setup.js';

describe('GET /api/conversations', () => {
  const { getApp } = useTestApp();

  it('returns paginated list of conversations', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/conversations' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(5);
  });

  it('returns conversations sorted by started_at descending', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/conversations' });
    const body = res.json();
    const dates = body.data.map((c: { startedAt: string }) => new Date(c.startedAt).getTime());
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
    }
  });

  it('filters by date range (from/to)', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?from=2026-07-11&to=2026-07-12',
    });
    const body = res.json();
    // Should include conversations on Jul 11 and Jul 12 (IDs 02, 03, 04)
    expect(body.total).toBe(3);
  });

  it('filters by channel', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?channel=call',
    });
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.data.every((c: { channel: string }) => c.channel === 'call')).toBe(true);
  });

  it('filters by agent (name)', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: `/api/conversations?agent=${encodeURIComponent(TEST_AGENT_2.name)}`,
    });
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.data.every((c: { agent: string }) => c.agent === TEST_AGENT_2.name)).toBe(true);
  });

  it('filters by sentiment', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?sentiment=negative',
    });
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.data.every((c: { sentiment: string }) => c.sentiment === 'negative')).toBe(true);
  });

  it('filters by keyword (searches transcript text)', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?keyword=billing',
    });
    const body = res.json();
    // Conversation 1 has "billing question" in transcript
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by minDuration', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?minDuration=400',
    });
    const body = res.json();
    // Conversations with duration >= 400: #2 (600), #4 (480)
    expect(body.total).toBe(2);
    expect(body.data.every((c: { durationSeconds: number }) => c.durationSeconds >= 400)).toBe(true);
  });

  it('combines multiple filters (AND logic)', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: `/api/conversations?channel=call&agent=${encodeURIComponent(TEST_AGENT_1.name)}`,
    });
    const body = res.json();
    // Alice's calls: #1, #2, #5 = 3
    expect(body.total).toBe(3);
  });

  it('respects pagination (page and limit)', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?limit=2&page=2',
    });
    const body = res.json();
    expect(body.total).toBe(5);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  it('returns empty array when no matches', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/conversations?channel=call&from=2099-01-01&to=2099-12-31',
    });
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('enriches conversations with agent name, customer name, tags, sentiment', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/conversations?limit=1' });
    const body = res.json();
    const conv = body.data[0];
    expect(conv).toHaveProperty('id');
    expect(conv).toHaveProperty('agent');
    expect(conv).toHaveProperty('customer');
    expect(conv).toHaveProperty('channel');
    expect(conv).toHaveProperty('startedAt');
    expect(conv).toHaveProperty('durationSeconds');
    expect(conv).toHaveProperty('tags');
    expect(conv).toHaveProperty('sentiment');
    expect(conv.tags[0]).toHaveProperty('label');
  });
});
