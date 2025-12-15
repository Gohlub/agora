import type { GrpcClient } from '@nockbox/iris-wasm/iris_wasm.js';

/**
 * Configuration constants for transaction acceptance checking
 */
export const ACCEPTANCE_CHECK_INTERVAL_MS = 1000; // 1 second between checks
export const ACCEPTANCE_CHECK_MAX_ATTEMPTS = 10; // 10 attempts = 10 seconds max

/**
 * Configuration constants for transaction inclusion polling
 * Based on ~10min average block time + buffer for variance
 */
export const INCLUSION_POLL_INTERVAL_MS = 10000; // 10 seconds between polls
export const INCLUSION_POLL_MAX_DURATION_MS = 20 * 60 * 1000; // 20 minutes total

export interface TransactionAcceptanceOptions {
  /** Interval between checks in milliseconds (default: 1000ms) */
  intervalMs?: number;
  /** Maximum number of attempts (default: 10) */
  maxAttempts?: number;
  /** Custom error message if transaction is not accepted */
  errorMessage?: string;
}

export interface TransactionInclusionPollOptions {
  /** Interval between polls in milliseconds (default: 10000ms / 10 seconds) */
  intervalMs?: number;
  /** Maximum duration to poll in milliseconds (default: 20 minutes) */
  maxDurationMs?: number;
  /** Custom error message if transaction is not included after max duration */
  timeoutErrorMessage?: string;
  /** Callback function called on each poll attempt (for logging/progress) */
  onPoll?: (attempt: number) => void;
  /** Callback function called when transaction is included */
  onIncluded?: () => void;
}

/**
 * Check if a transaction has been accepted into the mempool.
 * Polls with retries to verify transaction acceptance before polling for block inclusion.
 */
export async function checkTransactionAcceptance(
  getGrpcClient: () => Promise<GrpcClient>,
  txId: string,
  options: TransactionAcceptanceOptions = {}
): Promise<boolean> {
  const {
    intervalMs = ACCEPTANCE_CHECK_INTERVAL_MS,
    maxAttempts = ACCEPTANCE_CHECK_MAX_ATTEMPTS,
    errorMessage = 'Transaction was not accepted into mempool. It may have been rejected or there may be a network issue.',
  } = options;

  let accepted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const grpcClient = await getGrpcClient();
      accepted = await grpcClient.transactionAccepted(txId);
      if (accepted) {
        return true;
      }
      // Wait before next check (except on last attempt)
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    } catch (e) {
      console.warn(`Transaction acceptance check attempt ${attempt + 1}/${maxAttempts} failed:`, e);
      // Continue trying unless this is the last attempt
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  }

  // If we get here, transaction was not accepted
  throw new Error(errorMessage);
}

/**
 * Poll for transaction inclusion with cleanup control.
 * Returns a cleanup function to stop polling early (e.g., on component unmount).
 */
export function pollForTransactionInclusionWithCleanup(
  checkFn: () => Promise<boolean>,
  options: TransactionInclusionPollOptions = {}
): { promise: Promise<boolean>; cleanup: () => void } {
  const {
    intervalMs = INCLUSION_POLL_INTERVAL_MS,
    maxDurationMs = INCLUSION_POLL_MAX_DURATION_MS,
    timeoutErrorMessage = 'Transaction was not included within the expected time window.',
    onPoll,
    onIncluded,
  } = options;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    isCleanedUp = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const promise = new Promise<boolean>((resolve, reject) => {
    const startTime = Date.now();
    let attempt = 0;

    const poll = async () => {
      if (isCleanedUp) {
        reject(new Error('Polling was cancelled.'));
        return;
      }

      const elapsed = Date.now() - startTime;

      // Check if we've exceeded max duration
      if (elapsed >= maxDurationMs) {
        cleanup();
        reject(new Error(timeoutErrorMessage));
        return;
      }

      attempt++;
      onPoll?.(attempt);

      try {
        const isIncluded = await checkFn();
        if (isIncluded) {
          cleanup();
          onIncluded?.();
          resolve(true);
          return;
        }
      } catch (e) {
        console.warn(`Transaction inclusion poll attempt ${attempt} failed:`, e);
        // Continue polling on error (don't reject immediately)
      }

      // Schedule next poll
      if (!isCleanedUp) {
        timeoutId = setTimeout(poll, intervalMs);
      }
    };

    // Start polling
    poll();
  });

  return { promise, cleanup };
}

