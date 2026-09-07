import { FastifyInstance } from 'fastify';
import { connectDb } from '../db/connection.js';

export async function agentRoutes(app: FastifyInstance) {
  /**
   * GET /api/agents
   * Return all agents (id + name), sorted alphabetically.
   */
  app.get('/agents', async () => {
    const db = await connectDb();
    const agents = await db
      .collection('agents')
      .find()
      .project({ _id: 1, name: 1 })
      .sort({ name: 1 })
      .toArray();

    return {
      data: agents.map((a) => ({
        id: a._id.toString(),
        name: a.name,
      })),
    };
  });
}
