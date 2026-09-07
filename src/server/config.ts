import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const envFile =
  process.env.NODE_ENV === 'test'
    ? '.env.test'
    : process.env.NODE_ENV === 'staging'
      ? '.env.staging'
      : process.env.NODE_ENV === 'production'
        ? '.env.production'
        : '.env.development';

dotenv.config({ path: path.join(projectRoot, envFile) });
dotenv.config({ path: path.join(projectRoot, '.env') });

const requiredWhenEntra = [
  ['ENTRA_CLIENT_ID', 'ENTRA_CLIENT_ID'],
  ['ENTRA_TENANT_ID', 'ENTRA_TENANT_ID'],
  ['ENTRA_CLIENT_SECRET', 'ENTRA_CLIENT_SECRET'],
  ['ENTRA_REDIRECT_URI', 'ENTRA_REDIRECT_URI'],
  ['SESSION_KEY', 'SESSION_KEY'],
  ['SESSION_PASSWORD', 'SESSION_PASSWORD'],
] as const;

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'staging', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

    AUTH_PROVIDER: z.enum(['entra', 'dummy', 'none']).default('none'),
    IMPORT_API_KEY: z.string().min(32).optional(),

    ENTRA_CLIENT_ID: z.string().min(1).optional(),
    ENTRA_TENANT_ID: z.string().min(1).optional(),
    ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
    ENTRA_REDIRECT_URI: z.string().url().optional(),
    ENTRA_LOGOUT_URI: z.string().url().optional(),

    SESSION_KEY: z.string().optional(),
    SESSION_PASSWORD: z.string().min(1).optional(),

    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
    AZURE_STORAGE_ACCOUNT_NAME: z.string().min(1).optional(),
    AZURE_STORAGE_CONTAINER: z.string().min(1).default('audio'),
    AUDIO_SAS_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(60).default(60),
    AUDIO_SAS_CLOCK_SKEW_MINUTES: z.coerce.number().int().min(1).max(15).default(5),
    REMOTE_AUDIO_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(300),
    REMOTE_AUDIO_MAX_REDIRECTS: z.coerce.number().int().min(0).max(5).default(3),
    APP_ORIGINS: z.string().optional(),

    DOCS_BASIC_USER: z.string().min(1).default('user123'),
    DOCS_BASIC_PASS: z.string().min(1).default('user123'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    SERVICE_NAME: z.string().default('playback-server'),

    AUTH_BYPASS: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default('false'),
  })
  .superRefine((value, ctx) => {
    const protectedEnvironment = value.NODE_ENV === 'staging' || value.NODE_ENV === 'production';

    if (protectedEnvironment && !['entra', 'dummy'].includes(value.AUTH_PROVIDER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_PROVIDER'],
        message: 'AUTH_PROVIDER must be entra or dummy in staging and production',
      });
    }

    if (protectedEnvironment && value.AUTH_BYPASS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_BYPASS'],
        message: 'AUTH_BYPASS is not allowed in staging or production',
      });
    }

    if (value.AUTH_PROVIDER === 'entra' || value.AUTH_PROVIDER === 'dummy') {
      // SESSION_KEY format is required for entra and dummy (secure-session)
      if (value.SESSION_KEY && !/^[0-9a-fA-F]{64}$/.test(value.SESSION_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_KEY'],
          message: 'SESSION_KEY must be a 32-byte hexadecimal value (64 characters)',
        });
      }
    }

    if (value.AUTH_PROVIDER === 'entra') {
      for (const [field, label] of requiredWhenEntra) {
        if (!value[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${label} is required when AUTH_PROVIDER=entra`,
          });
        }
      }
    }

    if (value.AUTH_PROVIDER === 'dummy') {
      if (!value.SESSION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_KEY'],
          message: 'SESSION_KEY is required when AUTH_PROVIDER=dummy',
        });
      }
      if (!value.SESSION_PASSWORD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_PASSWORD'],
          message: 'SESSION_PASSWORD is required when AUTH_PROVIDER=dummy',
        });
      }
    }

    if (value.AZURE_STORAGE_CONNECTION_STRING && !value.AZURE_STORAGE_ACCOUNT_NAME) {
      // The account name is currently parsed from the connection string. It remains
      // optional until User Delegation SAS is enabled, where it becomes required.
    }
  });

// Mutable object holding resolved config values.
// The Proxy getter reads from this, and Object.assign(config, ...) writes to it,
// so test-time mutations are visible through config reads.
const _target = {} as Config;

function getEnv(): Config {
  if (_initialized) return _target;
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const err = new Error(
      'Invalid environment variables:\n' + JSON.stringify(parsed.error.format(), null, 2),
    );
    err.name = 'ValidationError';
    throw err;
  }

  Object.assign(_target, parsed.data);
  _initialized = true;
  return _target;
}

let _initialized = false;

export const config = new Proxy<Config>(_target, {
  get(_proxy, prop: string | symbol) {
    getEnv();
    return _target[prop as keyof Config];
  },
  set(_proxy, prop: string | symbol, value) {
    getEnv();
    (_target as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});
export type Config = z.infer<typeof envSchema>;

// Reset and repopulate from current process.env.
export function resetConfig(): void {
  _initialized = false;
  getEnv();
}

// Set specific keys on the config object. Used by tests to simulate
// different environments without process.env manipulation.
export function setConfig<T extends keyof Config>(key: T, value: Config[T]): void {
  getEnv();
  _target[key] = value;
}
