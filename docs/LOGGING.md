# Logging Architecture

Structured, transaction-based logging for Grafana/Loki observability.

## Log Format

Every log line is a flat JSON object -- no nested `req`/`res` wrappers.

```json
{
  "level": 30,
  "time": 1781860724301,
  "service": "playback-server",
  "env": "development",
  "transactionId": "SRV1781860724293001",
  "deviceId": "",
  "data": {
    "method": "GET",
    "path": "/api/audio/abc123",
    "status": 200,
    "latency_ms": 42
  },
  "msg": "request completed"
}
```

### Base Fields (every log line)

| Field | Source | Description |
|-------|--------|-------------|
| `level` | Auto | Numeric severity (10=trace, 20=debug, 30=info, 40=warn, 50=error) |
| `time` | Auto | Unix epoch ms -- used for Grafana time-range queries |
| `service` | Base binding | Primary Loki label -- set via `SERVICE_NAME` |
| `env` | Base binding | `production`, `development` -- environment filter |

### Transaction Fields (per-request/cycle)

| Field | Source | Description |
|-------|--------|-------------|
| `transactionId` | Child binding | Correlation ID for the full request/operation lifecycle |
| `deviceId` | Child binding | Device / user identifier (empty until auth resolves) |

### Structured Data (per-event)

| Field | Source | Description |
|-------|--------|-------------|
| `data` | Per-call | Object containing event-specific payload fields (`eventCode`, business fields) |

---

## Transaction ID Format

```
{PREFIX}{EPOCH_MS}{3DIGIT_SEQ}
```

No dashes, no identity segment. The prefix is a short service code defined per project.

The 3-digit sequence increments per millisecond to ensure uniqueness when multiple IDs
are generated in the same millisecond window.

### Prefix Convention

| Prefix | Service | Scope |
|--------|---------|-------|
| `SRV` | Base server | Generic HTTP request |

### Examples

```
SRV1781860724293000     -> HTTP request
```

All logs within the same transaction share the **same timestamp** in the ID, making Loki queries trivial:

```logql
{service="playback-server"} |= "SRV1781860724293001"
```

---

## Log Levels

Default: `LOG_LEVEL=info`. Switch to `debug` for diagnostics.

### `info` -- Production Visible

| Message | When | Key Fields |
|---------|------|------------|
| `incoming request` | Every HTTP request start | `method`, `path` |
| `request completed` | Every HTTP request end | `method`, `path`, `status`, `latency_ms` |
| `Shutting down...` | SIGTERM/SIGINT | -- |
| `Connected to MongoDB` | App startup, MongoDB connected | -- |
| `SAS URL generated` | Blob SAS URL issued | `userId`, `conversationId`, `blobName` |

### `debug` -- Diagnostic Mode

Switch to `LOG_LEVEL=debug` when troubleshooting production issues.

| Message | Debugs... | Key Fields |
|---------|-----------|------------|
| `audio file resolved` | Audio file lookup | `conversationId`, `blobName`, `storageType` |
| `audio file not found` | Audio file not found | `conversationId`, `blobName` or `filePath` |
| `import job started` | Import pipeline start | `method`, `path` or `jobId`, `total` |
| `import job completed` | Import pipeline done | `jobId`, `imported` |

### `warn` -- Non-Fatal Problems

| Area | Message | Fields |
|------|---------|--------|
| Server | `SESSION_KEY/SESSION_PASSWORD not set -- session plugin not registered` | -- |
| Import | `import job failed` | `jobId`, `index`, `error` |
| Import | `Import payload rejected schema validation` | `issues` |

### `error` -- Critical Failures

| Area | Message | Fields |
|------|---------|--------|
| Server | `Entra ID callback error` | `err` |
| Server | `SAS generation failed` | `conversationId`, `blobName` |
| Import | `Import job crashed` | `jobId` |

---

## PII Redaction

Pino redact rules strip sensitive JSON object fields before serialization:

