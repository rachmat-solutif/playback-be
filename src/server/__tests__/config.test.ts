import { describe, expect, it } from 'vitest';
import { envSchema } from '../config.js';

const baseEnvironment = {
  MONGO_URI: 'mongodb://localhost:27017/playback_test',
};

const entraEnvironment = {
  ...baseEnvironment,
  NODE_ENV: 'staging',
  AUTH_PROVIDER: 'entra',
  ENTRA_CLIENT_ID: 'client-id',
  ENTRA_TENANT_ID: 'tenant-id',
  ENTRA_CLIENT_SECRET: 'client-secret',
  ENTRA_REDIRECT_URI: 'https://staging.example.com/auth/callback',
  SESSION_KEY: 'a'.repeat(64),
  SESSION_PASSWORD: 'session-password',
};

describe('environment validation', () => {
  it('allows local development without Azure or Entra credentials', () => {
    const result = envSchema.safeParse({
      ...baseEnvironment,
      NODE_ENV: 'development',
      AUTH_PROVIDER: 'none',
    });

    expect(result.success).toBe(true);
  });

  it('requires Entra authentication in staging and production', () => {
    const result = envSchema.safeParse({
      ...baseEnvironment,
      NODE_ENV: 'staging',
      AUTH_PROVIDER: 'none',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'AUTH_PROVIDER')).toBe(true);
    }
  });

  it('rejects authentication bypass in protected environments', () => {
    const result = envSchema.safeParse({
      ...entraEnvironment,
      AUTH_BYPASS: 'true',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'AUTH_BYPASS')).toBe(true);
    }
  });

  it('applies the one-hour SAS and clock-skew defaults', () => {
    const result = envSchema.safeParse(baseEnvironment);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AZURE_STORAGE_CONTAINER).toBe('audio');
      expect(result.data.AUDIO_SAS_EXPIRY_MINUTES).toBe(60);
      expect(result.data.AUDIO_SAS_CLOCK_SKEW_MINUTES).toBe(5);
    }
  });
});
