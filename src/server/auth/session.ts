import type { FastifyInstance } from 'fastify';
import fastifySecureSession, { type Session } from '@fastify/secure-session';
import { config } from '../config.js';

// Session data shape stored in the encrypted cookie
export interface SessionData {
  userId: string;
  email: string;
  name: string;
  roles: string[];
  expiresAt: number; // Unix timestamp (ms)
}

// Augment fastify's session type
declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
    email: string;
    name: string;
    roles: string;      // JSON-stringified string[] (secure-session stores primitives)
    expiresAt: number;
    pkceVerifier: string;
    authState: string;
  }
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  if (!config.SESSION_KEY || !config.SESSION_PASSWORD) {
    app.log.warn('SESSION_KEY/SESSION_PASSWORD not set -- session plugin not registered');
    return;
  }

  await app.register(fastifySecureSession, {
    key: Buffer.from(config.SESSION_KEY, 'hex'),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: config.NODE_ENV === 'production' || config.NODE_ENV === 'staging',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60, // 8 hours
    },
  });
}

// Helper: set session after successful login
export function setSession(
  session: Session<any>,
  data: SessionData,
): void {
  session.set('userId', data.userId);
  session.set('email', data.email);
  session.set('name', data.name);
  session.set('roles', JSON.stringify(data.roles));
  session.set('expiresAt', data.expiresAt);
}

// Helper: read session data (returns null if empty/expired)
export function getSession(
  session: any,
): SessionData | null {
  if (!session || typeof session.get !== 'function') return null;
  const userId = session.get('userId');
  if (!userId) return null;

  const expiresAt = session.get('expiresAt');
  if (typeof expiresAt === 'number' && Date.now() > expiresAt) {
    session.delete();
    return null;
  }

  const rolesRaw = session.get('roles');
  let roles: string[] = [];
  try {
    roles = rolesRaw ? JSON.parse(rolesRaw) : [];
  } catch {
    roles = [];
  }

  return {
    userId,
    email: session.get('email') || '',
    name: session.get('name') || '',
    roles,
    expiresAt: expiresAt || 0,
  };
}
