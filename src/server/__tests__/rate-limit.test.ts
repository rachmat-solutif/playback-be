import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';

describe('Rate limiting', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    // Create a minimal app with aggressive rate limit for testing
    app = Fastify();
    await app.register(fastifyRateLimit, { max: 3, timeWindow: '1 minute' });
    app.get('/test', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 after exceeding rate limit', async () => {
    // Send 3 requests (within limit)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(res.statusCode).toBe(200);
    }

    // 4th request should be rate limited
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body).toHaveProperty('message');
  });
});
