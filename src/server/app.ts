import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pino from 'pino';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db/connection.js';
import { createLogger } from './plugins/logger.js';
import { generateTransactionId } from './lib/transaction-id.js';
import { conversationRoutes } from './routes/conversations.js';
import { analyticsRoutes } from './routes/analytics.js';
import { audioRoutes } from './routes/audio.js';
import { importRoutes } from './routes/import.js';
import { agentRoutes } from './routes/agents.js';
import { registerSession } from './auth/session.js';
import { registerAuthGuard } from './auth/guard.js';
import { entraAuthRoutes } from './auth/entra.js';
import { bypassAuthRoutes } from './auth/bypass.js';
import { dummyAuthRoutes } from './auth/dummy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const logger = createLogger({
  service: config.SERVICE_NAME,
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
});

export async function buildApp(options: { disableAuth?: boolean } = {}) {
  const SENSITIVE_QUERY_PARAMS = new Set([
    'code',
    'session_state',
    'client_info',
    'state',
    'clientdata',
  ]);

  function sanitizePath(url: string): string {
    const idx = url.indexOf('?');
    if (idx === -1) return url;
    const query = new URLSearchParams(url.slice(idx + 1));
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (query.has(key)) query.delete(key);
    }
    const remaining = query.toString();
    return remaining ? `${url.slice(0, idx)}?${remaining}` : url.slice(0, idx);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const app = Fastify({
    logger: false,
    bodyLimit: 500 * 1024 * 1024,
  }) as unknown as FastifyInstance;

  // Suppress TypeScript type errors from plugin registrations
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  app.log = logger;

  // --- Per-request child logger with transaction ID ---
  app.addHook('onRequest', (_request, _reply, done) => {
    const transactionId = generateTransactionId();
    const req = _request as FastifyRequest;
    req.log = logger.child({ transactionId });
    req.log.info(
      {
        data: {
          method: req.method,
          path: sanitizePath(req.url),
        },
      },
      'incoming request',
    );
    done();
  });

  // --- Log request completion with latency ---
  app.addHook('onResponse', async (_request, _reply) => {
    const req = _request as FastifyRequest;
    const rep = _reply as FastifyReply;
    const latencyMs = (req as any).elapsedTime;
    req.log.info(
      {
        data: {
          method: req.method,
          path: sanitizePath(req.url),
          status: rep.statusCode,
          latency_ms: Math.round(latencyMs),
        },
      },
      'request completed',
    );
  });

  // --- Rate limiting ---
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // --- Session management ---
  await registerSession(app);

  // --- Auth guard (protects /api/* routes) ---
  await registerAuthGuard(app, { disabled: options.disableAuth });

  // --- Auth routes (login, callback, logout, me) ---
  if (config.AUTH_PROVIDER === 'entra') {
    await app.register(entraAuthRoutes);
  } else if (config.AUTH_PROVIDER === 'dummy') {
    await app.register(dummyAuthRoutes);
  } else if (config.AUTH_BYPASS) {
    await app.register(bypassAuthRoutes);
  }

  // --- API routes ---
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(audioRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });

  // --- Health check ---
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // --- Optional: serve frontend dist if present (monolith compat) ---
  // When BE runs standalone (separate FE repo), there is no dist folder --
  // the frontend is served by its own host. This block is no-op in that case.
  const distPath = path.join(projectRoot, 'dist');
  if (fs.existsSync(distPath) && fs.existsSync(path.join(distPath, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return (reply as unknown as { sendFile: (f: string) => unknown }).sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}

// --- Start server when run directly ---
async function start() {
  const app = await buildApp();

  try {
    await connectDb();
    logger.info('Connected to MongoDB');

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Server listening on http://localhost:${config.PORT}`);
  } catch (err) {
    logger.error(err as Error);
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  start();
}
