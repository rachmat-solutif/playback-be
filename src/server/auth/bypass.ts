import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export async function bypassAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Current user (bypass)',
        description: 'Bypass mode -- always returns `dev-user`. Active when AUTH_BYPASS=true or AUTH_PROVIDER=none.',
        response: {
          200: z.object({
            userId: z.string().describe('User ID'),
            email: z.string().describe('Email'),
            name: z.string().describe('Display name'),
            roles: z.array(z.string()).describe('Roles'),
          }),
        },
      },
    },
    async () => ({
      userId: 'dev-user',
      email: 'dev@local',
      name: 'Dev User',
      roles: ['admin'],
    }),
  );

  app.get(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Login redirect (bypass)',
        description: 'Bypass mode -- redirects to `/` without authentication.',
      },
    },
    async (_, reply) => {
      return reply.redirect('/');
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Login (bypass)',
        description: 'Bypass mode -- accepts any `username`/`password` and returns `dev-user`. Use for offline dev without DB. For DB-backed dummy auth set `AUTH_PROVIDER=dummy` with `SESSION_KEY`/`SESSION_PASSWORD`.',
        body: z.object({
          username: z.string().optional().describe('Username (ignored in bypass)'),
          password: z.string().optional().describe('Password (ignored in bypass)'),
        }),
        response: {
          200: z.object({
            ok: z.boolean().describe('Login success'),
            username: z.string().describe('Username'),
            role: z.string().describe('Role'),
          }),
        },
      },
    },
    async (request, reply) => {
      const body = (request.body as Record<string, unknown>) || {};
      const username = (body.username as string) || 'dev-user';
      return reply.send({ ok: true, username, role: 'admin' });
    },
  );

  app.get(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout (bypass)',
        description: 'Bypass mode -- redirects to `/`.',
      },
    },
    async (_, reply) => {
      return reply.redirect('/');
    },
  );

  app.get(
    '/auth/logout/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout callback (bypass)',
        description: 'Bypass mode -- redirects to `/`.',
      },
    },
    async (_, reply) => {
      return reply.redirect('/');
    },
  );
}
