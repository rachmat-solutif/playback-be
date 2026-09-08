# API Docs -- Scalar Reference (`/docs`)

Interactive OpenAPI docs for **Playback BE** served from the same Fastify process via **Scalar** (`@scalar/fastify-api-reference` + `@fastify/swagger`), gated with **HTTP Basic Auth** whose user/pass are ENV-driven (`DOCS_BASIC_USER`/`DOCS_BASIC_PASS`, default `user123:user123`). Works locally and on Vercel `https://playback-be-staging.vercel.app/docs` without a separate docs host.

> Change creds without code: Vercel Dashboard > Settings > Environment Variables > Edit `DOCS_BASIC_USER` / `DOCS_BASIC_PASS` > Redeploy. Locally edit `.env.development` / `.env.staging`.

> Verified 2026-09-07 on BE repo via `buildApp()` inject + `npm run build` + `npm run test:server` (71 passed): `GET /docs` 401 without auth / 301 -> `/docs/` 200 with `user123:user123`, `GET /docs/json` 401 without auth / 200 `application/json` with auth (spec `title: Playback BE`), `GET /docs/yaml` 200, wrong pass 401, `GET /health` 200 public. `tsc` build ok, `vercel.json` `includeFiles` verified.

## Quick Use

```bash
# Local -- after npm run dev (docs are always on, no extra flag)
# Browser prompts Basic Auth:
open http://localhost:3000/docs/
# user: user123  pass: user123  (or your DOCS_BASIC_*)

# curl -- both UI and spec are gated
curl -i http://localhost:3000/docs/                 # 401 WWW-Authenticate: Basic
curl -u user123:user123 http://localhost:3000/docs/ # 200 text/html
curl -u user123:user123 http://localhost:3000/docs/json | jq .openapi  # 3.0.3
curl -u user123:user123 http://localhost:3000/docs/yaml | head        # openapi: 3.0.3

# Staging
curl -u user123:user123 https://playback-be-staging.vercel.app/docs/json | jq .openapi
```

