import { describe, it, expect } from 'vitest';
import { useTestApp } from './setup.js';

describe('GET /api/analytics/volume', () => {
  const { getApp } = useTestApp();

  it('returns daily volume breakdown', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/volume?from=2026-07-10&to=2026-07-15&granularity=day',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThan(0);

    // Each entry has label, count, byChannel
    const entry = body.data[0];
    expect(entry).toHaveProperty('label');
    expect(entry).toHaveProperty('count');
    expect(entry).toHaveProperty('byChannel');
    expect(entry.byChannel).toHaveProperty('call');
    expect(entry.byChannel).toHaveProperty('chat');
    expect(entry.byChannel).toHaveProperty('email');
  });

  it('returns hourly volume breakdown', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/volume?from=2026-07-10&to=2026-07-15&granularity=hour',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should have 24 hour buckets
    expect(body.data).toHaveLength(24);
    expect(body.data[0].label).toBe('00:00');
  });

  it('includes per-channel counts in volume', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/volume?from=2026-07-10&to=2026-07-15&granularity=day',
    });
    const body = res.json();
    const totalCount = body.data.reduce((sum: number, d: { count: number }) => sum + d.count, 0);
    expect(totalCount).toBe(5); // All 5 test conversations
  });

  it('returns empty array for date range with no data', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/volume?from=2099-01-01&to=2099-12-31&granularity=day',
    });
    const body = res.json();
    expect(body.data).toEqual([]);
  });
});

describe('GET /api/analytics/kpis', () => {
  const { getApp } = useTestApp();

  it('returns all 4 KPIs with values and deltas', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/kpis?from=2026-07-10&to=2026-07-15',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty('totalConversations');
    expect(body).toHaveProperty('avgHandleTime');
    expect(body).toHaveProperty('negativeSentimentRate');
    expect(body).toHaveProperty('activeAgents');

    // Each KPI has value + delta
    expect(body.totalConversations).toHaveProperty('value');
    expect(body.totalConversations).toHaveProperty('delta');
    expect(body.totalConversations.value).toBe(5);

    // 2 agents active
    expect(body.activeAgents.value).toBe(2);
  });
});

describe('GET /api/analytics/sentiment', () => {
  const { getApp } = useTestApp();

  it('returns positive, neutral, negative counts', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/sentiment?from=2026-07-10&to=2026-07-15',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty('positive');
    expect(body).toHaveProperty('neutral');
    expect(body).toHaveProperty('negative');
    expect(body.positive).toBe(2);
    expect(body.neutral).toBe(1);
    expect(body.negative).toBe(2);
  });
});

describe('GET /api/analytics/top-agents', () => {
  const { getApp } = useTestApp();

  it('returns agents sorted by conversation count descending', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/top-agents?from=2026-07-10&to=2026-07-15',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.data).toHaveLength(2);
    // Agent 1 (Alice) has 3 conversations, Agent 2 (Bob) has 2
    expect(body.data[0].name).toBe('Test Agent Alice');
    expect(body.data[0].count).toBe(3);
    expect(body.data[1].name).toBe('Test Agent Bob');
    expect(body.data[1].count).toBe(2);
  });

  it('respects limit param', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url: '/api/analytics/top-agents?from=2026-07-10&to=2026-07-15&limit=1',
    });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Test Agent Alice');
  });
});
