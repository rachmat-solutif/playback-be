import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config, setConfig, resetConfig } from '../config.js';
import { entraAuthRoutes } from '../auth/entra.js';
import { registerAuthGuard } from '../auth/guard.js';
import { registerSession, setSession } from '../auth/session.js';
import { importBulkSchema } from '../routes/import-schemas.js';

const TEST_IMPORT_API_KEY = 'test-import-api-key-012345678901234567890123';
const TEST_SESSION_KEY = 'a'.repeat(64);

let app: FastifyInstance;

function setAuthConfig(): void {
  setConfig('AUTH_PROVIDER', 'entra');
  setConfig('AUTH_BYPASS', false);
  setConfig('IMPORT_API_KEY', TEST_IMPORT_API_KEY);
  setConfig('SESSION_KEY', TEST_SESSION_KEY);
  setConfig('SESSION_PASSWORD', 'test-session-password');
  setConfig('ENTRA_TENANT_ID', 'test-tenant-id');
  setConfig('ENTRA_REDIRECT_URI', 'http://localhost:3000/auth/callback');
}

async function createAuthTestApp(): Promise<FastifyInstance> {
  setAuthConfig();

  const testApp = Fastify();
  testApp.setValidatorCompiler(validatorCompiler);
  testApp.setSerializerCompiler(serializerCompiler);
  await registerSession(testApp);
  await registerAuthGuard(testApp);
  await testApp.register(entraAuthRoutes);

  // Test-only protected endpoints.
  testApp.get('/api/conversations', async () => ({ ok: true }));
  testApp.get('/api/audio/:id', async () => ({ ok: true }));
  testApp.get('/api/audio.wav', async () => ({ ok: true }));
  testApp.post('/api/import/bulk', async () => ({ ok: true }));
  testApp.get('/test/session', async (request, reply) => {
    setSession(request.session, {
      userId: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      roles: ['reader'],
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    return reply.send({ ok: true });
  });

  await testApp.ready();
  resetConfig();
  return testApp;
}

describe('session authentication and import API key', () => {
  beforeEach(async () => {
    app = await createAuthTestApp();
  });

  afterEach(async () => {
    await app.close();
    resetConfig();
  });

  it('returns 401 for an unauthenticated API request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/conversations',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('protects audio routes, including paths ending in a static extension', async () => {
    const audioResponse = await app.inject({
      method: 'GET',
      url: '/api/audio/test-id',
    });
    const extensionResponse = await app.inject({
      method: 'GET',
      url: '/api/audio.wav',
    });

    expect(audioResponse.statusCode).toBe(401);
    expect(extensionResponse.statusCode).toBe(401);
  });

  it('returns 401 from /auth/me without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the current user from /auth/me with a valid session', async () => {
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/test/session',
    });
    const cookie = sessionResponse.headers['set-cookie'];

    expect(cookie).toBeTruthy();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: String(cookie) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      roles: ['reader'],
    });
  });

  it('clears the session cookie from /auth/logout', async () => {
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/test/session',
    });
    const cookie = sessionResponse.headers['set-cookie'];

    const response = await app.inject({
      method: 'GET',
      url: '/auth/logout',
      headers: { cookie: String(cookie) },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('login.microsoftonline.com');
    expect(response.headers['set-cookie']).toBeTruthy();
  });

  it('requires the import API key on import endpoints', async () => {
    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/import/bulk',
      payload: { conversations: [] },
    });
    expect(missingKey.statusCode).toBe(401);

    const invalidKey = await app.inject({
      method: 'POST',
      url: '/api/import/bulk',
      headers: { authorization: 'Bearer wrong-key' },
      payload: { conversations: [] },
    });
    expect(invalidKey.statusCode).toBe(401);

    const validKey = await app.inject({
      method: 'POST',
      url: '/api/import/bulk',
      headers: { authorization: `Bearer ${TEST_IMPORT_API_KEY}` },
      payload: { conversations: [] },
    });
    expect(validKey.statusCode).toBe(200);
    expect(validKey.json()).toEqual({ ok: true });
  });

  it('rejects bulk payloads over 10000 conversations', () => {
    const result = importBulkSchema.safeParse({
      conversations: Array.from({ length: 10001 }, () => ({})),
    });

    expect(result.success).toBe(false);
  });
});
