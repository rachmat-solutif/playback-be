import type { FastifyInstance } from 'fastify';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { z } from 'zod';
import { config } from '../config.js';
import { setSession, getSession } from './session.js';

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

export async function entraAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /auth/login -- redirect to Microsoft login
  app.get(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Entra login redirect',
        description: 'Redirects to Microsoft Entra ID (`login.microsoftonline.com`) with PKCE `code_challenge` + `state`. Sets `pkceVerifier`/`authState` in session for callback validation.',
      },
    },
    async (request, reply) => {
    const client = getMsalClient();

    // Generate PKCE codes and state for CSRF protection
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
    const state = cryptoProvider.createNewGuid();

    // Store PKCE verifier and state in session for callback validation
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
  });

  // GET /auth/callback -- exchange code for token, create session
  app.get(
    '/auth/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Entra callback',
        description: 'Exchanges `code` for token via MSAL `acquireTokenByCode`, validates `state` vs session, creates `session` cookie and redirects to `/`.',
        querystring: z.object({
          code: z.string().min(1).describe('Authorization code from Entra ID'),
          state: z.string().min(1).describe('State returned by Entra ID, must match session `authState`'),
          session_state: z.string().optional().describe('Entra session_state'),
          client_info: z.string().optional().describe('Entra client_info'),
        }),
      },
    },
    async (request, reply) => {
      const { code, state } = request.query as { code?: string; state?: string };

    if (!code) {
      return reply.status(400).send({ error: 'Missing authorization code' });
    }

    // Validate state to prevent CSRF
    const savedState = request.session.get('authState');
    if (!state || state !== savedState) {
      return reply.status(400).send({ error: 'Invalid state parameter' });
    }

    const pkceVerifier = request.session.get('pkceVerifier');

    const client = getMsalClient();

    try {
      const result = await client.acquireTokenByCode({
        code,
        scopes: SCOPES,
        redirectUri: config.ENTRA_REDIRECT_URI!,
        codeVerifier: pkceVerifier || undefined,
      });

      if (!result || !result.account) {
        return reply.status(401).send({ error: 'Authentication failed' });
      }

      const account = result.account;
      const claims = result.idTokenClaims as Record<string, any> || {};

      // Set session with user info
      setSession(request.session, {
        userId: account.localAccountId,
        email: account.username || claims.email || claims.preferred_username || '',
        name: account.name || claims.name || '',
        roles: (claims.roles as string[]) || [],
        expiresAt: Date.now() + (8 * 60 * 60 * 1000), // 8 hours
      });

      // Clean up PKCE/state from session
      request.session.set('pkceVerifier', '');
      request.session.set('authState', '');

      return reply.redirect('/');
    } catch (err: any) {
      request.log.error(
        {
          data: { err },
        },
        'Entra ID callback error',
      );
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  // GET /auth/logout -- destroy local session, redirect to Microsoft logout
  app.get(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Entra logout',
        description: 'Deletes local `session` and redirects to Microsoft Entra logout (`.../oauth2/v2.0/logout?post_logout_redirect_uri=...`).',
      },
    },
    async (request, reply) => {
    // Destroy local session
    request.session.delete();

    // Redirect to Microsoft logout endpoint (signs out of all sister sites)
    const postLogoutUri = config.ENTRA_LOGOUT_URI ||
      (config.ENTRA_REDIRECT_URI
        ? config.ENTRA_REDIRECT_URI.replace('/auth/callback', '/login')
        : 'http://localhost:3000/login');

    const logoutUrl =
      `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`;

    return reply.redirect(logoutUrl);
  });

  // GET /auth/logout/callback -- front-channel logout (Microsoft calls this in an iframe
  // when another sister site triggers logout)
  app.get(
    '/auth/logout/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Entra logout callback (front-channel)',
        description: 'Microsoft calls this in an iframe on sister-site logout. Deletes local `session` and redirects to `/`.',
      },
    },
    async (request, reply) => {
    // Destroy local session if it exists
    request.session.delete();

    // Return 200 (Microsoft expects a successful response from the iframe)
    //return reply.status(200).send('OK');


    return reply.redirect('/');
  });

  // GET /auth/me -- return current user info from session
  app.get(
    '/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Current user (Entra)',
        description: 'Returns session user if authenticated via Entra callback, else 401. Requires `session` cookie.',
      },
    },
    async (request, reply) => {
    const session = getSession(request.session);
    if (!session) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    return reply.send({
      userId: session.userId,
      email: session.email,
      name: session.name,
      roles: session.roles,
    });
  });
}
