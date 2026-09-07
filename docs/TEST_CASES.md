# Test Cases

Total: **65 tests** across 11 test files.

Run with `npm run test:server`.

---

## config.test.ts -- 4 tests

| # | Test |
|---|------|
| 1 | Allows local development without Azure or Entra credentials |
| 2 | Requires Entra authentication in staging and production |
| 3 | Rejects authentication bypass in protected environments |
| 4 | Applies the one-hour SAS and clock-skew defaults |

---

## import-schemas.test.ts -- 6 tests

| # | Test |
|---|------|
| 1 | Accepts an existing Azure blob reference |
| 2 | Accepts an HTTPS remote audio URL |
| 3 | Rejects multiple audio sources |
| 4 | Rejects unsafe blob names |
| 5 | Rejects non-HTTPS remote URLs and embedded credentials |
| 6 | Retains local path support for filesystem mode |

---

## rate-limit.test.ts -- 1 test

| # | Test |
|---|------|
| 1 | Returns 429 after exceeding rate limit |

---

## auth.test.ts -- 7 tests

| # | Test |
|---|------|
| 1 | Returns 401 for an unauthenticated API request |
| 2 | Protects audio routes, including paths ending in a static extension |
| 3 | Returns 401 from `/auth/me` without a session |
| 4 | Returns the current user from `/auth/me` with a valid session |
| 5 | Clears the session cookie from `/auth/logout` |
| 6 | Requires the import API key on import endpoints |
| 7 | Rejects bulk payloads over 10000 conversations |

---

## import.test.ts -- 5 tests

| # | Test |
|---|------|
| 1 | Verifies and persists an existing Azure blob reference |
| 2 | Downloads and uploads a remote HTTPS audio source |
| 3 | Uploads multipart audio directly to Azure |
| 4 | Rejects missing existing Azure blobs |
| 5 | Returns an Azure requirement error for remote URLs without Azure configuration |

---

## remote-audio.test.ts -- 7 tests

| # | Test |
|---|------|
| 1 | Rejects private and loopback destinations |
| 2 | Rejects non-HTTPS URLs and credentials |
| 3 | Downloads a supported bounded audio response |
| 4 | Rejects a non-audio response |
| 5 | Rejects a response over the maximum size before downloading |
| 6 | Validates every redirect target |
| 7 | Enforces the redirect limit |

---

## audio.test.ts -- 6 tests

| # | Test |
|---|------|
| 1 | Streams audio file for a valid conversation |
| 2 | Supports byte range requests for local audio |
| 3 | Returns a direct JSON SAS URL when Blob Storage is configured |
| 4 | Returns a direct JSON SAS URL for an explicit blob_name |
| 5 | Returns 404 for conversation without audio record |
| 6 | Returns 400 for invalid conversation ID |

---

## storage.test.ts -- 5 tests

| # | Test |
|---|------|
| 1 | Creates a read-only HTTPS SAS scoped to one blob |
| 2 | Rejects blob names containing a query string |
| 3 | Creates opaque names under the imports prefix |
| 4 | Rejects traversal-like blob names |
| 5 | Raises a size error when a stream exceeds its configured bound |

---

## conversations-list.test.ts -- 12 tests

| # | Test |
|---|------|
| 1 | Returns paginated list of conversations |
| 2 | Returns conversations sorted by started_at descending |
| 3 | Filters by date range (from/to) |
| 4 | Filters by channel |
| 5 | Filters by agent (name) |
| 6 | Filters by sentiment |
| 7 | Filters by keyword (searches transcript text) |
| 8 | Filters by minDuration |
| 9 | Combines multiple filters (AND logic) |
| 10 | Respects pagination (page and limit) |
| 11 | Returns empty array when no matches |
| 12 | Enriches conversations with agent name, customer name, tags, sentiment |

---

## analytics.test.ts -- 8 tests

| # | Test |
|---|------|
| 1 | Returns daily volume breakdown |
| 2 | Returns hourly volume breakdown |
| 3 | Includes per-channel counts in volume |
| 4 | Returns empty array for date range with no data |
| 5 | Returns all 4 KPIs with values and deltas |
| 6 | Returns positive, neutral, negative counts |
| 7 | Returns agents sorted by conversation count descending |
| 8 | Respects limit param |

---

## conversations-detail.test.ts -- 4 tests

| # | Test |
|---|------|
| 1 | Returns full conversation detail with populated relations |
| 2 | Returns transcript segments sorted by timestamp |
| 3 | Returns 404 for non-existent conversation |
| 4 | Returns 400 for malformed ID |

---

## Planned Test Files (not yet implemented)

| Test File | Purpose |
|-----------|---------|
| `import-jobs.test.ts` | Import job queue, retry, and status tracking |
| `agents.test.ts` | Agent CRUD and assignment validation |
| `audio-policy.test.ts` | Unit tests for `validateBlobName`, `createAudioBlobName`, format validation |
| `session-helpers.test.ts` | Unit tests for `getSession`, `setSession`, session expiry |
| (expanded) `import-schemas.test.ts` | Additional import schema edge cases |
