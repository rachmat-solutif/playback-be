import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getSession } from './session.js';

const PUBLIC_PREFIXES = ['/auth/', '/health'];
const STATIC_EXTENSIONS = /\.(js|css|html|ico|png|svg|jpg|jpeg|gif|woff|woff2|ttf|map|wav|mp3)$/;

function isPublicRoute(url: string): boolean {
  const pathname = url.split('?')[0];

  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }

  if (pathname.startsWith('/api/')) return false;
  return STATIC_EXTENSIONS.test(pathname);
}

function isImportRoute(url: string): boolean {
  const pathname = url.split('?')[0];
  return pathname === '/api/import' || pathname.startsWith('/api/import/');
}

function hasValidImportApiKey(request: FastifyRequest, expectedKey?: string): boolean {
  if (!expectedKey) return false;

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return false;

  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface AuthGuardOptions {
  disabled?: boolean;
}

export async function registerAuthGuard(
  app: FastifyInstance,
  options: AuthGuardOptions = {},
): Promise<void> {
  if (options.disabled) return;

  const authEnabled = config.AUTH_PROVIDER === 'entra';
  const authBypass = config.AUTH_BYPASS;
  const importApiKey = config.IMPORT_API_KEY;

  if (!authEnabled) return;

  if (authBypass) return;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicRoute(request.url)) return;
    if (!request.url.startsWith('/api/')) return;

    if (isImportRoute(request.url)) {
      if (hasValidImportApiKey(request, importApiKey)) return;
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const session = getSession(request.session);
    if (!session) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });
}
