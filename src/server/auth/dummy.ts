import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDb } from '../db/connection.js';
import { getSession, setSession } from './session.js';

const loginSchema = z.object({
  username: z.string().min(1).describe('Username, e.g. user (seeded dummy user is user)'),
  password: z.string().min(1).describe('Password, e.g. 123456 (seeded dummy password is 123456)'),
});

export async function dummyAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/login -- username/password against users collection
  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Dummy login (staging)',
        description:
          'Authenticate with seeded dummy user. Seeded by `SEED_GUARD=SAYA_SADAR_DROPDB_{HH}:{MM} npm run db:seed` -- default `user` / `123456`. Sets `session` cookie used for all `/api/*` calls.',
        body: loginSchema,
        response: {
          200: z
            .object({ ok: z.boolean().describe('Login success'), username: z.string(), role: z.string() })
            .describe('Login success, session cookie set'),
          400: z.object({ error: z.string() }).describe('Missing username or password'),
          401: z.object({ error: z.string() }).describe('Invalid credentials'),
        },
      },
    },
    async (request, reply) => {
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
  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Current user (dummy)',
        description: 'Returns session user if authenticated via `POST /auth/login`, else 401. Requires `session` cookie.',
        response: {
          200: z.object({
            userId: z.string().describe('User ID'),
            email: z.string().describe('Username/email'),
            name: z.string().describe('Display name'),
            roles: z.array(z.string()).describe('Roles'),
          }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
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
  app.get(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout (dummy)',
        description: 'Deletes `session` cookie and redirects to `/`.',
        response: { 302: z.object({}).describe('Redirect to /') },
      },
    },
    async (request, reply) => {
      request.session.delete();
      return reply.redirect('/');
    },
  );

  app.get(
    '/auth/logout/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout callback (dummy)',
        description: 'Front-channel logout callback, deletes session and redirects to `/`.',
      },
    },
    async (request, reply) => {
      request.session.delete();
      return reply.redirect('/');
    },
  );

  // Keep GET /auth/login as redirect to root for compatibility
  app.get(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Login redirect (dummy)',
        description: 'GET /auth/login redirects to `/` (use POST /auth/login with body for dummy auth).',
      },
    },
    async (_request, reply) => {
      return reply.redirect('/');
    },
  );
}
