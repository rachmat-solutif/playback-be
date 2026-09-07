import { FastifyInstance } from 'fastify';
import { ObjectId, Filter } from 'mongodb';
import { connectDb } from '../db/connection.js';
import { ConversationDoc } from '../db/collections.js';

export async function conversationRoutes(app: FastifyInstance) {
  /**
   * GET /api/conversations
   * List conversations with filters. All filters combine with AND logic.
   */
  app.get('/conversations', async (request, reply) => {
    const {
      from,
      to,
      agent,
      channel,
      sentiment,
      tag,
      keyword,
      minDuration,
      page = '1',
      limit = '20',
    } = request.query as Record<string, string | undefined>;

    const db = await connectDb();
    const convCol = db.collection<ConversationDoc>('conversations');

    const filter: Filter<ConversationDoc> = {};

    // Date range
    if (from || to) {
      filter.started_at = {};
      if (from) (filter.started_at as Record<string, Date>).$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        (filter.started_at as Record<string, Date>).$lte = toDate;
      }
    }

    // Agent filter (by agent_id)
    if (agent) {
      try {
        filter.agent_id = new ObjectId(agent);
      } catch {
        // If not a valid ObjectId, try name lookup
        const agentDoc = await db.collection('agents').findOne({ name: agent });
        if (agentDoc) filter.agent_id = agentDoc._id;
        else filter.agent_id = new ObjectId('000000000000000000000000'); // no match
      }
    }

    // Channel filter
    if (channel) {
      filter.channel = channel as ConversationDoc['channel'];
    }

    // Tag filter
    if (tag) {
      try {
        filter.tag_ids = new ObjectId(tag);
      } catch {
        const tagDoc = await db.collection('tags').findOne({ label: tag });
        if (tagDoc) filter.tag_ids = tagDoc._id;
      }
    }

    // Min duration filter
    if (minDuration) {
      filter.duration_seconds = { $gte: parseInt(minDuration, 10) };
    }

    // Sentiment filter (requires join with metrics)
    let sentimentConvIds: ObjectId[] | null = null;
    if (sentiment) {
      const metrics = await db
        .collection('conversation_metrics')
        .find({ sentiment_label: sentiment })
        .project({ conversation_id: 1 })
        .toArray();
      sentimentConvIds = metrics.map((m) => m.conversation_id);
    }

    // Keyword filter (searches transcript text, agent name, customer name, conversation ID)
    let keywordConvIds: ObjectId[] | null = null;
    if (keyword) {
      // Search transcript segments via text index
      const segments = await db
        .collection('transcript_segments')
        .find({ $text: { $search: keyword } })
        .project({ conversation_id: 1 })
        .toArray();
      const segConvIds = new Set(segments.map((s) => s.conversation_id.toString()));

      // Also search by agent name or customer name
      const matchingAgents = await db
        .collection('agents')
        .find({ name: { $regex: keyword, $options: 'i' } })
        .project({ _id: 1 })
        .toArray();
      const matchingCustomers = await db
        .collection('customers')
        .find({ name: { $regex: keyword, $options: 'i' } })
        .project({ _id: 1 })
        .toArray();

      if (matchingAgents.length > 0) {
        const agentConvs = await convCol
          .find({ agent_id: { $in: matchingAgents.map((a) => a._id) } })
          .project({ _id: 1 })
          .toArray();
        agentConvs.forEach((c) => segConvIds.add(c._id.toString()));
      }

      if (matchingCustomers.length > 0) {
        const custConvs = await convCol
          .find({ customer_id: { $in: matchingCustomers.map((c) => c._id) } })
          .project({ _id: 1 })
          .toArray();
        custConvs.forEach((c) => segConvIds.add(c._id.toString()));
      }

      // Search by conversation ID (partial hex match)
      if (/^[0-9a-fA-F]+$/.test(keyword)) {
        const paddedId = keyword.toLowerCase().padStart(24, '0');
        try {
          const idMatch = await convCol
            .find({ _id: new ObjectId(paddedId) })
            .project({ _id: 1 })
            .toArray();
          idMatch.forEach((c) => segConvIds.add(c._id.toString()));
        } catch {
          // Not a valid ObjectId after padding, skip
        }
      }

      keywordConvIds = [...segConvIds].map((id) => new ObjectId(id));
    }

    // Combine _id filters from sentiment and keyword
    const idFilters: ObjectId[][] = [];
    if (sentimentConvIds) idFilters.push(sentimentConvIds);
    if (keywordConvIds) idFilters.push(keywordConvIds);

    if (idFilters.length === 1) {
      filter._id = { $in: idFilters[0] } as unknown as ObjectId;
    } else if (idFilters.length === 2) {
      // Intersect both ID sets
      const set = new Set(idFilters[0].map((id) => id.toString()));
      const intersection = idFilters[1].filter((id) => set.has(id.toString()));
      filter._id = { $in: intersection } as unknown as ObjectId;
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Execute query
    const [data, total] = await Promise.all([
      convCol
        .find(filter)
        .sort({ started_at: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      convCol.countDocuments(filter),
    ]);

    // Populate agent and customer names for the list view
    const agentIds = [...new Set(data.map((c) => c.agent_id.toString()))];
    const customerIds = [...new Set(data.map((c) => c.customer_id.toString()))];

    const [agentMap, customerMap, tagList, metricsList] = await Promise.all([
      db
        .collection('agents')
        .find({ _id: { $in: agentIds.map((id) => new ObjectId(id)) } })
        .toArray()
        .then((docs) => new Map(docs.map((d) => [d._id.toString(), d.name]))),
      db
        .collection('customers')
        .find({ _id: { $in: customerIds.map((id) => new ObjectId(id)) } })
        .toArray()
        .then((docs) => new Map(docs.map((d) => [d._id.toString(), d.name]))),
      db.collection('tags').find().toArray(),
      db
        .collection('conversation_metrics')
        .find({ conversation_id: { $in: data.map((c) => c._id) } })
        .toArray(),
    ]);

    const tagMap = new Map(tagList.map((t) => [t._id.toString(), t.label]));
    const metricsMap = new Map(
      metricsList.map((m) => [m.conversation_id.toString(), m])
    );

    const enriched = data.map((conv) => {
      const metric = metricsMap.get(conv._id.toString());
      return {
        id: conv._id.toString(),
        customer: customerMap.get(conv.customer_id.toString()) || 'Unknown',
        agent: agentMap.get(conv.agent_id.toString()) || 'Unknown',
        channel: conv.channel,
        startedAt: conv.started_at.toISOString(),
        endedAt: conv.ended_at.toISOString(),
        durationSeconds: conv.duration_seconds,
        status: conv.status,
        tags: conv.tag_ids.map((id) => ({
          id: id.toString(),
          label: tagMap.get(id.toString()) || 'Unknown',
        })),
        sentiment: metric?.sentiment_label || 'neutral',
        sentimentScore: metric?.sentiment_score || 0,
      };
    });

    return { data: enriched, total, page: pageNum, limit: limitNum };
  });

  /**
   * GET /api/conversations/:id
   * Full conversation detail with populated relations.
   */
  app.get('/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    let objectId: ObjectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return reply.status(400).send({ error: 'Invalid conversation ID' });
    }

    const db = await connectDb();
    const conv = await db.collection('conversations').findOne({ _id: objectId });

    if (!conv) {
      return reply.status(404).send({ error: 'Conversation not found' });
    }

    // Fetch all related data in parallel
    const [agent, customer, tagList, segments, audio, metric] = await Promise.all([
      db.collection('agents').findOne({ _id: conv.agent_id }),
      db.collection('customers').findOne({ _id: conv.customer_id }),
      db.collection('tags').find({ _id: { $in: conv.tag_ids } }).toArray(),
      db
        .collection('transcript_segments')
        .find({ conversation_id: objectId })
        .sort({ timestamp_seconds: 1 })
        .toArray(),
      db.collection('audio_files').findOne({ conversation_id: objectId }),
      db.collection('conversation_metrics').findOne({ conversation_id: objectId }),
    ]);

    return {
      id: conv._id.toString(),
      channel: conv.channel,
      startedAt: conv.started_at.toISOString(),
      endedAt: conv.ended_at.toISOString(),
      durationSeconds: conv.duration_seconds,
      status: conv.status,
      agent: agent
        ? { id: agent._id.toString(), name: agent.name, email: agent.email, team: agent.team }
        : null,
      customer: customer
        ? { id: customer._id.toString(), name: customer.name, email: customer.email, phone: customer.phone }
        : null,
      tags: tagList.map((t) => ({ id: t._id.toString(), label: t.label })),
      transcript: segments.map((s) => ({
        speaker: s.speaker,
        timestampSeconds: s.timestamp_seconds,
        text: s.text,
      })),
      audio: audio
        ? { url: audio.url, durationSeconds: audio.duration_seconds, format: audio.format }
        : null,
      sentiment: metric
        ? { score: metric.sentiment_score, label: metric.sentiment_label }
        : null,
      handleTimeSeconds: metric?.handle_time_seconds || conv.duration_seconds,
      firstResponseSeconds: metric?.first_response_seconds || 0,
    };
  });
}
