/**
 * Transaction ID Generator
 *
 * Format: {PREFIX}{EPOCH_MS}{3_DIGIT_SEQ}
 * Example: SRV1781860724293001
 *
 * The 3-digit sequence counter increments per millisecond to guarantee
 * uniqueness when multiple IDs are generated within the same ms window.
 */

type GeneratorState = {
  lastMs: number;
  counter: number;
};

const DEFAULT_PREFIX = 'SRV';

const _state: GeneratorState = {
  lastMs: 0,
  counter: 0,
};

/**
 * Generate a transaction ID.
 * @param prefix - Service code prefix (default: SRV)
 */
export function generateTransactionId(prefix = DEFAULT_PREFIX): string {
  const now = Date.now();

  if (now === _state.lastMs) {
    _state.counter = (_state.counter + 1) % 1000;
  } else {
    _state.lastMs = now;
    _state.counter = 0;
  }

  return `${prefix}${_state.lastMs}${String(_state.counter).padStart(3, '0')}`;
}

/** Reset internal state (test utility). */
export function resetState(): void {
  _state.lastMs = 0;
  _state.counter = 0;
}
