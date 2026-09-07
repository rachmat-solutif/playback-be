import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { config } from '../config.js';
import { connectDb } from '../db/connection.js';
import { getSession, setSession } from './session.js';

// -- Shared schemas --
const dummyLoginSchema = z.object({
  username: z.string().min(1).describe('Username, e.g. user (seeded dummy user is user)'),
  password: z.string().min(1).describe('Password, e.g. 123456 (seeded dummy password is 123456)'),
});

const SCOPES = ['openid', 'profile', 'email'];
let msalClient: ConfidentialClientApplication | null = null;
const cryptoProvider = new CryptoProvider();

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    if (!config.ENTRA_CLIENT_ID || !config.ENTRA_TENANT_ID || !config.ENTRA_CLIENT_SECRET) {
      throw new Error('Entra ID config missing: ENTRA_CLIENT_ID, ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET');
    }
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.ENTRA_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}`,
        clientSecret: config.ENTRA_CLIENT_SECRET,
      },
    });
  }
  return msalClient;
}

function getAllowedOrigins(): string[] {
  const list: string[] = []
  if (config.APP_ORIGINS) list.push(...config.APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean))
  if (config.FRONTEND_URL) list.push(config.FRONTEND_URL.trim())
  return [...new Set(list)]
}

function isAllowedRedirect(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    const origin = parsed.origin
    const allowed = getAllowedOrigins()
    if (allowed.length === 0) return true
    return allowed.includes(origin)
  } catch {
    return false
  }
}

function getFallbackRedirect(): string {
  if (config.FRONTEND_URL) return config.FRONTEND_URL
  const origins = getAllowedOrigins()
  if (origins.length > 0) return origins[0]
  return '/'
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /auth/login -- provider-aware: entra -> Microsoft PKCE redirect, else -> redirect FE
  // FE may pass ?redirect=<FE origin> (multi-client). Validated against APP_ORIGINS + FRONTEND_URL allowlist.
  // This is the Entra SSO entry point. For dummy local dev use POST /auth/login.
  app.get(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Login (Entra SSO)',
        description:
          'Entra SSO login. When AUTH_PROVIDER=entra: redirects to Microsoft (`login.microsoftonline.com`) with PKCE `code_challenge` + `state` and stores `pkceVerifier`/`authState` + validated `postLoginRedirect` (from FE ?redirect) in session for `/auth/callback` validation. When AUTH_PROVIDER=dummy or AUTH_BYPASS=true (local dev): redirects to validated `?redirect` or FRONTEND_URL or APP_ORIGINS[0] or `/` -- use `POST /auth/login` with `{username,password}` for dummy (seeded `user`/`123456` via `SEED_GUARD=SAYA_SADAR_DROPDB_{HH}:{MM} npm run db:seed). FE should pass ?redirect=window.location.origin for multi-client SSO.',
        querystring: z
          .object({
            redirect: z.string().optional().describe('FE origin to redirect after SSO (must be in APP_ORIGINS allowlist or FRONTEND_URL), e.g. http://localhost:5173 or https://playback.rachmat.pro'),
          })
          .optional(),
        response: {
          302: z.object({}).describe('Redirect to Microsoft (entra) or to FE origin (dummy/bypass)'),
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { redirect?: string }
      if (q?.redirect) {
        if (!isAllowedRedirect(q.redirect)) {
          return reply.status(400).send({ error: 'Invalid redirect origin not in APP_ORIGINS allowlist' })
        }
        request.session.set('postLoginRedirect', q.redirect)
      }
      if (config.AUTH_PROVIDER === 'entra') {
        const client = getMsalClient();
        const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
        const state = cryptoProvider.createNewGuid();
        request.session.set('pkceVerifier', verifier);
        request.session.set('authState', state);
        const authUrl = await client.getAuthCodeUrl({
          scopes: SCOPES,
          redirectUri: config.ENTRA_REDIRECT_URI!,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          state,
        });
        return reply.redirect(authUrl);
      }
      const target = (q?.redirect && isAllowedRedirect(q.redirect) ? q.redirect : undefined) || getFallbackRedirect()
      return reply.redirect(target);
    },
  );

  // POST /auth/login -- dummy (DB-backed) + bypass (offline)
  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Login (Dummy / Bypass)',
        description:
          'Dummy login for local/staging (`AUTH_PROVIDER=dummy`) -- validates `username`/`password` against `users` collection (seeded `user`/`123456`, `bcryptjs`) and sets `session` cookie for `/api/*`. When `AUTH_BYPASS=true` or `AUTH_PROVIDER=none` (offline dev) accepts any body and returns `dev-user`. Not used when `AUTH_PROVIDER=entra` (use `GET /auth/login` -> Entra). Accepts optional ?redirect=<FE origin> (validated against APP_ORIGINS) for multi-client FE to know where to navigate after 200.',
        querystring: z
          .object({
            redirect: z.string().optional().describe('FE origin to redirect after dummy login (must be in APP_ORIGINS allowlist), e.g. http://localhost:5173'),
          })
          .optional(),
        body: dummyLoginSchema,
        response: {
          200: z
            .object({ ok: z.boolean().describe('Login success'), username: z.string(), role: z.string() })
            .describe('Login success, session cookie set (dummy) or dev-user (bypass)'),
          400: z.object({ error: z.string() }).describe('Missing username or password (dummy) or invalid redirect origin'),
          401: z.object({ error: z.string() }).describe('Invalid credentials (dummy)'),
          405: z.object({ error: z.string() }).describe('Method not allowed when AUTH_PROVIDER=entra'),
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { redirect?: string }
      if (q?.redirect && !isAllowedRedirect(q.redirect)) {
        return reply.status(400).send({ error: 'Invalid redirect origin not in APP_ORIGINS allowlist' })
      }
      if (config.AUTH_PROVIDER === 'entra') {
        return reply.status(405).send({ error: 'Use GET /auth/login for Entra SSO' });
      }
      if (config.AUTH_PROVIDER !== 'dummy') {
        // bypass / none -- offline dev, no DB
        const body = (request.body as Record<string, unknown>) || {};
        const username = (body.username as string) || 'dev-user';
        return reply.send({ ok: true, username, role: 'admin' });
      }
      const parsed = dummyLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Missing username or password' });
      }
      const { username, password } = parsed.data;
      const db = await connectDb();
      const user = await db.collection('users').findOne({ username });
      if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, (user as any).password_hash);
      if (!ok) return reply.status(401).send({ error: 'Invalid credentials' });
      setSession(request.session, {
        userId: (user as any)._id.toString(),
        email: (user as any).username,
        name: (user as any).username,
        roles: [(user as any).role],
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      });
      return reply.send({ ok: true, username: (user as any).username, role: (user as any).role });
    },
  );

  // GET /auth/callback -- Entra only
  app.get(
    '/auth/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Entra callback',
        description:
          'Entra SSO callback. Exchanges `code` for token via MSAL `acquireTokenByCode`, validates `state` vs session, creates `session` cookie and redirects to `/`. Only active when `AUTH_PROVIDER=entra`; returns 404 otherwise. Called by Microsoft after `GET /auth/login`.',
        querystring: z.object({
          code: z.string().min(1).describe('Authorization code from Entra ID'),
          state: z.string().min(1).describe('State returned by Entra ID, must match session `authState`'),
          session_state: z.string().optional().describe('Entra session_state'),
          client_info: z.string().optional().describe('Entra client_info'),
        }),
        response: {
          302: z.object({}).describe('Redirect to / on success'),
          400: z.object({ error: z.string() }).describe('Missing code or invalid state'),
          401: z.object({ error: z.string() }).describe('Authentication failed'),
          404: z.object({ error: z.string() }).describe('Not active unless AUTH_PROVIDER=entra'),
        },
      },
    },
    async (request, reply) => {
      if (config.AUTH_PROVIDER !== 'entra') {
        return reply.status(404).send({ error: 'Not found -- Entra callback only when AUTH_PROVIDER=entra' });
      }
      const { code, state } = request.query as { code?: string; state?: string };
      if (!code) return reply.status(400).send({ error: 'Missing authorization code' });
      const savedState = request.session.get('authState');
      if (!state || state !== savedState) return reply.status(400).send({ error: 'Invalid state parameter' });
      const pkceVerifier = request.session.get('pkceVerifier');
      const client = getMsalClient();
      try {
        const result = await client.acquireTokenByCode({
          code,
          scopes: SCOPES,
          redirectUri: config.ENTRA_REDIRECT_URI!,
          codeVerifier: pkceVerifier || undefined,
        });
        if (!result || !result.account) return reply.status(401).send({ error: 'Authentication failed' });
        const account = result.account;
        const claims = (result.idTokenClaims as Record<string, any>) || {};
        setSession(request.session, {
          userId: account.localAccountId,
          email: account.username || claims.email || claims.preferred_username || '',
          name: account.name || claims.name || '',
          roles: (claims.roles as string[]) || [],
          expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        });
        request.session.set('pkceVerifier', '');
        request.session.set('authState', '');
        const storedRedirect = request.session.get('postLoginRedirect') as string | undefined
        let target = getFallbackRedirect()
        if (storedRedirect && isAllowedRedirect(storedRedirect)) target = storedRedirect
        request.session.set('postLoginRedirect', '')
        return reply.redirect(target);
      } catch (err: any) {
        request.log.error({ data: { err } }, 'Entra ID callback error');
        return reply.status(500).send({ error: 'Authentication failed' });
      }
    },
  );

  // GET /auth/logout -- provider-aware
  app.get(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout',
        description:
          'Logout. Always deletes local `session` cookie and redirects. When `AUTH_PROVIDER=entra`: redirects to Microsoft Entra logout (`.../oauth2/v2.0/logout?post_logout_redirect_uri=...`) to sign out of sister sites; uses FE-passed `?redirect` (validated against APP_ORIGINS) or `ENTRA_LOGOUT_URI` or `ENTRA_REDIRECT_URI` fallback. When `dummy`/`bypass`/`none`: redirects to validated `?redirect` or `FRONTEND_URL` or APP_ORIGINS[0] or `/`.',
        querystring: z
          .object({
            redirect: z.string().optional().describe('FE origin to redirect after logout (must be in APP_ORIGINS allowlist), e.g. http://localhost:5173 or https://playback.rachmat.pro'),
          })
          .optional(),
        response: { 302: z.object({}).describe('Redirect to Microsoft logout (entra) or FE origin') },
      },
    },
    async (request, reply) => {
      const q = request.query as { redirect?: string }
      if (q?.redirect && !isAllowedRedirect(q.redirect)) {
        return reply.status(400).send({ error: 'Invalid redirect origin not in APP_ORIGINS allowlist' })
      }
      const feRedirect = q?.redirect && isAllowedRedirect(q.redirect) ? q.redirect : undefined
      request.session.delete();
      if (config.AUTH_PROVIDER === 'entra') {
        const postLogoutUri =
          feRedirect ||
          config.ENTRA_LOGOUT_URI ||
          (config.ENTRA_REDIRECT_URI ? config.ENTRA_REDIRECT_URI.replace('/auth/callback', '/login') : `${getFallbackRedirect()}/login`);
        const logoutUrl =
          `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/oauth2/v2.0/logout` +
          `?post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`;
        return reply.redirect(logoutUrl);
      }
      return reply.redirect(feRedirect || getFallbackRedirect());
    },
  );

  // GET /auth/logout/callback -- front-channel logout (Entra iframe)
  app.get(
    '/auth/logout/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Logout callback (Entra front-channel)',
        description:
          'Front-channel logout callback. Microsoft calls this in an iframe when another sister site triggers logout. Deletes local `session` and redirects to `/` (or FRONTEND_URL/APP_ORIGINS[0] when set). Accepts optional ?redirect validated against APP_ORIGINS allowlist. Only meaningful when `AUTH_PROVIDER=entra`, but always registered for docs.',
        querystring: z
          .object({
            redirect: z.string().optional().describe('FE origin to redirect after front-channel logout (must be in APP_ORIGINS allowlist)'),
          })
          .optional(),
      },
    },
    async (request, reply) => {
      const q = request.query as { redirect?: string }
      if (q?.redirect && !isAllowedRedirect(q.redirect)) {
        return reply.status(400).send({ error: 'Invalid redirect origin not in APP_ORIGINS allowlist' })
      }
      request.session.delete();
      const target = (q?.redirect && isAllowedRedirect(q.redirect) ? q.redirect : undefined) || getFallbackRedirect()
      return reply.redirect(target);
    },
  );

  // GET /auth/config -- FE login flow discovery (public, no session)
  app.get(
    '/auth/config',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Auth config for FE',
        description:
          'Public endpoint for FE to choose correct login flow without guessing. Returns `authProvider` (`entra`|`dummy`|`none`), `authBypass` (true -> offline dev), `entraConfigured` (true when Entra client/tenant/secret set), `frontendUrl` (deprecated fallback) and `allowedOrigins` (APP_ORIGINS allowlist for FE-passed ?redirect). FE: if `authProvider===entra` -> redirect `GET /auth/login?redirect=<FE origin>` where FE origin must be in allowedOrigins or frontendUrl; if `dummy` -> show `POST /auth/login?redirect=` form (`user`/`123456`); if `none`+`authBypass` -> skip login (dev-user). No secrets leaked. Multi-client: single BE serves multiple FEs, each FE passes its own origin.',
        response: {
          200: z
            .object({
              authProvider: z.enum(['entra', 'dummy', 'none']).describe('Active AUTH_PROVIDER (config.ts:38)'),
              authBypass: z.boolean().describe('AUTH_BYPASS (true -> offline dev, guard.ts:46)'),
              entraConfigured: z.boolean().describe('Entra secrets present (ENTRA_CLIENT_ID/TENANT_ID/SECRET)'),
              frontendUrl: z.string().optional().describe('FRONTEND_URL fallback for post-login redirect (deprecated, use allowedOrigins + ?redirect)'),
              allowedOrigins: z.array(z.string()).optional().describe('APP_ORIGINS allowlist (plus FRONTEND_URL) for FE-passed ?redirect validation, e.g. ["http://localhost:5173","https://playback.rachmat.pro"]'),
            })
            .describe('Auth config'),
        },
      },
    },
    async () => {
      return {
        authProvider: config.AUTH_PROVIDER,
        authBypass: config.AUTH_BYPASS,
        entraConfigured: Boolean(config.ENTRA_CLIENT_ID && config.ENTRA_TENANT_ID && config.ENTRA_CLIENT_SECRET),
        frontendUrl: config.FRONTEND_URL,
        allowedOrigins: getAllowedOrigins(),
      };
    },
  );

  // GET /auth/me -- unified session reader
  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Current user',
        description:
          'Returns current session user if authenticated, else 401. Works with all providers: `dummy` (`POST /auth/login` -> session), `entra` (`GET /auth/login` -> callback -> session), `bypass`/`none` (always `dev-user`). Requires `session` cookie unless bypass.',
        response: {
          200: z
            .object({
              userId: z.string().describe('User ID (localAccountId for entra, _id for dummy)'),
              email: z.string().describe('Email / username'),
              name: z.string().describe('Display name'),
              roles: z.array(z.string()).describe('Roles'),
            })
            .describe('Session user'),
          401: z.object({ error: z.string() }).describe('Unauthorized -- no session'),
        },
      },
    },
    async (request, reply) => {
      if (config.AUTH_PROVIDER === 'none' || config.AUTH_BYPASS) {
        const session = getSession(request.session);
        if (session) return reply.send(session);
        return reply.send({ userId: 'dev-user', email: 'dev@local', name: 'Dev User', roles: ['admin'] });
      }
      const session = getSession(request.session);
      if (!session) return reply.status(401).send({ error: 'Unauthorized' });
      return reply.send({
        userId: session.userId,
        email: session.email,
        name: session.name,
        roles: session.roles,
      });
    },
  );
}