Browser fetch for `Scalar` JS (`/docs/js/scalar.js`) and spec (`/docs/json`) inherits the same Basic realm, so the single prompt unlocks the whole playground (Try-It for `GET /api/conversations` etc. uses the API's own `bearerAuth` / `cookieAuth` per spec -- docs Basic does not replace API auth).

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `GET /docs/` | Basic `DOCS_BASIC_USER`/`DOCS_BASIC_PASS` | Scalar UI (301 from `/docs` to `/docs/`). Playground with Try-It. |
| `GET /docs/json` | Basic | OpenAPI 3.0.3 JSON -- programmatic use, `openapi-typescript` codegen. |
| `GET /docs/yaml` | Basic | Same spec as YAML. |
| `GET /docs/js/scalar.js` | Basic | Scalar client bundle (~185 kB gzip, served from own origin). |
| `GET /health` | public | Not gated, not in docs. |
| `GET /auth/config` | public | Auth discovery for FE -- returns `{authProvider: entra|dummy|none, authBypass: boolean, entraConfigured: boolean}` (no session, `src/server/auth/index.ts:226`). FE: `entra` -> `GET /auth/login` redirect, `dummy` -> `POST /auth/login` form, `bypass` -> skip login. |
| `GET /api/*`, `POST /api/*`, `GET /auth/*` | `entra`/`dummy`/`AUTH_BYPASS` or `Bearer IMPORT_API_KEY` for import | API itself -- see `README.md -- API Endpoints`. |

Unauthenticated `/docs/*` returns `401 {"statusCode":401,"code":"FST_BASIC_AUTH_MISSING_OR_BAD_AUTHORIZATION_HEADER","error":"Unauthorized"}` with `WWW-Authenticate: Basic realm="..."` triggering the browser dialog. Tests bypass docs gate via `buildApp({disableAuth:true})` (`vitest.server.config.ts`).

## Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `DOCS_BASIC_USER` | -- | `user123` | Basic user for `/docs` -- set per env in Vercel. |
| `DOCS_BASIC_PASS` | -- | `user123` | Basic pass -- **rotate in staging/production**. |

Added to `src/server/config.ts` (Zod, no `superRefine` -- independent from `AUTH_PROVIDER`). Templates: `.env.development.example`, `.env.staging.example` (committed `DOCS_BASIC_USER=user123` / `DOCS_BASIC_PASS=user123`), `.env.test.example` commented (tests use `vitest.server.config.ts:9` `DOCS_BASIC_USER/PASS`). `.env.test` / `.env.development` are gitignored.

On Vercel (Hobby) set both in **Production** and **Preview** (`vercel.json` `includeFiles:"src/dist-server/**, node_modules/@scalar/**"` fixes `#3566` bundling). After editing, **Redeploy** the deployment for the new env to take effect (Vercel env is build-time).

## Architecture

```
src/server/config.ts      -- DOCS_BASIC_* Zod defaults
src/server/plugins/docs.ts -- fastifySwagger (openapi + jsonSchemaTransform) + fastifyBasicAuth (validate vs config) + Scalar (routePrefix /docs, openApiDocumentEndpoints json:/json yaml:/yaml, spec.content:()=>swagger())
src/server/app.ts          -- await app.register(docsPlugin) when !disableAuth (before session/guard, after rate-limit)
vercel.json                -- includeFiles for Scalar standalone.js
vitest.server.config.ts    -- DOCS_BASIC_* for tests
```

* `fastifySwagger` 8.15.0 on Fastify 4.29 -- `jsonSchemaTransform` from `fastify-type-provider-zod@2.0.0`. `@fastify/basic-auth@5.1.1` is the last Fastify 4 compatible (`@6.3.0` needs Fastify 5 -- `FST_ERR_PLUGIN_VERSION_MISMATCH`). Scalar ESM `await import('@scalar/fastify-api-reference')` in plugin scope.
* Swagger mode is **code-first**: Zod schemas in routes -> `jsonSchemaTransform` -> OpenAPI, no JSDoc duplication. Current spec is generated from route schemas; if a route has no `schema`, it appears as undocumented (see Adding docs below).
* Docs Basic is **orthogonal** to API auth (`AUTH_PROVIDER=entra|dummy`, `AUTH_BYPASS`, `SESSION_KEY`). API `GET /api/conversations` still requires `entra` session or `dummy user/123456` or `AUTH_BYPASS=true`; docs Basic only guards `/docs/*`.

## Adding Docs to a New Route

1. Add Zod schemas and `schema` to the route, using `fastify-type-provider-zod`. Example pattern (keep ASCII, no `react`/`vite`):

```ts
import { z } from 'zod';
import { jsonSchemaTransform } from 'fastify-type-provider-zod'; // already in docs plugin

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const responseSchema = z.object({ ok: z.boolean() });

app.get('/api/my-resource', {
  schema: {
    tags: ['MyResource'],
    summary: 'List my resources',
    description: 'Detailed description for docs playground.',
    querystring: querySchema,
    response: { 200: responseSchema },
    security: [{ cookieAuth: [] }, { bearerAuth: [] }], // for Try-It auth display
  },
}, async (req, reply) => { ... });
```

2. Run `npx tsc --noEmit` (Scalar bundle is already wired -- no `vercel.json` change needed for new routes). Restart `npm run dev`, open `http://localhost:3000/docs/` with Basic, verify your tag appears and Try-It sends `cookieAuth` / `bearerAuth` headers.
3. For import routes that accept `Authorization: Bearer <IMPORT_API_KEY>`, keep `security: [{ bearerAuth: [] }]`.

If using `zod@3` with `fastify-type-provider-zod@2`, `jsonSchemaTransform` converts Zod -> JSON Schema automatically. No `@fastify/swagger` `exposeRoute` needed -- Scalar reads `app.swagger()` via `spec.content`.

## Local Development

```bash
cp .env.development.example .env.development
# optionally override
# DOCS_BASIC_USER=user123
# DOCS_BASIC_PASS=user123
npm run dev
# prompt at http://localhost:3000/docs/
curl -u user123:user123 http://localhost:3000/docs/json | jq '.paths | keys'
```

To test custom creds without restarting code, change `.env.development`, restart `npm run dev` (config is read at boot via `dotenv`). `resetConfig()` picks up new env only in tests; prod/staging requires process restart.

## Staging / Vercel

Set in Vercel > Settings > Environment Variables (all of Production + Preview if PR previews need docs):

```
DOCS_BASIC_USER=user123
DOCS_BASIC_PASS=user123   # rotate to a strong value for public staging
```

`vercel.json` `includeFiles` ensures Scalar `js/standalone.js` (3.6 MB unpacked, 38.8 MB transitive `@scalar/api-reference`) is bundled; frontend gzip is ~185 kB vs Swagger UI ~352 kB. Server cold start adds ~30-80 ms and ~5-15 MB heap (init only, 3 routes). See research in `.agent/plans/scalar-only-env-basic-auth-gated-plan.md` for bundle comparison vs minimal Swagger UI.

Verify after deploy:

```bash
curl -i https://playback-be-staging.vercel.app/docs/        # 401
curl -u user123:user123 https://playback-be-staging.vercel.app/docs/   # 200
curl -u user123:user123 https://playback-be-staging.vercel.app/docs/json | jq .info.title
curl -u wrong:wrong https://playback-be-staging.vercel.app/docs/json   # 401
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `FST_ERR_PLUGIN_VERSION_MISMATCH: @fastify/basic-auth - expected '5.x'` | You installed `@fastify/basic-auth@6.x` with Fastify 4. Pin `@5.1.1` (`npm i @fastify/basic-auth@5.1.1`). `@fastify/swagger@8.15.0` likewise pins Fastify 4 (`@9.x` needs Fastify 5). |
| `401` even with correct `user123:user123` after ENV change | ENV is build-time. In Vercel, edit the variable then **Redeploy** that deployment; locally restart `npm run dev`. Confirm `src/server/config.ts` defaults and `process.env.DOCS_BASIC_*` match. |
| `/docs` 301 redirect loop | Scalar redirects `/docs` -> `/docs/` (301). Use `/docs/` or `-L` / `-u` with curl. Browser follows automatically; ensure Basic is sent for `/docs/` fetch too (same realm). |
| `/docs/json` 404 | Check `docs.ts` `openApiDocumentEndpoints: {json:'/json'}` matches Scalar route; health check that `fastifySwagger` is registered before `Scalar`. `npx tsc --noEmit` should pass. |
| `GET /docs/js/scalar.js` 404 or empty HTML `spec:{}` | `vercel.json` missing `node_modules/@scalar/**` in `includeFiles` -- Vercel did not bundle `js/standalone.js` (`#3566`). Add `, node_modules/@scalar/**` and redeploy. |
| `ERR_REQUIRE_ESM` from Scalar | Scalar is ESM-only. Plugin uses `await import('@scalar/fastify-api-reference')` (dynamic), not `require`. Keep `"type":"module"` and `vitest` `tsx`. |
| Docs show no paths / empty spec | Route has no `schema` -- add Zod `schema` per Adding docs above so `jsonSchemaTransform` populates `app.swagger()`. Re-check `npm run dev` logs. |
| Tests fail with 401 on `/docs` | Tests use `buildApp({disableAuth:true})` which skips `docsPlugin` entirely. Do not test `/docs` with `disableAuth:false` without sending `Authorization: Basic ...`. |

## Security Notes

* Docs Basic is **not** a substitute for API auth. `GET /api/import` still requires `Bearer IMPORT_API_KEY` or session; `GET /api/conversations` still requires `entra`/`dummy`/`AUTH_BYPASS`. Do not set `DOCS_BASIC_PASS` to the same value as `IMPORT_API_KEY` or `SESSION_PASSWORD`.
* Change `DOCS_BASIC_PASS` from `user123` in any public staging/production. Use `openssl rand -base64 12` for a rotated value, store as Vercel Sensitive.
* `WWW-Authenticate: Basic` sends credentials in clear text over HTTPS only. Vercel is HTTPS; locally use `http://localhost:3000` only for dev. No `style-src 'unsafe-inline'` CSP needed for Scalar (own-origin `js/scalar.js`).

## References

* Scalar Fastify integration: `https://scalar.com/products/api-references/integrations/fastify` (own-origin `js/scalar.js`, `spec.content:()=>fastify.swagger()`, `openApiDocumentEndpoints`).
* `@fastify/swagger` 8.x for Fastify 4, `jsonSchemaTransform` via `fastify-type-provider-zod` 2.x.
* Plan and bundle research: `.agent/plans/scalar-only-env-basic-auth-gated-plan.md` (185 kB vs 352 kB client, 3.6 MB server, cold-start notes, `#3566`/`#5602`/`#5859` workarounds).
* Source: `src/server/plugins/docs.ts:1`, `src/server/app.ts:14`, `src/server/config.ts:38`, `vercel.json:7`, `vitest.server.config.ts:9`.
