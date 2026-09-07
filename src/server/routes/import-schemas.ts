import { z } from 'zod';
import { isAllowedAudioFormat, validateBlobName } from '../storage/audio-policy.js';

// Reusable hex string validator for ObjectId references
const objectIdStr = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex string');

// Transcript segment input
const transcriptSegmentSchema = z.object({
  speaker: z.enum(['agent', 'customer']),
  timestamp_seconds: z.number().int().min(0),
  text: z.string().min(1).max(5000),
});

// Metrics input
const metricsSchema = z.object({
  sentiment_score: z.number().min(-1).max(1),
  sentiment_label: z.enum(['positive', 'neutral', 'negative']),
  handle_time_seconds: z.number().int().min(0),
  first_response_seconds: z.number().int().min(0),
});

// Audio input -- use url for local paths, blob_name for existing Azure blobs,
// or remote_url for a server-side HTTPS download and Azure upload.
export const audioSchema = z
  .object({
    url: z.string().min(1).optional(),
    blob_name: z.string().min(1).max(1024).optional(),
    remote_url: z.string().min(1).url().optional(),
    format: z.string().min(1).max(10).optional(),
  })
  .superRefine((value, ctx) => {
    const sources = [value.url, value.blob_name, value.remote_url].filter(
      (source): source is string => Boolean(source),
    );
    if (sources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Provide exactly one of url, blob_name, or remote_url',
      });
    }

    if (value.blob_name) {
      try {
        validateBlobName(value.blob_name);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blob_name'],
          message: error instanceof Error ? error.message : 'Invalid blob name',
        });
      }
    }

    if (value.remote_url) {
      try {
        const parsed = new URL(value.remote_url);
        if (parsed.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remote_url'],
            message: 'Remote audio URL must use HTTPS',
          });
        }
        if (parsed.username || parsed.password || parsed.hash) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remote_url'],
            message: 'Remote audio URL must not contain credentials or a fragment',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remote_url'],
          message: 'Remote audio URL is invalid',
        });
      }
    }

    if (value.format && !isAllowedAudioFormat(value.format)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['format'],
        message: 'Unsupported audio format',
      });
    }
  });

// Inline agent data -- resolved by email (upsert)
const agentSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  team: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().optional(),
});

// Inline customer data -- resolved by phone (upsert)
const customerSchema = z.object({
  phone: z.number().int().positive(),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
});

// Single conversation import payload
const conversationDataSchema = z.object({
  customer: customerSchema,
  agent: agentSchema,
  channel: z.enum(['call', 'chat', 'email']).default('call'),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  status: z.enum(['resolved', 'unresolved', 'escalated']).default('resolved'),
  tags: z.array(z.string().min(1)).default([]),
  external_id: z.string().min(1).optional(),
});

export const importSingleSchema = z.object({
  conversation: conversationDataSchema,
  transcript: z.array(transcriptSegmentSchema).optional(),
  metrics: metricsSchema.optional(),
  audio: audioSchema.optional(),
});

export const importBulkSchema = z.object({
  conversations: z.array(importSingleSchema).min(1).max(10000),
});

export type ImportSingleInput = z.infer<typeof importSingleSchema>;
export type ImportBulkInput = z.infer<typeof importBulkSchema>;
