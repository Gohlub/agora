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
 * Check if a transaction has been accepted into the mempool
 * 
 * Polls the gRPC endpoint with retries to verify transaction acceptance.
 * Useful for verifying that a transaction was successfully broadcast before
 * starting to poll for block inclusion.
 * 
 * @param grpcClient - The gRPC client instance
 * @param txId - Base58-encoded transaction ID
 * @param options - Optional configuration
 * @returns Promise that resolves to true if accepted, throws error if not accepted after max attempts
 * 
 * @example
 * ```typescript
 * const accepted = await checkTransactionAcceptance(grpcClient, txId);
 * if (accepted) {
 *   // Start polling for block inclusion
 * }
 * ```
 */
export async function checkTransactionAcceptance(
  grpcClient: GrpcClient,
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
 * Poll for transaction inclusion in a block
 * 
 * Continuously checks if a transaction has been included by calling a check function.
 * Stops polling when the check returns true or when max duration is reached.
 * 
 * @param checkFn - Function that returns true if transaction is included, false otherwise
 * @param options - Optional configuration
 * @returns Promise that resolves to true if included, false if timeout reached
 * 
 * @example
 * ```typescript
 * // Poll for note existence (funding transaction)
 * const isIncluded = await pollForTransactionInclusion(
 *   async () => {
 *     const balance = await grpcClient.getBalanceByFirstName(lockRootHash);
 *     return balance?.notes && balance.notes.length > 0;
 *   },
 *   {
 *     onIncluded: () => console.log('Transaction included!'),
 *     onPoll: (attempt) => console.log(`Poll attempt ${attempt}`)
 *   }
 * );
 * 
 * // Poll for transaction confirmation (multisig transaction)
 * const isIncluded = await pollForTransactionInclusion(
 *   async () => {
 *     // Check if transaction inputs are spent (transaction confirmed)
 *     return await checkTransactionConfirmed(grpcClient, txId);
 *   }
 * );
 * ```
 */
export async function pollForTransactionInclusion(
  checkFn: () => Promise<boolean>,
  options: TransactionInclusionPollOptions = {}
): Promise<boolean> {
  const {
    intervalMs = INCLUSION_POLL_INTERVAL_MS,
    maxDurationMs = INCLUSION_POLL_MAX_DURATION_MS,
    timeoutErrorMessage = 'Transaction was not included within the expected time window.',
    onPoll,
    onIncluded,
  } = options;

  const startTime = Date.now();
  let attempt = 0;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      const elapsed = Date.now() - startTime;

      // Check if we've exceeded max duration
      if (elapsed >= maxDurationMs) {
        reject(new Error(timeoutErrorMessage));
        return;
      }

      attempt++;
      onPoll?.(attempt);

      try {
        const isIncluded = await checkFn();
        if (isIncluded) {
          onIncluded?.();
          resolve(true);
          return;
        }
      } catch (e) {
        console.warn(`Transaction inclusion poll attempt ${attempt} failed:`, e);
        // Continue polling on error (don't reject immediately)
      }

      // Schedule next poll
      setTimeout(poll, intervalMs);
    };

    // Start polling
    poll();
  });
}

/**
 * Poll for transaction inclusion with manual cleanup control
 * 
 * Similar to pollForTransactionInclusion but returns a cleanup function
 * that can be called to stop polling early. Useful when you need to
 * stop polling from outside the function (e.g., component unmount).
 * 
 * @param checkFn - Function that returns true if transaction is included, false otherwise
 * @param options - Optional configuration
 * @returns Object with promise and cleanup function
 * 
 * @example
 * ```typescript
 * const { promise, cleanup } = pollForTransactionInclusionWithCleanup(
 *   async () => {
 *     const balance = await grpcClient.getBalanceByFirstName(lockRootHash);
 *     return balance?.notes && balance.notes.length > 0;
 *   }
 * );
 * 
 * // Later, if component unmounts or user cancels:
 * cleanup();
 * 
 * try {
 *   const isIncluded = await promise;
 *   // Handle inclusion
 * } catch (e) {
 *   // Handle timeout or cancellation
 * }
 * ```
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

