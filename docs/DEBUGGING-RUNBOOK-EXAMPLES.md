# Debugging Runbook -- Example Cases

Real-world examples and localhost reproduction steps for every Debugging Runbook case in `docs/LOGGING.md`.

> **Prerequisites** -- A running local server on `http://localhost:3000` with the test database seeded.
> Logs appear on stdout; each line is a JSON object (Pino format). All examples below assume you are tailing logs with `cat` or a JSON log viewer.

---

## 1. Audio Not Accessible -- 503 Errors

**Symptom:** A user clicks "Play" on a conversation in the UI and receives a `503 Service Unavailable` error, or the audio URL fails to load.

### Real-world Example

A customer-service manager tries to play back a call recording from a conversation that was imported last week. The player shows "Audio unavailable -- please try again later." In Grafana/Loki the only evidence is a `503` on `GET /api/audio/<conversationId>`.

### Loki Query

```logql
# Find the failing request and all subsequent errors for that transaction
{service="playback-server"} | json | msg=~"SAS.*failed"
```

### Localhost Reproduction

#### Case A: Blob SAS generation fails (missing Azure config)

1. Start the server with Azure Blob Storage configured:
   ```bash
   AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=localtest;AccountKey=invalid-key;" \
   AZURE_STORAGE_CONTAINER="audio" \
   npm run dev
   ```
2. Make a request for any conversation with an audio file:
   ```bash
   curl -s http://localhost:3000/api/audio/dddddddddddddddddddd01
   ```
3. **Expected result:** `404` or an error body. The server logs an error line:
   ```json
   {"level":50,"service":"playback-server","msg":"SAS generation failed","data":{"conversationId":"dddddddddddddddddddddd01","blobName":"audio_files/dddddddddddddddddddd01"}}
   ```

#### Case B: Audio file not found in storage

1. Start the server normally:
   ```bash
   npm run dev
   ```
2. Delete the audio record for a conversation from MongoDB:
   ```bash
   npm run db:clear
   npm run db:seed
   mongo --eval "db.audio_files.deleteOne({_id: ObjectId('ffffffffffffff...')})"
   ```
3. Request the audio for that conversation:
   ```bash
   curl -s http://localhost:3000/api/audio/dddddddddddddddddddd01
   ```
4. **Expected result:** `404`. In Loki:
   ```logql
   {service="playback-server"} | json | msg=~"audio file not found"
   ```
   Returns a log line with `conversationId` and either `blobName` or `filePath`.

---

## 2. Import Jobs Stuck or Failing

**Symptom:** Bulk import jobs submitted via `POST /api/import` appear to hang, return errors, or never complete. The UI shows "Importing..." indefinitely.

### Real-world Example

A data team submits a bulk import of 500 call recordings from an external system. The API returns `201` for the first 300 jobs, then starts returning `422` errors for the remaining 200. No obvious crash log appears in the application output.

### Loki Query

```logql
# Full import job lifecycle (all log levels)
{service="playback-server"} | json | msg=~"import job.*"

# Schema validation rejections
{service="playback-server"} | json | msg=~"Import payload rejected"

# Unrecoverable crashes
{service="playback-server"} | json | msg=~"Import job crashed"
```

### Localhost Reproduction

#### Case A: Schema validation rejection

1. Start the server:
   ```bash
   npm run dev
   ```
2. Submit an import with an HTTP (not HTTPS) remote URL:
   ```bash
   curl -s -X POST http://localhost:3000/api/import \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer your-32-char-or-longer-key" \
     -d '{
       "conversations": [{
         "conversation": {
           "customer": {"phone": 1555000200, "name": "Test Customer"},
           "agent": {"email": "agent@company.com", "name": "Test Agent"},
           "channel": "call",
           "started_at": "2026-07-20T09:00:00Z",
           "ended_at": "2026-07-20T09:05:00Z"
         },
         "audio": {"remote_url": "http://insecure.example.com/call.mp3"}
       }]
     }'
   ```
3. **Expected result:** `422` with `error` containing "remote URLs must be HTTPS". Loki shows:
   ```logql
   {service="playback-server"} | json | msg=~"Import payload rejected"
   ```

#### Case B: Missing Azure blob

1. Configure Azure connection but reference a blob that does not exist:
   ```bash
   curl -s -X POST http://localhost:3000/api/import \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer your-32-char-or-longer-key" \
     -d '{
       "conversations": [{
         "conversation": {
           "customer": {"phone": 1555000200, "name": "Test Customer"},
           "agent": {"email": "agent@company.com", "name": "Test Agent"},
           "channel": "call",
           "started_at": "2026-07-20T09:00:00Z",
           "ended_at": "2026-07-20T09:05:00Z"
         },
         "audio": {"blob_name": "imports/nonexistent.wav", "format": "wav"}
       }]
     }'
   ```
2. **Expected result:** `422` with `"error": "...does not exist"`.

---

## 3. Authentication Failing

**Symptom:** Users see "Unauthorized" errors when accessing the API, or they are unable to log in via Entra ID. Session cookies are not being set.

### Real-world Example

A support agent tries to access the conversation list in the browser. The page loads but every API call returns `401 Unauthorized`. No errors appear in the console -- the login flow completed silently but no session was created.

### Loki Query

```logql
# Entra ID callback errors
{service="playback-server"} | json | msg=~"Entra.*error"

# Session plugin not registered (startup warning)
{service="playback-server"} | json | msg=~"SESSION_KEY.*not set"
```

### Localhost Reproduction

#### Case A: Missing session configuration

