import type { FastifyInstance } from 'fastify';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
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
  app.get('/auth/login', async (request, reply) => {
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
  app.get('/auth/callback', async (request, reply) => {
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
  app.get('/auth/logout', async (request, reply) => {
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
  app.get('/auth/logout/callback', async (request, reply) => {
    // Destroy local session if it exists
    request.session.delete();

    // Return 200 (Microsoft expects a successful response from the iframe)
    //return reply.status(200).send('OK');


    return reply.redirect('/');
  });

  // GET /auth/me -- return current user info from session
  app.get('/auth/me', async (request, reply) => {
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
