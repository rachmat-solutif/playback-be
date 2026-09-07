import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifyBasicAuth from '@fastify/basic-auth';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { config } from '../config.js';

export const docsPlugin = fp(async (app) => {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Playback BE',
        version: '0.1.0',
        description: 'Playback Backend -- Conversations, analytics, audio, import',
      },
      servers: config.APP_ORIGINS
        ? config.APP_ORIGINS.split(',').map((url) => ({ url: url.trim() }))
        : undefined,
      components: {
        securitySchemes: {
          basicAuth: { type: 'http', scheme: 'basic' },
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifyBasicAuth, {
    validate: (username: string, password: string, _req, _reply, done: (err?: Error) => void) => {
      if (username === config.DOCS_BASIC_USER && password === config.DOCS_BASIC_PASS) {
        done();
      } else {
        done(new Error('Unauthorized'));
      }
    },
    authenticate: true,
  });

  // Scalar UI -- both /docs and /docs/json gated via basicAuth hook
  await app.register(async (docsScope) => {
    docsScope.addHook('onRequest', docsScope.basicAuth);

    const { default: scalarApiReference } = await import('@scalar/fastify-api-reference');
    await docsScope.register(scalarApiReference, {
      routePrefix: '/docs',
      openApiDocumentEndpoints: {
        json: '/json',
        yaml: '/yaml',
      },
      configuration: {
        spec: {
          content: () => docsScope.swagger(),
        },
        theme: 'purple',
        metaData: {
          title: 'Playback BE API',
        },
      },
    });
  });
});