```
*.clientSecret
*.accessToken
*.authorization
*.phone
*.customerName
*.password
*.code
*.session_state
*.client_info
*.state
```

Each field is redacted at root level, one level deep (`data.phone`), two levels deep, and three levels deep.

Additionally, the `path` field in request logs is sanitized at the source (`app.ts` `onRequest`/`onResponse` hooks) to strip sensitive query parameters (`code`, `session_state`, `client_info`, `state`, `clientdata`) before logging. This catches values embedded in URL query strings where Pino's redact (which operates on JSON keys) would not reach.

---

## Grafana / Loki Strategy

### Recommended Labels

```yaml
labels:
  service: playback-server
  env: production | development
```

### Useful LogQL Queries

```logql
# All logs for a specific transaction
{service="playback-server"} |= "SRV1781860724293001"

# Error rate
sum(rate({service="playback-server"} | json | level >= 50 [5m]))

# Request latency (p95)
{service="playback-server"} | json | msg="request completed"
  | unwrap latency_ms | quantile_over_time(0.95, [5m])

# Failed audio requests
{service="playback-server"} | json | msg="request completed"
  | json | status >= 500

# Auth failures (should trigger alert)
{service="playback-server"} | json | msg="Authentication failed"

# Import job failures
{service="playback-server"} | json | msg="import job failed"
```

### Recommended Dashboards

1. **Request Latency** -- `request completed` rate + p50/p95/p99 `latency_ms`
2. **Error Budget** -- warn/error rate ratio
3. **Graceful Shutdown** -- `Shutting down gracefully` timeline
4. **Audio Storage Health** -- SAS generation success/failure rate
5. **Import Pipeline** -- import jobs started/completed/failed over time

---

## Debugging Runbook

All queries use `msg=~` (regex match) to avoid exact-match failures. Replace `<txn>` with a known `transactionId`.

### "Audio not accessible -- 503 errors"

```logql
# Check SAS generation failures
{service="playback-server"} | json | msg=~"SAS.*failed"

# Check audio file not found (debug level)
{service="playback-server"} | json | msg=~"audio file not found"

# Check audio resolution (debug level)
{service="playback-server"} | json | msg=~"audio file resolved"
```

### "Import jobs stuck or failing"

```logql
# Check import job lifecycle
{service="playback-server"} | json | msg=~"import job.*"

# Check import job crashes
{service="playback-server"} | json | msg=~"Import job crashed"

# Check schema validation failures
{service="playback-server"} | json | msg=~"Import payload rejected"
```

### "Authentication failing"

```logql
# Check Entra ID callback errors
{service="playback-server"} | json | msg=~"Entra.*error"

# Check session plugin not registered
{service="playback-server"} | json | msg=~"SESSION_KEY.*not set"
```

### "Server startup / shutdown issues"

```logql
# Check MongoDB connection
{service="playback-server"} | json | msg="Connected to MongoDB"

# Check graceful shutdown
{service="playback-server"} | json | msg="Shutting down"
```

### General request tracing

```logql
# All requests matching a transaction ID
{service="playback-server"} | json | msg=~"incoming request|request completed"
  | json | transactionId="<txn>"
```

---

## Implementation

### Files Changed

