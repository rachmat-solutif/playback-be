import type { FastifyInstance } from 'fastify';

export async function bypassAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/me', async () => ({
    userId: 'dev-user',
    email: 'dev@local',
    name: 'Dev User',
    roles: ['admin'],
  }));

  app.get('/auth/login', async (_, reply) => {
    return reply.redirect('/');
  });

  app.get('/auth/logout', async (_, reply) => {
    return reply.redirect('/');
  });

  app.get('/auth/logout/callback', async (_, reply) => {
    return reply.redirect('/');
  });
}
