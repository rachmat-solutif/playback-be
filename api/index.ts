import { buildApp } from '../src/server/app.js';
import { connectDb } from '../src/server/db/connection.js';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let dbReady = false;

async function getApp() {
  if (app) return app;

  app = await buildApp();
  await app.ready();

  if (!dbReady) {
    try {
      await connectDb();
      dbReady = true;
    } catch (err) {
      (app.log as any).error(err as Error, 'MongoDB connection failed on cold start');
      throw err;
    }
  }

  return app;
}

export default async function handler(req: any, res: any) {
  const fastify = await getApp();
  // Delegate to Fastify's Node http handler -- supports streaming, multipart, Range.
  fastify.server.emit('request', req, res);
}