| File | Change |
|------|--------|
| `src/server/lib/transaction-id.ts` | New -- Transaction ID generator (`{prefix}{epoch_ms}{3digit_seq}`) |
| `src/server/plugins/logger.ts` | New -- `createLogger({ service, env, level })` with PII redaction |
| `src/server/config.ts` | Modified -- Added `LOG_LEVEL` and `SERVICE_NAME` env vars |
| `src/server/app.ts` | Modified -- Disabled Fastify built-in HTTP logging; integrated Pino via `createLogger`; added `onRequest` hook (transaction ID child logger + `incoming request` log); added `onResponse` hook (`request completed` with latency); `sanitizePath` strips sensitive query params (`code`, `session_state`, `client_info`, `state`, `clientdata`) from `path` before logging; server-level logs use module-level `logger` directly |
| `src/server/routes/audio.ts` | Modified -- Replaced `app.log` with `request.log`; added debug logs for audio resolution, SAS generation |
| `src/server/auth/session.ts` | Unchanged -- `app.log.warn` stays at app level (called during startup, no request context) |
| `src/server/auth/entra.ts` | Modified -- Replaced `app.log.error` with `request.log.error` |
| `src/server/routes/import.ts` | Modified -- Added lifecycle logs: `import job started/completed/failed`, `Import payload rejected`, `Import job crashed`; background bulk import uses child logger from `request.log` for correlation |
| `src/server/storage/blob.ts` | Unchanged -- Pure utility; logging handled at call sites |
| `src/server/storage/remote-audio.ts` | Unchanged -- Pure utility; logging handled at call sites |
| `src/server/routes/import-jobs.ts` | Unchanged -- Pure in-memory job store, no logging needed |

### Deviations from Original Spec

1. **Fastify built-in HTTP logging**: Completely disabled (`logger: false`) to avoid duplicate `incoming request` / `request completed` logs from Pino's http module. All request logging is handled by our `onRequest` / `onResponse` hooks.
2. **Storage files**: No direct `request.log` calls -- these are pure utility functions called from both request and background context (`setImmediate`). Logging is handled at call sites (`audio.ts`, `import.ts`) instead. If storage-level logs are needed in future, the logger can be passed as an optional parameter.
3. **Latency measurement**: `request.elapsedTime` accessed via `(req as any).elapsedTime` due to Fastify TypeScript type constraints -- value is always a number at runtime.
4. **Session lifecycle logs**: `session created` / `session destroyed` debug logs not yet added -- `setSession` / `getSession` are called from auth routes which already have `request.log`, so these can be added if needed.
5. **Log level**: `LOG_LEVEL` is read at module load time. Changing it requires a server restart.
6. **Transaction ID trace**: Verified in test output -- every `incoming request` / `request completed` pair shares the same `transactionId`. Background jobs use a child logger from the originating request's `request.log` for correlation.
7. **PII redaction**: Verified via manual test -- JSON object fields at root, one, two, and three levels of nesting are redacted as `[Redacted]`. URL query parameters in `path` are sanitized at the logging hook via `sanitizePath`, stripping `code`, `session_state`, `client_info`, `state`, and `clientdata`.

### Build & Test

- `npm run build` -- passes cleanly
- `npm run test:server` -- 65 tests pass

## Example Logs (staging)

