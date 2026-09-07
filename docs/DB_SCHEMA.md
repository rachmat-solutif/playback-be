# Database Schema Design -- Playback

Scope follows `../README.md`: dummy login, conversation search/filter, audio playback, and a Google-Analytics-style dashboard with Contact Volume (by day/by hour) as the primary trend metric.

This schema is written to be **backend-agnostic** (works for Postgres/MySQL or as a shape for mock JSON). Prototype currently uses mock data in `/src/data`; this doc defines the target shape so swapping in a real DB later is low-effort.

## 1. Entity Overview

| Entity | Purpose |
|---|---|
| `users` | Dummy login accounts (internal staff/admin access to Playback) |
| `agents` | Customer service agents who handled conversations |
| `customers` | End customers who contacted support |
| `conversations` | A single support interaction (call/chat/email) -- core searchable unit |
| `transcript_segments` | Time-stamped lines of dialogue within a conversation |
| `audio_files` | Audio recording metadata + file reference, linked to a conversation |
| `tags` | Reusable labels (topic/category) for conversations |
| `conversation_tags` | Join table: conversations <-> tags (many-to-many) |
| `conversation_metrics` | Precomputed per-conversation metrics (duration, sentiment, handle time) used for fast filtering/search |

## 2. Table Definitions

### `users`
*Dummy login only -- not real auth in prototype (hardcoded `user`/`user`), but shaped like a real table for future replacement.*

| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `username` | VARCHAR(50), unique | |
| `password_hash` | VARCHAR(255) | Prototype: unused/dummy. Real impl: bcrypt hash |
| `role` | ENUM(`admin`, `viewer`) | For future permission scoping |
| `created_at` | TIMESTAMP | |

### `agents`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `name` | VARCHAR(100) | |
| `email` | VARCHAR(100) | |
| `team` | VARCHAR(100) | Optional, for filtering by team |
| `avatar_url` | TEXT | Optional |

### `customers`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `name` | VARCHAR(100) | |
| `email` | VARCHAR(100) | |
| `phone` | VARCHAR(30) | Nullable |
| `created_at` | TIMESTAMP | First seen date |

### `conversations`
*Core table -- what search/filter and the detail page revolve around.*

| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `customer_id` | UUID, FK -> `customers.id` | |
| `agent_id` | UUID, FK -> `agents.id` | |
| `channel` | ENUM(`call`, `chat`, `email`) | For channel breakdown in analytics |
| `started_at` | TIMESTAMP | Used for date-range filter + day/hour aggregation |
| `ended_at` | TIMESTAMP | |
| `duration_seconds` | INTEGER | Derived from started/ended, denormalized for fast filtering |
| `status` | ENUM(`resolved`, `unresolved`, `escalated`) | |
| `created_at` | TIMESTAMP | |

**Indexes:** `started_at` (critical -- powers date-range filter, day/hour trend queries), `customer_id`, `agent_id`, `channel`, `status`.

### `transcript_segments`
*Enables keyword search within a conversation's dialogue.*

| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `conversation_id` | UUID, FK -> `conversations.id` | |
| `speaker` | ENUM(`agent`, `customer`) | |
| `timestamp_seconds` | INTEGER | Offset from conversation start -- used to jump the audio player to this point |
| `text` | TEXT | Searchable transcript line |

**Indexes:** full-text index on `text` (e.g., Postgres `tsvector` or equivalent) for keyword search; `conversation_id`.

### `audio_files`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `conversation_id` | UUID, FK -> `conversations.id`, unique | One audio file per conversation (prototype assumption) |
| `url` | TEXT | Path/URL to audio file (local mode: `/audio/...`; Azure mode: compatibility reference) |
| `blob_name` | TEXT | Optional container-relative Azure Blob name, such as `<conversation_id>.wav` |
| `duration_seconds` | INTEGER | |
| `format` | VARCHAR(10) | e.g., `mp3`, `wav` |

### `tags`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID / PK | |
| `label` | VARCHAR(50), unique | e.g., "billing", "refund", "login issue" |

### `conversation_tags`
| Column | Type | Notes |
|---|---|---|
| `conversation_id` | UUID, FK -> `conversations.id` | |
| `tag_id` | UUID, FK -> `tags.id` | |

Composite PK: (`conversation_id`, `tag_id`).

### `conversation_metrics`
*Precomputed/denormalized values so search and analytics stay fast without recalculating on every query.*

| Column | Type | Notes |
|---|---|---|
| `conversation_id` | UUID, FK -> `conversations.id`, PK | |
| `sentiment_score` | DECIMAL(3,2) | e.g., -1.00 to 1.00 |
| `sentiment_label` | ENUM(`positive`, `neutral`, `negative`) | Used for search filter + badge color |
| `handle_time_seconds` | INTEGER | May differ from raw duration (e.g., excludes hold time) |
| `first_response_seconds` | INTEGER | Optional, nice-to-have metric |

## 3. Relationships (ERD summary)

```
customers 1---* conversations *---1 agents
conversations 1---1 audio_files
conversations 1---* transcript_segments
conversations 1---1 conversation_metrics
conversations *---* tags   (via conversation_tags)
```

## 4. Mapping to App Features

| Feature | Tables involved |
|---|---|
| Advanced search (agent, customer, date, duration, tags, sentiment, keyword) | `conversations`, `agents`, `customers`, `tags`/`conversation_tags`, `conversation_metrics`, `transcript_segments` |
| Audio playback | `audio_files`, `transcript_segments` (for jump-to-timestamp) |
| Date range filter (main scope control) | `conversations.started_at` |
| Contact Volume by day/hour | Aggregate `COUNT(conversations.id)` grouped by `DATE(started_at)` or `HOUR(started_at)`, within the selected date range |
| Dummy login | `users` |

## 5. Sample Aggregation Query (Contact Volume)

**By day:**
```sql
SELECT DATE(started_at) AS day, COUNT(*) AS contact_count
FROM conversations
WHERE started_at BETWEEN :range_start AND :range_end
GROUP BY DATE(started_at)
ORDER BY day;
```

**By hour (to find peak hours):**
```sql
SELECT EXTRACT(HOUR FROM started_at) AS hour_of_day, COUNT(*) AS contact_count
FROM conversations
WHERE started_at BETWEEN :range_start AND :range_end
GROUP BY EXTRACT(HOUR FROM started_at)
ORDER BY hour_of_day;
```

## 6. Mock Data Notes (Prototype Stage)

- Mirror these table shapes as JS/JSON objects in `/src/data` (e.g., `conversations.js`, `agents.js`, `customers.js`).
- Flatten relations in mock data for convenience (e.g., embed `agentName` directly on a mock conversation object) but keep IDs too, so real API integration later is a straightforward mapping.
- Generate enough mock conversations (suggest 100-300) spread across varied dates/hours so the Contact Volume charts show a believable trend rather than flat/empty data.

## 7. Out of Scope (for now)
- Real database provisioning/migrations
- User roles/permissions beyond a single dummy login
- Multi-tenant support
- Data retention/archival policies

---
*Update this file as Playback's data needs evolve.*
