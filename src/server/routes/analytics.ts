import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectDb } from '../db/connection.js';

const volumeQuerySchema = z.object({
  from: z.string().optional().describe('Start date ISO 8601'),
  to: z.string().optional().describe('End date ISO 8601'),
  granularity: z.enum(['day', 'hour']).optional().default('day').describe('Bucket granularity'),
});

const kpisQuerySchema = z.object({
  from: z.string().optional().describe('Start date ISO 8601'),
  to: z.string().optional().describe('End date ISO 8601'),
});

const sentimentQuerySchema = z.object({
  from: z.string().optional().describe('Start date ISO 8601'),
  to: z.string().optional().describe('End date ISO 8601'),
});

const topAgentsQuerySchema = z.object({
  from: z.string().optional().describe('Start date ISO 8601'),
  to: z.string().optional().describe('End date ISO 8601'),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5).describe('Max agents (1-20)'),
});

export async function analyticsRoutes(app: FastifyInstance) {
  /**
   * GET /api/analytics/volume
   * Contact volume by day or hour, with per-channel breakdown.
   */
  app.get(
    '/analytics/volume',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Contact volume',
        querystring: volumeQuerySchema,
      },
    },
    async (request) => {
    const { from, to, granularity = 'day' } = request.query as Record<string, string>;

    const db = await connectDb();
    const match: Record<string, unknown> = {};

    if (from || to) {
      match.started_at = {} as Record<string, Date>;
      if (from) (match.started_at as Record<string, Date>).$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        (match.started_at as Record<string, Date>).$lte = toDate;
      }
    }

    if (granularity === 'hour') {
      // Group by hour of day (0-23)
      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { hour: { $hour: '$started_at' }, channel: '$channel' },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.hour': 1 as const } },
      ];

      const results = await db.collection('conversations').aggregate(pipeline).toArray();

      // Reshape into { label, count, byChannel }
      const hourMap = new Map<number, { count: number; call: number; chat: number; email: number }>();
      for (let h = 0; h < 24; h++) {
        hourMap.set(h, { count: 0, call: 0, chat: 0, email: 0 });
      }

      for (const r of results) {
        const entry = hourMap.get(r._id.hour)!;
        entry.count += r.count;
        entry[r._id.channel as 'call' | 'chat' | 'email'] += r.count;
      }

      const data = [...hourMap.entries()].map(([hour, v]) => ({
        label: `${hour.toString().padStart(2, '0')}:00`,
        count: v.count,
        byChannel: { call: v.call, chat: v.chat, email: v.email },
      }));

      return { data };
    }

    // Default: group by day
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$started_at' } },
            channel: '$channel',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 as const } },
    ];

    const results = await db.collection('conversations').aggregate(pipeline).toArray();

    // Reshape
    const dayMap = new Map<string, { count: number; call: number; chat: number; email: number }>();

    for (const r of results) {
      if (!dayMap.has(r._id.date)) {
        dayMap.set(r._id.date, { count: 0, call: 0, chat: 0, email: 0 });
      }
      const entry = dayMap.get(r._id.date)!;
      entry.count += r.count;
      entry[r._id.channel as 'call' | 'chat' | 'email'] += r.count;
    }

    const data = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        label: date,
        count: v.count,
        byChannel: { call: v.call, chat: v.chat, email: v.email },
      }));

    return { data };
  });

  /**
   * GET /api/analytics/kpis
   * Dashboard KPI cards with period-over-period delta.
   */
  app.get(
    '/analytics/kpis',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'KPI cards',
        querystring: kpisQuerySchema,
      },
    },
    async (request) => {
    const { from, to } = request.query as Record<string, string>;

    const db = await connectDb();

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    toDate.setHours(23, 59, 59, 999);

    // Calculate the previous period (same duration, just before `from`)
    const periodMs = toDate.getTime() - fromDate.getTime();
    const prevFrom = new Date(fromDate.getTime() - periodMs);
    const prevTo = new Date(fromDate.getTime() - 1);

    // Current period stats
    const currentMatch = { started_at: { $gte: fromDate, $lte: toDate } };
    const prevMatch = { started_at: { $gte: prevFrom, $lte: prevTo } };

    const [currentConvs, prevConvs, currentMetrics, prevMetrics] = await Promise.all([
      db.collection('conversations').find(currentMatch).toArray(),
      db.collection('conversations').find(prevMatch).toArray(),
      db
        .collection('conversation_metrics')
        .find({
          conversation_id: {
            $in: (await db.collection('conversations').find(currentMatch).project({ _id: 1 }).toArray()).map((c) => c._id),
          },
        })
        .toArray(),
      db
        .collection('conversation_metrics')
        .find({
          conversation_id: {
            $in: (await db.collection('conversations').find(prevMatch).project({ _id: 1 }).toArray()).map((c) => c._id),
          },
        })
        .toArray(),
    ]);

    // Total conversations
    const totalConversations = currentConvs.length;
    const prevTotal = prevConvs.length;

    // Average handle time
    const avgHandleTime =
      currentMetrics.length > 0
        ? Math.round(currentMetrics.reduce((sum, m) => sum + m.handle_time_seconds, 0) / currentMetrics.length)
        : 0;
    const prevAvgHandle =
      prevMetrics.length > 0
        ? Math.round(prevMetrics.reduce((sum, m) => sum + m.handle_time_seconds, 0) / prevMetrics.length)
        : 0;

    // Negative sentiment rate
    const negativeCount = currentMetrics.filter((m) => m.sentiment_label === 'negative').length;
    const negativeSentimentRate = currentMetrics.length > 0 ? +(negativeCount / currentMetrics.length).toFixed(3) : 0;
    const prevNegCount = prevMetrics.filter((m) => m.sentiment_label === 'negative').length;
    const prevNegRate = prevMetrics.length > 0 ? +(prevNegCount / prevMetrics.length).toFixed(3) : 0;

    // Active agents (unique agent_ids in the period)
    const activeAgents = new Set(currentConvs.map((c) => c.agent_id.toString())).size;
    const prevActiveAgents = new Set(prevConvs.map((c) => c.agent_id.toString())).size;

    function delta(current: number, previous: number): number {
      if (previous === 0) return current > 0 ? 1 : 0;
      return +((current - previous) / previous).toFixed(3);
    }

    return {
      totalConversations: { value: totalConversations, delta: delta(totalConversations, prevTotal) },
      avgHandleTime: { value: avgHandleTime, delta: delta(avgHandleTime, prevAvgHandle) },
      negativeSentimentRate: { value: negativeSentimentRate, delta: delta(negativeSentimentRate, prevNegRate) },
      activeAgents: { value: activeAgents, delta: delta(activeAgents, prevActiveAgents) },
    };
  });

  /**
   * GET /api/analytics/sentiment
   * Sentiment distribution (positive, neutral, negative counts).
   */
  app.get(
    '/analytics/sentiment',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Sentiment distribution',
        querystring: sentimentQuerySchema,
      },
    },
    async (request) => {
    const { from, to } = request.query as Record<string, string>;

    const db = await connectDb();

    // Get conversation IDs in range
    const match: Record<string, unknown> = {};
    if (from || to) {
      match.started_at = {} as Record<string, Date>;
      if (from) (match.started_at as Record<string, Date>).$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        (match.started_at as Record<string, Date>).$lte = toDate;
      }
    }

    const convIds = await db
      .collection('conversations')
      .find(match)
      .project({ _id: 1 })
      .toArray();

    const pipeline = [
      { $match: { conversation_id: { $in: convIds.map((c) => c._id) } } },
      { $group: { _id: '$sentiment_label', count: { $sum: 1 } } },
    ];

    const results = await db.collection('conversation_metrics').aggregate(pipeline).toArray();

    const counts = { positive: 0, neutral: 0, negative: 0 };
    for (const r of results) {
      if (r._id in counts) {
        counts[r._id as keyof typeof counts] = r.count;
      }
    }

    return counts;
  });

  /**
   * GET /api/analytics/top-agents
   * Top agents by conversation volume.
   */
  app.get(
    '/analytics/top-agents',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Top agents',
        querystring: topAgentsQuerySchema,
      },
    },
    async (request) => {
    const { from, to, limit = '5' } = request.query as Record<string, string>;

    const db = await connectDb();

    const match: Record<string, unknown> = {};
    if (from || to) {
      match.started_at = {} as Record<string, Date>;
      if (from) (match.started_at as Record<string, Date>).$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        (match.started_at as Record<string, Date>).$lte = toDate;
      }
    }

    const limitNum = Math.min(20, Math.max(1, parseInt(limit, 10) || 5));

    const pipeline = [
      { $match: match },
      { $group: { _id: '$agent_id', count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
      { $limit: limitNum },
      {
        $lookup: {
          from: 'agents',
          localField: '_id',
          foreignField: '_id',
          as: 'agent',
        },
      },
      { $unwind: '$agent' },
    ];

    const results = await db.collection('conversations').aggregate(pipeline).toArray();

    return {
      data: results.map((r) => ({
        agentId: r._id.toString(),
        name: r.agent.name,
        count: r.count,
      })),
    };
  });
}
