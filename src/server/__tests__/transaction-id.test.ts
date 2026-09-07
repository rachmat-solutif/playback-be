import { describe, expect, it, beforeEach, vi } from 'vitest';
import { generateTransactionId, resetState } from '../lib/transaction-id.js';

describe('Transaction ID Generator', () => {
  beforeEach(() => {
    resetState();
  });
  it('produces correct format: SRV + epoch_ms + 3-digit seq', () => {
    const id = generateTransactionId();
    expect(id).toMatch(/^SRV\d{13}\d{3}$/);
    expect(id.length).toBe(19); // SRV(3) + epoch_ms(13) + seq(3)
  });

  it('generates unique IDs within the same millisecond', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generateTransactionId());
    }
    expect(ids.size).toBe(50);
  });

  it('generates different IDs across calls', () => {
    const id1 = generateTransactionId();
    const id2 = generateTransactionId();
    expect(id1).not.toBe(id2);
  });

  it('uses SRV prefix by default', () => {
    const id = generateTransactionId();
    expect(id.startsWith('SRV')).toBe(true);
  });

  it('uses custom prefix when provided', () => {
    const id = generateTransactionId('API');
    expect(id.startsWith('API')).toBe(true);
    expect(id).toMatch(/^API\d{13}\d{3}$/);
  });

  it('sequence counter wraps after 1000 within same ms', () => {
    const fakeNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
    resetState();

    // 3-digit counter has 1000 slots (0-999); 2001 calls verify wrap
    const ids = [];
    for (let i = 0; i < 2001; i++) {
      ids.push(generateTransactionId());
    }
    // 1000 unique IDs per ms; first 1000 fill all slots, next 1001 cycle through
    expect(new Set(ids).size).toBe(1000);
    // All share the same timestamp
    const timestamps = new Set(ids.map((id) => id.slice(3, 16)));
    expect(timestamps.size).toBe(1);
    // Verify counter reached max and wrapped (last ID has counter 0)
    const lastCounter = ids[ids.length - 1].slice(-3);
    expect(lastCounter).toBe('000');
    vi.restoreAllMocks();
  });
});
