# Import API

Import conversations into Playback. Audio can be stored on the local filesystem
when Azure is not configured, or in a private Azure Blob Storage container when
`AZURE_STORAGE_CONNECTION_STRING` is set.

The application does not create Azure containers automatically. Create the
private container before starting the application. For local Azure setup, see
`docs/LOCAL-AZURE-AUDIO-CHECKLIST.md`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/import` | Import one conversation |
| POST | `/api/import/bulk` | Import multiple conversations asynchronously |
| GET | `/api/import/jobs/:jobId` | Poll bulk import progress |

When authentication is enabled, import requests require the configured import
bearer credential.

## Single conversation JSON

```http
POST /api/import
Content-Type: application/json
```

```json
{
  "conversation": {
    "customer": {
      "phone": 1555000100,
      "name": "Jordan Reyes",
      "email": "jordan.reyes@example.com"
    },
    "agent": {
      "email": "maya.chen@company.com",
      "name": "Maya Chen",
      "team": "Support"
    },
    "channel": "call",
    "started_at": "2026-07-20T09:00:00Z",
    "ended_at": "2026-07-20T09:12:30Z",
    "status": "resolved",
    "tags": ["Billing", "Returns"],
    "external_id": "CRM-98765"
  },
  "transcript": [
    { "speaker": "agent", "timestamp_seconds": 0, "text": "How can I help?" },
    { "speaker": "customer", "timestamp_seconds": 5, "text": "I have a billing issue." }
  ],
  "metrics": {
    "sentiment_score": 0.6,
    "sentiment_label": "positive",
    "handle_time_seconds": 750,
    "first_response_seconds": 12
  },
  "audio": {
    "remote_url": "https://media.example.com/call-98765.wav"
  }
}
```

A successful response is:

```json
{ "id": "6a5469a9b1c2d3e4f5000001" }
```

## Audio sources

The `audio` object must contain exactly one source field. The `format` field
is optional and accepts `wav`, `mp3`, `ogg`, `flac`, or `webm`.

### Local filesystem path

Use `url` when Azure is not configured:

```json
"audio": {
  "url": "/audio/sample-call.wav",
  "format": "wav"
}
```

This mode stores no Azure metadata and playback streams from `public/audio/`.
When Azure is configured, use `blob_name` or `remote_url` instead.

### Existing Azure blob

Use `blob_name` for a blob that already exists in the configured private
container:

```json
"audio": {
  "blob_name": "imports/existing-call.wav",
  "format": "wav"
}
```

The server validates the blob name and checks that the blob exists before it
creates the conversation record. The blob is not copied or modified.

### Remote HTTPS audio URL

Use `remote_url` to download an audio file and upload it to Azure:

```json
"audio": {
  "remote_url": "https://media.example.com/call-98765.mp3"
}
```

This mode requires Azure configuration. The server generates an opaque blob
name under `imports/`, uploads the audio, and stores the resulting `blob_name`.
The remote server response must identify an allowed audio type.

Remote downloads are restricted to HTTPS. The server rejects credentials,
fragments, unsafe DNS destinations, private and loopback addresses, unsafe
redirect targets, non-audio responses, oversized responses, and timeouts.
Redirects are followed manually and each target is checked independently.

### Multipart upload

```http
POST /api/import
Content-Type: multipart/form-data
```

Fields:

- `data`: JSON string containing the conversation payload. The `audio` field
  may be omitted when an audio file is attached.
- `audio`: audio file to upload.

Example:

```bash
curl -X POST http://localhost:3000/api/import \
  -F 'data={"conversation":{"customer":{"phone":1555000100,"name":"Jordan Reyes"},"agent":{"email":"maya.chen@company.com","name":"Maya Chen"},"started_at":"2026-07-20T09:00:00Z","ended_at":"2026-07-20T09:12:30Z"}}' \
  -F 'audio=@/path/to/recording.wav;type=audio/wav'
