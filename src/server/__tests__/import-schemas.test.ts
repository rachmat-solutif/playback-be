import { describe, expect, it } from 'vitest';
import { audioSchema } from '../routes/import-schemas.js';

 describe('audio import schema', () => {
  it('accepts an existing Azure blob reference', () => {
    const result = audioSchema.safeParse({
      blob_name: 'imports/existing-call.wav',
      format: 'wav',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an HTTPS remote audio URL', () => {
    const result = audioSchema.safeParse({
      remote_url: 'https://8.8.8.8/call.mp3',
      format: 'mp3',
    });
    expect(result.success).toBe(true);
  });

  it('rejects multiple audio sources', () => {
    const result = audioSchema.safeParse({
      blob_name: 'imports/call.wav',
      remote_url: 'https://8.8.8.8/call.wav',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsafe blob names', () => {
    const result = audioSchema.safeParse({ blob_name: '../private.wav' });
    expect(result.success).toBe(false);
  });

  it('rejects non-HTTPS remote URLs and embedded credentials', () => {
    expect(audioSchema.safeParse({ remote_url: 'http://8.8.8.8/call.wav' }).success).toBe(false);
    expect(
      audioSchema.safeParse({ remote_url: 'https://user:password@8.8.8.8/call.wav' }).success,
    ).toBe(false);
  });

  it('retains local path support for filesystem mode', () => {
    const result = audioSchema.safeParse({ url: '/audio/call.wav', format: 'wav' });
    expect(result.success).toBe(true);
  });
});