1. Set `AUTH_PROVIDER=entra` but omit `SESSION_KEY` and `SESSION_PASSWORD`:
   ```bash
   AUTH_PROVIDER=entra \
   ENTRA_CLIENT_ID="fake" \
   ENTRA_TENANT_ID="fake" \
   ENTRA_CLIENT_SECRET="fake" \
   ENTRA_REDIRECT_URI="http://localhost:3000/auth/callback" \
   npm run dev
   ```
2. **Expected result:** The server logs a warning during startup:
   ```json
   {"level":40,"msg":"SESSION_KEY/SESSION_PASSWORD not set -- session plugin not registered"}
   ```
   All authenticated API calls return `401`.

#### Case B: Entra ID callback error

1. Configure Entra with invalid credentials and attempt login:
   ```bash
   AUTH_PROVIDER=entra \
   ENTRA_CLIENT_ID="00000000-0000-0000-0000-000000000000" \
   ENTRA_TENANT_ID="00000000-0000-0000-0000-000000000000" \
   ENTRA_CLIENT_SECRET="invalid-secret" \
   ENTRA_REDIRECT_URI="http://localhost:3000/auth/callback" \
   SESSION_KEY="aabbccdd...64chars" \
   SESSION_PASSWORD="secret" \
   npm run dev
   ```
2. Visit `http://localhost:3000/auth/login` and complete the Entra flow (or trigger the callback directly).
3. **Expected result:** A `401` response and an error log:
   ```json
   {"level":50,"msg":"Entra ID callback error","err":{"message":"...","stack":"..."}}
   ```

---

## 4. Server Startup / Shutdown Issues

**Symptom:** The server fails to start, or crashes on shutdown without draining active connections. MongoDB appears connected in the startup log but queries time out.

### Real-world Example

A deployment pipeline restarts the server. The process exits immediately with no error. In Loki the only evidence is a missing `Connected to MongoDB` log line and the absence of `Shutting down...`.

### Loki Query

```logql
# Confirm MongoDB connection succeeded
{service="playback-server"} | json | msg="Connected to MongoDB"

# Confirm graceful shutdown completed
{service="playback-server"} | json | msg="Shutting down"
```

### Localhost Reproduction

#### Case A: MongoDB connection failure

1. Start the server with an invalid MongoDB URI:
   ```bash
   MONGO_URI="mongodb://localhost:27017/wrong-db" \
   NODE_ENV=development \
   npm run dev
   ```
2. **Expected result:** The server either fails to start or hangs indefinitely while retrying the connection. No `Connected to MongoDB` line appears. In Loki:
   ```logql
   {service="playback-server"} | json | msg="Connected to MongoDB"
   ```
   Returns zero results.

#### Case B: Graceful shutdown

1. Start the server:
   ```bash
   npm run dev
   ```
2. Send `SIGTERM` to the process:
   ```bash
   kill -TERM <PID>
   ```
3. **Expected result:** The server logs `Shutting down...` and exits cleanly:
   ```json
   {"level":30,"msg":"Shutting down..."}
   ```
   Verify in Loki:
   ```logql
   {service="playback-server"} | json | msg="Shutting down"
   ```

---

## 5. General Request Tracing

**Symptom:** A request took unusually long, or a specific user reports an unexpected response. You need to trace the full lifecycle of that single request across all log lines.

### Real-world Example

A user reports that a `GET /api/audio/<conversationId>` call returned `200` but took 12 seconds. You need to find the transaction ID for that request and trace all associated log lines to identify the bottleneck (e.g., SAS generation, blob resolution, database query).

### Loki Query

```logql
# All request lifecycle lines for a specific transaction
{service="playback-server"} | json | msg=~"incoming request|request completed"
  | json | transactionId="SRV1785419126463000"
```

### Localhost Reproduction

1. Start the server with debug logging:
   ```bash
   LOG_LEVEL=debug npm run dev
   ```
2. Make a request and capture the response headers:
   ```bash
   curl -v http://localhost:3000/api/audio/dddddddddddddddddddd01 2>&1
   ```
3. **Expected result:** stdout logs show `incoming request` followed by several `debug` lines, then `request completed`. To find the `transactionId` for that request:
   ```logql
   {service="playback-server"} | json | msg="request completed"
     | json | path="/api/audio/dddddddddddddddddddd01"
   ```
4. Once you have the `transactionId`, trace every log line for that transaction:
   ```logql
   {service="playback-server"} | json | transactionId="SRV1785419126463000"
   ```
   This returns all lines -- `incoming request`, any `debug`/`warn`/`error` logs, and `request completed` -- sharing the same ID.

---

## Quick Reference -- All LogQL Queries

| Scenario | LogQL Query |
|----------|-------------|
| SAS generation failures | `{service="playback-server"} \| json \| msg=~"SAS.*failed"` |
| Audio file not found | `{service="playback-server"} \| json \| msg=~"audio file not found"` |
| Audio file resolved | `{service="playback-server"} \| json \| msg=~"audio file resolved"` |
| Import job lifecycle | `{service="playback-server"} \| json \| msg=~"import job.*"` |
| Import job crashes | `{service="playback-server"} \| json \| msg=~"Import job crashed"` |
| Schema validation rejections | `{service="playback-server"} \| json \| msg=~"Import payload rejected"` |
| Entra ID callback errors | `{service="playback-server"} \| json \| msg=~"Entra.*error"` |
| Session plugin not registered | `{service="playback-server"} \| json \| msg=~"SESSION_KEY.*not set"` |
| MongoDB connected | `{service="playback-server"} \| json \| msg="Connected to MongoDB"` |
| Graceful shutdown | `{service="playback-server"} \| json \| msg="Shutting down"` |
| Trace by transaction ID | `{service="playback-server"} \| json \| transactionId="<txn>"` |
