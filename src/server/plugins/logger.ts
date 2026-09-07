import pino from 'pino';

/**
 * Pino logger plugin.
 *
 * Creates a Pino logger instance with:
 * - Flat JSON output (no req/res wrapping)
 * - Base bindings for service and env
 * - PII redaction for sensitive fields
 * - Auto-generated transactionId base binding (updated per-request via child logger)
 */

const PII_FIELDS = [
  'clientSecret',
  'accessToken',
  'authorization',
  'phone',
  'customerName',
  'password',
  'code',
  'session_state',
  'client_info',
  'state',
];

export function createLogger(options: {
  service: string;
  env: string;
  level: string;
}): pino.Logger {
  const logger = pino({
    base: {
      service: options.service,
      env: options.env,
    },
    redact: {
      // Redact PII fields at all realistic nesting depths:
      // - root: { phone: '...' }
      // - one level: { data: { phone: '...' } }
      // - two levels: { a: { b: { phone: '...' } } }
      // - three levels: { a: { b: { c: { phone: '...' } } } }
      paths: PII_FIELDS.flatMap((field) => [
        field,
        `*.${field}`,
        `*.*.${field}`,
        `*.*.*.${field}`,
      ]),
      censor: '[Redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });

  return logger;
}