```
deploy@playback-staging-vm:~$ journalctl -f -u playback.service
Aug 10 03:06:56 playback-staging-vm node[3874]: {"level":30,"time":1786331216533,"service":"playback-server","env":"staging","msg":"Shutting down..."}
Aug 10 03:06:56 playback-staging-vm systemd[1]: playback.service: Deactivated successfully.
Aug 10 03:06:56 playback-staging-vm systemd[1]: Stopped playback.service - Playback Web Server.
Aug 10 03:06:56 playback-staging-vm systemd[1]: playback.service: Consumed 2.373s CPU time.
Aug 10 03:06:56 playback-staging-vm systemd[1]: Started playback.service - Playback Web Server.
Aug 10 03:06:58 playback-staging-vm node[4230]: {"level":30,"time":1786331218070,"service":"playback-server","env":"staging","msg":"Connected to MongoDB"}
Aug 10 03:06:58 playback-staging-vm node[4230]: {"level":30,"time":1786331218077,"service":"playback-server","env":"staging","msg":"Server listening at http://0.0.0.0:3000"}
Aug 10 03:06:58 playback-staging-vm node[4230]: {"level":30,"time":1786331218078,"service":"playback-server","env":"staging","msg":"Server listening on http://localhost:3000"}
Aug 10 03:06:59 playback-staging-vm node[4230]: {"level":30,"time":1786331219981,"service":"playback-server","env":"staging","transactionId":"SRV1786331219980000","data":{"method":"GET","path":"/health"},"msg":"incoming request"}
Aug 10 03:06:59 playback-staging-vm node[4230]: {"level":30,"time":1786331219990,"service":"playback-server","env":"staging","transactionId":"SRV1786331219980000","data":{"method":"GET","path":"/health","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234450,"service":"playback-server","env":"staging","transactionId":"SRV1786331234450000","data":{"method":"GET","path":"/auth/callback"},"msg":"incoming request"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234706,"service":"playback-server","env":"staging","transactionId":"SRV1786331234450000","data":{"method":"GET","path":"/auth/callback","status":302,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234737,"service":"playback-server","env":"staging","transactionId":"SRV1786331234737000","data":{"method":"GET","path":"/"},"msg":"incoming request"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234754,"service":"playback-server","env":"staging","transactionId":"SRV1786331234737000","data":{"method":"GET","path":"/","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234834,"service":"playback-server","env":"staging","transactionId":"SRV1786331234834000","data":{"method":"GET","path":"/assets/index-DzNFqCuE.js"},"msg":"incoming request"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234844,"service":"playback-server","env":"staging","transactionId":"SRV1786331234844000","data":{"method":"GET","path":"/assets/index-CZHKqla-.css"},"msg":"incoming request"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234855,"service":"playback-server","env":"staging","transactionId":"SRV1786331234834000","data":{"method":"GET","path":"/assets/index-DzNFqCuE.js","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234857,"service":"playback-server","env":"staging","transactionId":"SRV1786331234844000","data":{"method":"GET","path":"/assets/index-CZHKqla-.css","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234925,"service":"playback-server","env":"staging","transactionId":"SRV1786331234925000","data":{"method":"GET","path":"/auth/me"},"msg":"incoming request"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234928,"service":"playback-server","env":"staging","transactionId":"SRV1786331234925000","data":{"method":"GET","path":"/auth/me","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:14 playback-staging-vm node[4230]: {"level":30,"time":1786331234945,"service":"playback-server","env":"staging","transactionId":"SRV1786331234945000","data":{"method":"GET","path":"/api/conversations?page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:15 playback-staging-vm node[4230]: {"level":30,"time":1786331235319,"service":"playback-server","env":"staging","transactionId":"SRV1786331234945000","data":{"method":"GET","path":"/api/conversations?page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:18 playback-staging-vm node[4230]: {"level":30,"time":1786331238762,"service":"playback-server","env":"staging","transactionId":"SRV1786331238762000","data":{"method":"GET","path":"/api/conversations?from=2026-05-12&to=2026-08-10&page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:18 playback-staging-vm node[4230]: {"level":30,"time":1786331238813,"service":"playback-server","env":"staging","transactionId":"SRV1786331238762000","data":{"method":"GET","path":"/api/conversations?from=2026-05-12&to=2026-08-10&page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:22 playback-staging-vm node[4230]: {"level":30,"time":1786331242693,"service":"playback-server","env":"staging","transactionId":"SRV1786331242692000","data":{"method":"GET","path":"/api/conversations?keyword=S&from=2026-05-12&to=2026-08-10&page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:22 playback-staging-vm node[4230]: {"level":30,"time":1786331242882,"service":"playback-server","env":"staging","transactionId":"SRV1786331242692000","data":{"method":"GET","path":"/api/conversations?keyword=S&from=2026-05-12&to=2026-08-10&page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:22 playback-staging-vm node[4230]: {"level":30,"time":1786331242905,"service":"playback-server","env":"staging","transactionId":"SRV1786331242905000","data":{"method":"GET","path":"/api/conversations?keyword=Sa&from=2026-05-12&to=2026-08-10&page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:23 playback-staging-vm node[4230]: {"level":30,"time":1786331243003,"service":"playback-server","env":"staging","transactionId":"SRV1786331243003000","data":{"method":"GET","path":"/api/conversations?keyword=Sam&from=2026-05-12&to=2026-08-10&page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:23 playback-staging-vm node[4230]: {"level":30,"time":1786331243142,"service":"playback-server","env":"staging","transactionId":"SRV1786331243003000","data":{"method":"GET","path":"/api/conversations?keyword=Sam&from=2026-05-12&to=2026-08-10&page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:23 playback-staging-vm node[4230]: {"level":30,"time":1786331243224,"service":"playback-server","env":"staging","transactionId":"SRV1786331242905000","data":{"method":"GET","path":"/api/conversations?keyword=Sa&from=2026-05-12&to=2026-08-10&page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:25 playback-staging-vm node[4230]: {"level":30,"time":1786331245146,"service":"playback-server","env":"staging","transactionId":"SRV1786331245145000","data":{"method":"GET","path":"/api/conversations/00000000000000000000005b"},"msg":"incoming request"}
Aug 10 03:07:25 playback-staging-vm node[4230]: {"level":30,"time":1786331245341,"service":"playback-server","env":"staging","transactionId":"SRV1786331245145000","data":{"method":"GET","path":"/api/conversations/00000000000000000000005b","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:25 playback-staging-vm node[4230]: {"level":30,"time":1786331245355,"service":"playback-server","env":"staging","transactionId":"SRV1786331245355000","data":{"method":"GET","path":"/api/audio/00000000000000000000005b"},"msg":"incoming request"}
Aug 10 03:07:25 playback-staging-vm node[4230]: {"level":30,"time":1786331245391,"service":"playback-server","env":"staging","transactionId":"SRV1786331245355000","data":{"userId":"ce5bf6e9-ba40-4bc6-88f7-90a4590cd25b","conversationId":"00000000000000000000005b","blobName":"00000000000000000000005b.wav"},"msg":"SAS URL generated"}
Aug 10 03:07:25 playback-staging-vm node[4230]: {"level":30,"time":1786331245392,"service":"playback-server","env":"staging","transactionId":"SRV1786331245355000","data":{"method":"GET","path":"/api/audio/00000000000000000000005b","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:40 playback-staging-vm node[4230]: {"level":30,"time":1786331260693,"service":"playback-server","env":"staging","transactionId":"SRV1786331260693000","data":{"method":"GET","path":"/api/conversations?page=1&limit=20"},"msg":"incoming request"}
Aug 10 03:07:40 playback-staging-vm node[4230]: {"level":30,"time":1786331260738,"service":"playback-server","env":"staging","transactionId":"SRV1786331260693000","data":{"method":"GET","path":"/api/conversations?page=1&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:54 playback-staging-vm node[4230]: {"level":30,"time":1786331274377,"service":"playback-server","env":"staging","transactionId":"SRV1786331274377000","data":{"method":"GET","path":"/api/conversations?page=2&limit=20"},"msg":"incoming request"}
Aug 10 03:07:54 playback-staging-vm node[4230]: {"level":30,"time":1786331274455,"service":"playback-server","env":"staging","transactionId":"SRV1786331274377000","data":{"method":"GET","path":"/api/conversations?page=2&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:54 playback-staging-vm node[4230]: {"level":30,"time":1786331274562,"service":"playback-server","env":"staging","transactionId":"SRV1786331274562000","data":{"method":"GET","path":"/api/conversations?page=3&limit=20"},"msg":"incoming request"}
Aug 10 03:07:54 playback-staging-vm node[4230]: {"level":30,"time":1786331274605,"service":"playback-server","env":"staging","transactionId":"SRV1786331274562000","data":{"method":"GET","path":"/api/conversations?page=3&limit=20","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:57 playback-staging-vm node[4230]: {"level":30,"time":1786331277872,"service":"playback-server","env":"staging","transactionId":"SRV1786331277872000","data":{"method":"GET","path":"/auth/logout"},"msg":"incoming request"}
Aug 10 03:07:57 playback-staging-vm node[4230]: {"level":30,"time":1786331277875,"service":"playback-server","env":"staging","transactionId":"SRV1786331277872000","data":{"method":"GET","path":"/auth/logout","status":302,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279832,"service":"playback-server","env":"staging","transactionId":"SRV1786331279832000","data":{"method":"GET","path":"/auth/logout/callback?sid=007ba08a-8f63-3762-bc19-02d4203a2aa3"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279834,"service":"playback-server","env":"staging","transactionId":"SRV1786331279832000","data":{"method":"GET","path":"/auth/logout/callback?sid=007ba08a-8f63-3762-bc19-02d4203a2aa3","status":302,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279842,"service":"playback-server","env":"staging","transactionId":"SRV1786331279842000","data":{"method":"GET","path":"/"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279846,"service":"playback-server","env":"staging","transactionId":"SRV1786331279842000","data":{"method":"GET","path":"/","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279866,"service":"playback-server","env":"staging","transactionId":"SRV1786331279865000","data":{"method":"GET","path":"/assets/index-DzNFqCuE.js"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279870,"service":"playback-server","env":"staging","transactionId":"SRV1786331279870000","data":{"method":"GET","path":"/assets/index-CZHKqla-.css"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279873,"service":"playback-server","env":"staging","transactionId":"SRV1786331279865000","data":{"method":"GET","path":"/assets/index-DzNFqCuE.js","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279875,"service":"playback-server","env":"staging","transactionId":"SRV1786331279870000","data":{"method":"GET","path":"/assets/index-CZHKqla-.css","status":200,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279959,"service":"playback-server","env":"staging","transactionId":"SRV1786331279959000","data":{"method":"GET","path":"/auth/me"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279960,"service":"playback-server","env":"staging","transactionId":"SRV1786331279959000","data":{"method":"GET","path":"/auth/me","status":401,"latency_ms":null},"msg":"request completed"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279977,"service":"playback-server","env":"staging","transactionId":"SRV1786331279977000","data":{"method":"GET","path":"/auth/login"},"msg":"incoming request"}
Aug 10 03:07:59 playback-staging-vm node[4230]: {"level":30,"time":1786331279981,"service":"playback-server","env":"staging","transactionId":"SRV1786331279977000","data":{"method":"GET","path":"/auth/login","status":302,"latency_ms":null},"msg":"request completed"}
```

