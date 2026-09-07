import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDb } from '../db/connection.js';
import { getSession, setSession } from './session.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function dummyAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/login -- username/password against users collection
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Missing username or password' });
    }
    const { username, password } = parsed.data;

    const db = await connectDb();
    const user = await db.collection('users').findOne({ username });
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, (user as any).password_hash);
    if (!ok) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    setSession(request.session, {
      userId: (user as any)._id.toString(),
      email: (user as any).username,
      name: (user as any).username,
      roles: [(user as any).role],
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    });

    return reply.send({ ok: true, username: (user as any).username, role: (user as any).role });
  });

  // GET /auth/me -- return current user from session
  app.get('/auth/me', async (request, reply) => {
    const session = getSession(request.session);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });
    return reply.send({
      userId: session.userId,
      email: session.email,
      name: session.name,
      roles: session.roles,
    });
  });

  // GET /auth/logout -- destroy session
  app.get('/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.redirect('/');
  });

  app.get('/auth/logout/callback', async (request, reply) => {
    request.session.delete();
    return reply.redirect('/');
  });

  // Keep GET /auth/login as redirect to root for compatibility
  app.get('/auth/login', async (_request, reply) => {
    return reply.redirect('/');
  });
}