```

With Azure configured, the file is streamed into the private container under a
generated `imports/<opaque-id>.<format>` name. It is not written to
`public/audio/`. Without Azure, it is written to `public/audio/` as a local
development fallback.

Allowed MIME types are WAV, MP3, OGG, FLAC, and WebM. The maximum audio size
is 500 MB. A file is required when `conversation.channel` is `call` unless a
JSON audio source is supplied.

## Conversation fields

### conversation

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| customer | object | yes | | Customer data |
| agent | object | yes | | Agent data |
| channel | string | no | `call` | `call`, `chat`, or `email` |
| started_at | string | yes | | ISO 8601 datetime |
| ended_at | string | yes | | ISO 8601 datetime |
| status | string | no | `resolved` | `resolved`, `unresolved`, or `escalated` |
| tags | string[] | no | `[]` | Tag labels |
| external_id | string | no | | Re-import key; replaces related data |

Customers are upserted by phone number. Agents are upserted by email. Tags are
created by label when they do not already exist.

### transcript

Optional array of objects:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| speaker | string | yes | `agent` or `customer` |
| timestamp_seconds | integer | yes | Must be zero or greater |
| text | string | yes | 1 to 5000 characters |

### metrics

Optional object. If omitted, a neutral metric record is generated.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| sentiment_score | number | yes | -1.0 to 1.0 |
| sentiment_label | string | yes | `positive`, `neutral`, or `negative` |
| handle_time_seconds | integer | yes | Must be zero or greater |
| first_response_seconds | integer | yes | Must be zero or greater |

### audio

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| url | string | conditional | Local filesystem path when Azure is not configured |
| blob_name | string | conditional | Existing blob in the configured Azure container |
| remote_url | HTTPS URL | conditional | Download and upload to Azure |
| format | string | no | `wav`, `mp3`, `ogg`, `flac`, or `webm` |

Exactly one of `url`, `blob_name`, or `remote_url` is allowed. Audio is
required for `call` conversations and optional for `chat` and `email`.

## Bulk import

```http
POST /api/import/bulk
Content-Type: application/json
```

```json
{
  "conversations": [
    { "conversation": { "...": "..." }, "audio": { "blob_name": "imports/a.wav" } },
    { "conversation": { "...": "..." }, "audio": { "remote_url": "https://media.example.com/b.wav" } }
  ]
}
```

Bulk imports accept JSON sources only; multipart file attachments are not
supported. Existing blob references and remote URLs use the same validation and
Azure requirements as single imports. The maximum request size is 10,000
conversations. Jobs process in chunks of 500 and individual failures do not
stop the batch.

```bash
curl -X POST https://playback.rachmat.pro/api/import/bulk \
  -H "Authorization: Bearer $IMPORT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '@examples/import/bulk-import.json'
```

Response:

```json
{ "jobId": "a1b2c3d4e5f6a1b2c3d4e5f6" }
```

Poll the job with:

```bash
curl http://localhost:3000/api/import/jobs/a1b2c3d4e5f6a1b2c3d4e5f6
```

## Playback behavior

After an Azure import, `audio_files` stores the generated or supplied
`blob_name`. `GET /api/audio/:conversationId` returns a short-lived,
read-only, HTTPS-only SAS URL. The browser uses that URL to stream directly
from the private container.

When Azure is not configured, the endpoint streams local files from
`public/audio/` and supports byte-range requests.

## Error responses

Validation failures return `400`:

```json
{ "error": "Validation failed", "details": [] }
```

Invalid or unavailable audio sources return `422`. An audio payload exceeding
the 500 MB limit returns `413`.

## Examples

The repository includes scripts in `examples/import/`:

```bash
./examples/import/import-single.sh
./examples/import/import-bulk.sh
node examples/import/generate-bulk.cjs
```

Do not commit generated bulk fixtures, Azure connection strings, SAS URLs, or
import credentials.