Notable patterns in these logs:

- **Server restart**: `Shutting down...` at 03:06:56, systemd stops and restarts the service, then `Connected to MongoDB` + `Server listening` confirm the new process is up.
- **Health check**: `npm run gcloud:deploy` triggers `curl /health` after restart, returning `200` in ~9ms.
- **Sanitized auth callback**: The `/auth/callback` path has `code`, `state`, `session_state`, `client_info`, and `clientdata` stripped from the query string -- only `/auth/callback` appears in the log. Confirmed working after `sanitizePath` fix in `app.ts`.
- **Logout callback**: `sid` is retained (non-sensitive session identifier), so `/auth/logout/callback?sid=007ba08a-...` is still logged.
- **Auth flow**: `/auth/me` returns `401` before login, `200` after successful Entra ID callback. After login the frontend makes two rapid `/auth/me` calls (guard + component mount).
- **Search with keyword + date range**: `/api/conversations?keyword=S&from=2026-05-12&to=2026-08-10&page=1&limit=20` shows the user filtering by both keyword and date range, each returning `200`.
- **Pagination**: Pages 1-3 of `/api/conversations?page=N&limit=20` returned `200` -- user is browsing the full list.
- **SAS URL**: The `SAS URL generated` log sits between the incoming request and request completed for `/api/audio/*`.
- **Static assets**: Frontend bundles and CSS served with `200` on first load; no `304` repeats in this session (new deploy cleared caches).
